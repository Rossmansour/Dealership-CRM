// postings.js -- What each piece of dealership work posts to the books.
//
// Called inside the same transaction as the work itself, so the books and
// the work never disagree: if the posting fails, so does the work.
//
//   Car stocked in     Dr vehicle inventory      Cr floor plan (new) / vehicle purchases (used)
//                                                 / trade-in clearing (a trade) / vendors (recon work)
//   RO closed          Dr service receivable / warranty receivable / the car (internal recon)
//                      Cr labor, parts, shop supplies, sales tax; and the cost:
//                      Dr cost of labor & parts  Cr accrued payroll & parts inventory
//   Counter ticket     Dr service & parts receivable   Cr parts sales, sales tax; cost the same way
//   Parts received     Dr parts inventory         Cr vendors
//   Parts count fixed  Dr/Cr parts inventory      Cr/Dr parts adjustments
//   Deal booked        see dealLines below
//   Wholesale booked   Dr wholesale receivable    Cr wholesale sales; Dr cost  Cr inventory
//   Chargeback         Dr F&I chargebacks         Cr F&I products payable

const store = require('./db');
const acct = require('./accounting');
const { n, round2, BooksError } = acct;

const carType = car => (car && car.stockType === 'new' ? 'new' : 'used');
const stockControl = car => String(car.stockNumber || (car.vin ? car.vin.slice(-8) : car.id.slice(0, 8)));
const carName = car => [car.year, car.make, car.model].filter(Boolean).join(' ');
const purchaseOffset = car => (carType(car) === 'new' ? 'floor_plan' : 'vehicle_ap');
const SOLD = ['delivered', 'closed', 'finalized'];

// ---------- Vehicle inventory ----------

// A car's cost went up (or down) by amount, and what it's owed to.
async function carCost(q, who, car, amount, { offsetKey, offsetControl, offsetName, memo, date = null } = {}) {
  amount = round2(amount);
  if (!amount) return null;
  return acct.postEntry(q, who, {
    journal: 'inventory', date, memo: memo || `${carName(car)} -- cost`, sourceType: 'car', sourceId: car.id,
    lines: [
      { key: `${carType(car)}_inventory`, amount, control: stockControl(car), controlName: carName(car) },
      { key: offsetKey || purchaseOffset(car), amount: -amount, control: offsetControl ?? stockControl(car), controlName: offsetName ?? carName(car) }
    ]
  });
}

// A car came into stock. how: 'purchase' (bought or ordered: new cars are
// floor-planned, used cars owed to the seller), 'trade' (taken in on a
// deal: owed to the deal through trade-in clearing).
async function carAdded(q, who, car, how = 'purchase', { dealNumber, sellerName } = {}) {
  if (!n(car.cost) || car.status === 'sold') return null;
  if (how === 'trade') {
    return carCost(q, who, car, car.cost, { offsetKey: 'trade_clearing', offsetControl: `D-${dealNumber}`, offsetName: carName(car), memo: `Trade-in ${carName(car)} stocked in from D-${dealNumber}` });
  }
  return carCost(q, who, car, car.cost, {
    offsetName: sellerName || carName(car),
    memo: `${carType(car) === 'new' ? 'New' : 'Used'} ${carName(car)} stocked in (#${stockControl(car)})${carType(car) === 'new' ? ' -- floor planned' : ''}`
  });
}

// Moves whatever the books hold for a car from one account/control to another.
async function moveInventory(q, who, car, fromKey, fromControl, toKey, toControl, memo) {
  const bal = await acct.controlBalance(q, who.dealershipId, fromKey, fromControl);
  if (!bal) return null;
  return acct.postEntry(q, who, {
    journal: 'inventory', memo, sourceType: 'car', sourceId: car.id,
    lines: [
      { key: fromKey, amount: -bal, control: fromControl, controlName: carName(car) },
      { key: toKey, amount: bal, control: toControl, controlName: carName(car) }
    ]
  });
}

// A car was edited by hand: new/used or stock # changed, or its cost.
async function carEdited(q, who, before, after) {
  if (before.status === 'sold' && after.status === 'sold') return;
  const fromKey = `${carType(before)}_inventory`, toKey = `${carType(after)}_inventory`;
  const fromCtl = stockControl(before), toCtl = stockControl(after);
  if (fromKey !== toKey || fromCtl !== toCtl) {
    await moveInventory(q, who, after, fromKey, fromCtl, toKey, toCtl,
      `${carName(after)}: ${fromKey !== toKey ? `now ${carType(after)}` : ''}${fromKey !== toKey && fromCtl !== toCtl ? ', ' : ''}${fromCtl !== toCtl ? `stock # ${fromCtl} → ${toCtl}` : ''}`);
    // The floor plan follows a new car's stock number too.
    if (fromCtl !== toCtl) await moveInventory(q, who, after, 'floor_plan', fromCtl, 'floor_plan', toCtl, `Floor plan: stock # ${fromCtl} → ${toCtl}`);
  }
  const delta = round2(n(after.cost) - n(before.cost));
  if (delta && after.status !== 'sold') await carCost(q, who, after, delta, { memo: `${carName(after)}: cost changed by hand ${n(before.cost).toFixed(2)} → ${n(after.cost).toFixed(2)}` });
}

// A car taken out of inventory without being sold (deleted).
async function carRemoved(q, who, car) {
  if (car.status === 'sold') return null;
  const bal = await acct.controlBalance(q, who.dealershipId, `${carType(car)}_inventory`, stockControl(car));
  if (!bal) return null;
  return carCost(q, who, car, -bal, { memo: `${carName(car)} removed from inventory` });
}

// ---------- Service and parts ----------

async function roClosed(q, who, ro, car) {
  const t = ro.closedTotals || {};
  const ctl = `RO-${ro.roNumber}`;
  const name = ro.customerName || (ro.carId ? `Internal -- ${car ? carName(car) : 'inventory car'}` : 'Internal');
  const c = t.customer || {}, w = t.warranty || {}, i = t.internal || {};
  // Internal work on a car in stock is recon: it goes on the car.
  const onCar = car && car.status !== 'sold';
  const lines = [
    { key: 'service_ar', amount: n(t.customerTotal), control: ctl, controlName: name },
    { key: 'warranty_ar', amount: n(t.warrantyTotal), control: ctl, controlName: name },
    onCar
      ? { key: `${carType(car)}_inventory`, amount: n(t.internalTotal), control: stockControl(car), controlName: carName(car), memo: `Recon ${ctl}` }
      : { key: 'policy_service', amount: n(t.internalTotal), control: ctl, memo: 'Internal work' },
    { key: 'labor_customer', amount: -n(c.labor) }, { key: 'labor_warranty', amount: -n(w.labor) }, { key: 'labor_internal', amount: -n(i.labor) },
    { key: 'parts_customer', amount: -n(c.parts) }, { key: 'parts_warranty', amount: -n(w.parts) }, { key: 'parts_internal', amount: -n(i.parts) },
    { key: 'shop_supplies', amount: -n(t.shopSupplies) }, { key: 'sales_tax', amount: -n(t.tax) },
    // What it cost: the technicians' pay, and the parts off the shelf.
    { key: 'cos_labor_customer', amount: n(c.laborCost) }, { key: 'cos_labor_warranty', amount: n(w.laborCost) }, { key: 'cos_labor_internal', amount: n(i.laborCost) },
    { key: 'payroll_ap', amount: -(n(c.laborCost) + n(w.laborCost) + n(i.laborCost)), memo: `Technician pay ${ctl}` },
    { key: 'cos_parts_customer', amount: n(c.partsCost) }, { key: 'cos_parts_warranty', amount: n(w.partsCost) }, { key: 'cos_parts_internal', amount: n(i.partsCost) },
    { key: 'parts_inventory', amount: -(n(c.partsCost) + n(w.partsCost) + n(i.partsCost)) }
  ];
  return acct.postEntry(q, who, { journal: 'service', date: ro.closedAt, memo: `${ctl} closed -- ${name}`, sourceType: 'repair_order', sourceId: ro.id, lines: settle(lines) });
}

async function ticketClosed(q, who, t) {
  const tt = t.closedTotals || {};
  const ctl = `P-${t.ticketNumber}`;
  const kind = ['retail', 'wholesale', 'internal'].includes(t.saleType) ? t.saleType : 'retail';
  const saleKey = { retail: 'parts_counter', wholesale: 'parts_wholesale', internal: 'parts_internal' }[kind];
  const lines = [
    kind === 'internal'
      ? { key: 'policy_service', amount: n(tt.total), control: ctl, memo: 'Parts used in-house' }
      : { key: 'service_ar', amount: n(tt.total), control: ctl, controlName: t.customerName || '' },
    { key: saleKey, amount: -n(tt.sale) }, { key: 'sales_tax', amount: -n(tt.tax) },
    { key: `cos_${saleKey}`, amount: n(tt.cost) },
    { key: 'parts_inventory', amount: -n(tt.cost) }
  ];
  return acct.postEntry(q, who, { journal: 'parts', date: t.closedAt, memo: `${ctl} closed -- ${t.customerName || kind}`, sourceType: 'parts_ticket', sourceId: t.id, lines: settle(lines) });
}

// Parts received from a vendor, or a count corrected.
async function partsMoved(q, who, part, qty, type, cost, ref) {
  const value = round2(qty * n(cost));
  if (!value) return null;
  if (type === 'receive') {
    const vendor = String(part.vendor || 'Parts vendor');
    return acct.postEntry(q, who, {
      journal: 'parts', memo: `Received ${qty} × ${part.number}${ref ? ` (invoice ${ref})` : ''}`, sourceType: 'part', sourceId: part.id,
      lines: [{ key: 'parts_inventory', amount: value }, { key: 'ap', amount: -value, control: vendor.toUpperCase().slice(0, 40), controlName: vendor, memo: ref ? `Invoice ${ref}` : '' }]
    });
  }
  if (type === 'adjust') {
    return acct.postEntry(q, who, {
      journal: 'parts', memo: `Count adjusted ${qty > 0 ? '+' : ''}${qty} × ${part.number}`, sourceType: 'part', sourceId: part.id,
      lines: [{ key: 'parts_inventory', amount: value }, { key: 'parts_adjust', amount: -value }]
    });
  }
  return null;
}

// Rounding can leave a cent between the pieces of a document; it goes to
// the first receivable line so the entry balances exactly.
function settle(lines) {
  const off = round2(lines.reduce((t, l) => t + round2(l.amount), 0));
  if (off && Math.abs(off) < 0.05) {
    const first = lines.find(l => round2(l.amount) > 0);
    if (first) first.amount = round2(first.amount - off);
  }
  return lines;
}

// ---------- Deals ----------

async function dealContext(q, dealershipId, deal) {
  const [car, lead, dealership, appraisals] = await Promise.all([
    deal.carId ? store.get(q, 'cars', dealershipId, deal.carId) : null,
    deal.leadId ? store.get(q, 'leads', dealershipId, deal.leadId) : null,
    store.getDealership(q, dealershipId),
    store.list(q, 'appraisals', dealershipId)
  ]);
  const settings = (dealership && dealership.settings) || {};
  const acq = appraisals.find(a => a.dealId === deal.id && a.status === 'acquired' && a.acquiredFor);
  const { rows } = await q.query('SELECT id::text AS id, name FROM users WHERE dealership_id = $1', [dealershipId]);
  return { car, lead, settings, acv: acq ? n(acq.acquiredFor) : null, staff: new Map(rows.map(r => [r.id, r.name])) };
}

// Every line a deal posts, with notes on anything the office should look at.
async function dealLines(q, dealershipId, deal) {
  const dashboard = require('./dashboard');
  const ctx = await dealContext(q, dealershipId, deal);
  const { car, lead, settings } = ctx;
  const warnings = [];
  if (!car) throw new BooksError('This deal has no car on it.');
  const t = carType(car);
  const D = `D-${deal.dealNumber}`;
  const customer = (lead && lead.name) || deal.buyerName || 'Customer';
  const lender = String(deal.lender || '').trim();
  const lease = deal.dealType === 'lease';
  const cash = deal.dealType === 'cash' || (!lease && !lender);
  const on = (key, amount, extra = {}) => ({ key, amount: round2(amount), control: D, controlName: customer, ...extra });
  const lines = [];
  // What the customer bought (credits).
  lines.push(on(`sale_${t}`, -n(deal.vehiclePrice), { memo: `${carName(car)} #${stockControl(car)}` }));
  lines.push(on(`fees_${t}`, -(n(deal.docFee) + n(deal.dealerFees)), { memo: 'Doc & dealer fees' }));
  for (const [key, field, label] of [['fi_service', 'servicePremium', 'Service contract'], ['fi_gap', 'gapPremium', 'GAP'], ['fi_maint', 'maintenancePremium', 'Maintenance'], ['fi_aftermarket', 'aftermarketAmount', 'Aftermarket'], ['fi_credit_ins', 'creditInsPremium', 'Credit insurance']]) {
    lines.push(on(key, -n(deal[field]), { memo: label }));
  }
  lines.push(on('sales_tax', -n(deal.salesTax), { control: '', controlName: '' }));
  lines.push(on('dmv_ap', -(n(deal.titleFee) + n(deal.registrationFee) + n(deal.licenseFee) + n(deal.otherGovFees) + (lease ? n(deal.acquisitionFee) : 0)), { memo: lease ? 'Government fees & acquisition fee' : 'Title, registration & license' }));
  lines.push(on('payoff_ap', -(n(deal.hasTrade ? deal.tradeInPayoff : 0) + n(deal.priorLeaseBalance)), { memo: 'Payoff owed on the trade' }));
  // What paid for it (debits).
  const allowance = deal.hasTrade ? n(deal.tradeInValue) : 0;
  if (allowance) {
    // The trade went into stock at its ACV through trade-in clearing; the
    // rest of the allowance is over-allowance, a cost of this sale.
    const stocked = -(await acct.controlBalance(q, dealershipId, 'trade_clearing', D));
    if (stocked > 0) {
      lines.push(on('trade_clearing', stocked, { memo: 'Trade-in at ACV' }));
      lines.push(on(`cos_adj_${t}`, allowance - stocked, { memo: allowance >= stocked ? 'Trade over-allowance' : 'Trade under-allowance' }));
    } else {
      lines.push(on('trade_clearing', allowance, { memo: 'Trade-in -- not stocked in yet' }));
      warnings.push("The trade isn't in inventory yet, so its whole allowance waits in trade-in clearing until it is.");
    }
  }
  lines.push(on('factory_ar', n(deal.rebate), { memo: 'Customer rebate' }));
  // The customer's part: deposits taken first, then what's still owed.
  const customerPart = lease ? n(deal.dueAtSigning) : n(deal.downPayment);
  const deposits = -(await acct.controlBalance(q, dealershipId, 'deposits', D));
  if (deposits > 0) lines.push(on('deposits', deposits, { memo: 'Deposit applied' }));
  lines.push(on('vehicle_ar', customerPart - Math.max(0, deposits), { memo: lease ? 'Due at signing' : 'Down payment' }));
  // The lender pays the rest -- or the customer, on a cash deal.
  const rest = -round2(lines.reduce((s, l) => s + l.amount, 0));
  if (cash) lines.push(on('vehicle_ar', rest, { memo: 'Balance due from customer' }));
  else lines.push(on('cit', rest, { controlName: `${lender || 'Lender'} -- ${customer}`, memo: lease ? `Lease -- ${lender}` : `Contract -- ${lender}` }));
  // The car's cost leaves inventory.
  const invKey = `${t}_inventory`;
  const onBooks = await acct.controlBalance(q, dealershipId, invKey, stockControl(car));
  if (round2(onBooks) !== round2(car.cost)) warnings.push(`The books hold ${round2(onBooks).toFixed(2)} for stock #${stockControl(car)} but the car's cost is ${n(car.cost).toFixed(2)}. Posting the car's cost; check the inventory schedule.`);
  lines.push(on(`cos_${t}`, n(car.cost), { control: stockControl(car), controlName: carName(car) }));
  lines.push(on(invKey, -n(car.cost), { control: stockControl(car), controlName: carName(car) }));
  // Store-side money: F&I cost, reserve, incentives, we-owes, deal costs.
  lines.push(on('cos_fi', n(deal.fiProductCost), { memo: 'F&I product cost' }), on('fi_ap', -n(deal.fiProductCost), { memo: 'Owed to product companies' }));
  if (n(deal.reserve)) {
    lines.push(on('reserve_ar', n(deal.reserve), { control: (lender || 'LENDER').toUpperCase().slice(0, 40), controlName: lender || 'Lender', memo: `Reserve ${D}` }));
    lines.push(on('fi_reserve', -n(deal.reserve)));
  }
  lines.push(on('factory_ar', n(deal.incentives), { memo: 'Factory incentives' }), on(`incentives_${t}`, -n(deal.incentives)));
  const weOwe = (deal.weOwe || []).reduce((s, w) => s + n(w && w.cost), 0);
  lines.push(on(`cos_adj_${t}`, weOwe, { memo: 'We-owe cost' }), on('we_owe', -weOwe, { memo: 'We-owe' }));
  lines.push(on(`cos_adj_${t}`, n(deal.adjustmentsTotal), { memo: 'Deal costs (recap adjustments)' }), on('deal_accrual', -n(deal.adjustmentsTotal)));
  // Commissions earned on the deal.
  const gross = dashboard.dealGross(deal, car, settings, ctx.acv);
  for (const c of dashboard.commissionsFor(deal, gross, settings)) {
    if (!n(c.amount)) continue;
    const who = ctx.staff.get(String(c.userId)) || 'Employee';
    lines.push(on(c.role === 'fiManager' ? 'comm_fi' : `comm_${t}`, c.amount, { memo: `${c.label}: ${who}` }));
    lines.push({ key: 'commissions_ap', amount: -round2(c.amount), control: who.toUpperCase().slice(0, 40), controlName: who, memo: `${c.label} ${D}` });
  }
  // A new car's floor plan is paid off when it sells.
  const floor = -(await acct.controlBalance(q, dealershipId, 'floor_plan', stockControl(car)));
  if (floor > 0) {
    lines.push({ key: 'floor_plan', amount: floor, control: stockControl(car), controlName: carName(car), memo: 'Floor plan payoff' });
    lines.push({ key: 'cash', amount: -floor, memo: `Floor plan payoff #${stockControl(car)}` });
  }
  if (lease) warnings.push('Lease deal: check the amount due from the leasing company against their funding notice.');
  if (!cash && !lender) warnings.push('No lender on the deal.');
  return {
    lines: settle(lines.filter(l => round2(l.amount))), warnings, customer,
    date: acct.localDay(deal.deliveredAt || deal.finalizedAt || null, (await acct.settingsOf(q, dealershipId)).tz),
    memo: `${D} ${customer} -- ${t === 'new' ? 'New' : 'Used'} ${carName(car)} #${stockControl(car)}${lender && !cash ? ` -- ${lender}` : cash ? ' -- cash' : ''}`
  };
}
const debitTotal = lines => round2(lines.reduce((s, l) => s + Math.max(0, round2(l.amount)), 0));

async function bookDeal(q, who, dealId) {
  const deal = await store.get(q, 'deals', who.dealershipId, dealId, { forUpdate: true });
  if (!deal) throw new BooksError('Deal not found.', 404);
  if (!SOLD.includes(deal.status)) throw new BooksError('Only delivered deals can be booked.');
  if (deal.booked) throw new BooksError(`D-${deal.dealNumber} is already booked.`);
  const built = await dealLines(q, who.dealershipId, deal);
  const entry = await acct.postEntry(q, who, { journal: 'sales', date: built.date, memo: built.memo, sourceType: 'deal', sourceId: deal.id, lines: built.lines });
  const booked = { entryId: entry.id, entryNumber: entry.entryNumber, at: new Date().toISOString(), by: who.user ? { id: who.user.id, name: who.user.name } : { id: null, name: 'Automatic' }, total: debitTotal(built.lines) };
  await store.save(q, 'deals', who.dealershipId, deal.id, { ...deal, booked });
  return { entry, booked, warnings: built.warnings };
}

async function unbookDeal(q, who, dealId, reason) {
  const deal = await store.get(q, 'deals', who.dealershipId, dealId, { forUpdate: true });
  if (!deal) throw new BooksError('Deal not found.', 404);
  if (!deal.booked) throw new BooksError(`D-${deal.dealNumber} isn't booked.`);
  const rev = await acct.reverseEntry(q, who, deal.booked.entryId, `Unbooked D-${deal.dealNumber}${reason ? `: ${reason}` : ''}`);
  const { booked, ...rest } = deal;
  await store.save(q, 'deals', who.dealershipId, deal.id, { ...rest, unbookedHistory: [...(deal.unbookedHistory || []), { ...booked, reversedBy: rev.id, at: new Date().toISOString(), reason: reason || '' }] });
  return rev;
}

// A car sold to another dealer or at auction.
async function bookWholesale(q, who, carId, { price, buyer } = {}) {
  const car = await store.get(q, 'cars', who.dealershipId, carId, { forUpdate: true });
  if (!car) throw new BooksError('Car not found.', 404);
  if (car.wholesaleBooked) throw new BooksError(`#${stockControl(car)} is already booked.`);
  const amount = price !== undefined && price !== '' ? acct.money(price) : n(car.wholesalePrice);
  if (!(amount > 0)) throw new BooksError('Enter what it sold for.');
  const buyerName = String(buyer || car.wholesaleBuyer || 'Wholesale buyer').slice(0, 120);
  const ctl = stockControl(car);
  const entry = await acct.postEntry(q, who, {
    journal: 'sales', date: car.dateSold, memo: `Wholesale #${ctl} ${carName(car)} to ${buyerName}`, sourceType: 'wholesale', sourceId: car.id,
    lines: [
      { key: 'wholesale_ar', amount, control: ctl, controlName: buyerName },
      { key: 'sale_wholesale', amount: -amount, control: ctl },
      { key: 'cos_wholesale', amount: n(car.cost), control: ctl },
      { key: `${carType(car)}_inventory`, amount: -n(car.cost), control: ctl, controlName: carName(car) }
    ]
  });
  // A floor-planned car is paid off when it's wholesaled too.
  const floor = -(await acct.controlBalance(q, who.dealershipId, 'floor_plan', ctl));
  if (floor > 0) {
    await acct.postEntry(q, who, { journal: 'disbursements', date: car.dateSold, memo: `Floor plan payoff #${ctl}`, sourceType: 'wholesale', sourceId: car.id,
      lines: [{ key: 'floor_plan', amount: floor, control: ctl, controlName: carName(car) }, { key: 'cash', amount: -floor }] });
  }
  await store.save(q, 'cars', who.dealershipId, car.id, { ...car, wholesalePrice: amount, wholesaleBuyer: buyerName, wholesaleBooked: { entryId: entry.id, entryNumber: entry.entryNumber, at: new Date().toISOString() } });
  return entry;
}

// A cancelled F&I product: the store gives back what it earned on it.
async function postChargeback(q, who, dealId) {
  const deal = await store.get(q, 'deals', who.dealershipId, dealId, { forUpdate: true });
  if (!deal) throw new BooksError('Deal not found.', 404);
  const amount = Math.abs(n(deal.chargebackAmount));
  if (!amount) throw new BooksError('This deal has no chargeback.');
  if (deal.chargebackPosted && round2(deal.chargebackPosted.amount) === round2(amount)) throw new BooksError('This chargeback is already posted.');
  const already = deal.chargebackPosted ? n(deal.chargebackPosted.amount) : 0;
  const D = `D-${deal.dealNumber}`;
  const entry = await acct.postEntry(q, who, {
    journal: 'sales', date: deal.chargebackDate, memo: `Chargeback ${D}`, sourceType: 'chargeback', sourceId: deal.id,
    lines: [{ key: 'fi_chargebacks', amount: amount - already, control: D }, { key: 'fi_ap', amount: -(amount - already), control: D, memo: 'Chargeback owed' }]
  });
  await store.save(q, 'deals', who.dealershipId, deal.id, { ...deal, chargebackPosted: { amount, entryId: entry.id, at: new Date().toISOString() } });
  return entry;
}

module.exports = {
  carType, stockControl, carName, carCost, carAdded, carEdited, carRemoved,
  roClosed, ticketClosed, partsMoved, dealLines, bookDeal, unbookDeal, bookWholesale, postChargeback, debitTotal, SOLD
};
