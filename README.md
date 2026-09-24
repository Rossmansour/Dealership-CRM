# Dealership Inventory & CRM

A lightweight web app for managing a small used-car dealership's inventory and customer leads — built from firsthand experience running a car business.

![status](https://img.shields.io/badge/status-active-brightgreen)

## Why I built this

Running a small car dealership, I saw the same problems over and over:
- Inventory tracked across a spreadsheet, a notebook, and someone's memory
- No easy way to see which cars had been sitting too long (dead capital)
- Customer leads falling through the cracks because there was no shared system to track who wanted what

This project is a simplified version of the internal tool I wish I'd had: one place to track inventory *and* the customers interested in it, with a dashboard that surfaces the numbers that actually matter for running the business.

## Features

**Inventory Management**
- Add, edit, and delete vehicles (make, model, year, VIN, mileage, cost, price)
- Track status through the sales pipeline: `available → pending → sold`
- Search and filter by make, model, VIN, or status
- Automatic "days listed" tracking to flag cars sitting too long

**Sales Pipeline (home screen)**
- Opens on the **Sales Pipeline**: every open customer counted in one stage -- **Engaged → Visit → Proposal → Delivered**. Visit means a *Showroom Visit* was logged on their activity log; Proposal means a deal is being worked; Delivered means a delivered/closed deal, or marked Won. Lost customers aren't counted
- Under each stage: ⚠ customers needing follow-up (no contact in 3+ days) and 🔥 hot customers (activity in the last 24 hours)
- Filter by lead source and when the customer was added
- Tiles for Follow-Up Due, New Today, Keys Out, and Aged Inventory (60+ days); the left rail shows the same counts (plus open proposals) as badges on every screen
- **Every number is clickable**: it opens the customer or inventory list showing exactly those records, with a "Showing: ..." chip to clear the filter
- **Module sidebar** on the left: **CRM**, **Sales & F&I**, **Vehicle Management**, **Service**, and **Accounting** (placeholder for later). Hover to see names; the live counts sit below the modules. Adding a module is one entry in `MODULES` in `public/app.js`, its icons (`data-module`), and its panel
- The icon bar across the top shows the current module's screens (CRM: Pipeline, Customers, Board, Reports, AI Assistant), plus **New Customer** and **Quick Search** on every module (customers by name, phone, or email; deals by D-number; vehicles by stock #, VIN, or year/make/model). Press `/` to jump to the search box

**Appraisals ("book outs") -- Vehicle Management → Appraisals**
- Start one from **+ New Appraisal**, a customer's page (**Trade In**), or a deal's trade-in section (**Appraise this trade**, which brings the VIN, mileage, customer, and deal along)
- VIN decode fills year, make, model, trim, body, engine, drivetrain, transmission, and fuel; then mileage, colors, condition, and equipment (clickable options by group)
- **Recalls for this model**: every recall NHTSA has issued for the year/make/model, live. The decoded model name is matched to the names NHTSA files recalls under (e.g. "GLC-Class" → GLC300, GLC43 AMG), and the names checked are shown. These are model-wide -- some may already be repaired on the car. If NHTSA doesn't list the model, it says so instead of showing "no recalls"
- **Open recalls for this VIN** (what's still unrepaired on this exact car): a **Check this VIN on NHTSA** button opens nhtsa.gov's official VIN search. A built-in "Not available yet" slot fills in once a VIN-level recall source is connected
- Slots for **Market Comparables** (comparables, market day supply, suggested retail), **Factory Options**, **Kelley Blue Book and J.D. Power book-outs, Black Book, Manheim MMR / auctions, Carfax, AutoCheck,** and the **window sticker**. Each shows **"Not available yet"** until that source is licensed and connected in `providers.js` -- then it fills in automatically
- A summary across the top: **Source** (Trade-in, Street Purchase, Service Drive), **Category** (Retail, Wholesale, Decide Later), **Appraiser** (anyone on staff), and **values at a glance** -- every value next to the appraisal with the difference
- Section tabs (Vehicle, Market, Books, Auctions, Retail, Calculator, Offer...) jump to each part; every section collapses, or **Collapse all**
- Recon line items, and the **appraisal calculator**: asking price - recon - pack - other - profit = appraisal. Pick which one to **work out** (appraisal, profit, or asking price) and it's calculated from the others. Pack and default profit are store settings under Admin → Fee Defaults
- **Appraisal history**: every change to the appraisal amount, with who and when
- **Customer Offer**: the offer to the customer, with their name, phone, email, and salesperson. Creates the customer in the CRM (or uses the linked one) and notes the offer in their activity log
- **Retail Performance** from the store's own sales of similar cars (same make and model, within two years): how many sold, average days to sell, sale price and gross, and what's in stock now
- **Acquire → add to inventory** (sales managers and admins) creates the inventory car with everything filled in, linked both ways; or **Mark lost** with a reason (and reopen)
- A deal linked to an appraisal shows it in the trade-in section, with **Use offer as trade value**
- Printable appraisal worksheet; appraisals show up in Quick Search and as an **Open Appraisals** count in the sidebar. Every appraisal is kept, with its values, offer, and outcome

**VIN Decoder**
- Type or paste a VIN when adding a car and year, make, model, trim, body style, engine, transmission, drivetrain, fuel, and doors fill in automatically (or press **Decode VIN**)
- Same **Decode VIN** button on a deal's trade-in section fills the trade's year, make, and model, and the trade VIN is saved with the deal
- Catches typos before looking anything up (VINs never use I, O, or Q, and the 9th character is a check digit), and warns if the VIN is already in your inventory
- Uses NHTSA's free vPIC database (the US government's vehicle database) -- no account or API key needed. Results are remembered, so the same VIN isn't looked up twice
- Exterior and interior color are entered by hand (they aren't part of a VIN)

**Lead Tracking (mini CRM)**
- Log customer leads and link them to the car they're interested in
- Track lead status: `new → contacted → negotiating → won/lost`
- Notes field for context from calls/visits

**Deal Desking & Credit Applications**
- Click "+ Create Deal" on a lead + vehicle to generate a unique **Deal #** (e.g. D-1001), like a real dealership DMS
- Clicking a deal number opens the **Deal Workspace** with two sub-tabs:
  - **Desking**: vehicle price, rebate, an optional trade-in section (toggled on only when needed), down payment, tax, fees, APR, and loan term
  - **Credit Application**: a full RouteOne/DealerTrack-style application —
    - **Individual or Business** application type
    - Personal info (name, suffix, SSN, DOB, address, phone/email contact disclosures, license)
    - Housing & employment info (housing status, income, pay frequency, occupation)
    - **Previous address / previous employer** sections that appear only when the applicant has been at their current address or job less than 2 years
    - **"+ Add Co-Applicant"** button that adds a second, fully independent copy of the same application for a joint application
- Deal status (Working → Credit Submitted → Approved → Finalized) is tracked separately from credit approval status, since a deal can be fully desked before credit is ever submitted
- Generates a clean, printable proposal (Print → Save as PDF) itemizing every line of the deal
- Leads/prospects are typed as **Individual or Business** and track a **source** (walk-in, referral, website, Autotrader, etc.) so you can see which channels actually produce sales, not just leads

**Customer Page**
- Click any customer to open their full-screen page. New customers open straight to it
- **Header**: initials, name, 🔥 hot flag, status, customer number (C-10001...), snooze, phone, email, source, and the car they're interested in
- **Road to the Sale**: 7 steps (Greet, Needs, Vehicle, Demo Drive, Trade, Write-up, Delivery -- renamable under Admin → Fee Defaults). Greet, Vehicle, Trade, Write-up, and Delivery check themselves off from what's happened (check-in, a car picked, a trade appraised, a deal written, a sale); the others are clicked, with who and when
- **Left**: contact (edit in place), **wish list** (search inventory to add; one is the main car), AI summary, **best contact method** (with a suggestion from their history), and **details**: Sales 1, Sales 2, BDC 1, BDC 2, customer #, source, last contact
- **Activity**: one box for Note, Call, Text (sends a real text, with photos of their cars and an AI-suggested reply), Email (logged), **Task**, and **Appointment**. **Planned** shows open tasks and appointments (Done with what happened, Reschedule, Cancel; overdue in red); **History** is filterable by type and shows who logged each entry
- **Conversation** (texts as a thread), **Deals**, and **Value** (purchases and trades appraised)
- **Add**: New Deal (pick the car by search -- their cars first), Vehicles, Trade In, Credit App. **Actions**: Check In, Desk, Mark as Sold, Snooze, Dead (with a reason), Transfer (to another salesperson)
- Coming later, with their places already on the page: Video, Documents, Portal, and customer replies in the Conversation tab

**Tasks & Appointments**
- Each is for a customer, assigned to a staff member, with a due time. Completing one notes the outcome in the customer's history
- The Sales Pipeline home lists **my tasks due today** (overdue first, in red; managers can switch to everyone's), and **My Tasks Due** is a badge on the left rail

**Search instead of dropdowns**
- Everywhere you pick a car or a customer, you type: a car by stock #, any part of the VIN, year, make, model, trim, or color ("H-2020", "odyssey silver"); a customer by name, phone (any format), email, or customer #. Arrow keys and Enter work

**Deal Search & Filtering (Sales & F&I)**
- One search box matches across customer name (partial, first-name-only works -- "Ro" finds "Ross Mansour"), company name (for business leads), VIN, stock #, deal #, phone (formatting-independent -- "8872201" matches "555-887-2201"), and email
- Status filter and date range filter (native browser calendar pickers, From / To) work alongside the search box
- Deal status is now a 4-stage pipeline matching real dealership terminology: **Stored/Working \u2192 Delivered \u2192 Closed \u2192 Finalized**
- Vehicles now carry a **stock number** in addition to VIN, searchable from both Inventory and Deals
- **"+ Create Deal" opens a deal instantly** -- no picker, no required customer or vehicle up front. A deal number is generated right away, and the customer and vehicle can be assigned (or changed) anytime from the Desking tab, matching how a desk sometimes opens a deal before the paperwork is fully in hand

**Full-Page Deal View**
- Clicking any deal number now takes over the entire screen instead of opening a cramped modal -- there's a lot of ground to cover (pricing, lease math, F&I products, credit application) and it needed the room
- **&larr; Back to Deals** returns to the deals list; **Save** is always visible in the header regardless of which section you're looking at

**Deal Types: Retail & Lease**
- Every deal now has a **Deal Type** (Retail, Lease, or Cash), switchable from the deal page header
- **Retail** deals use standard loan amortization (unchanged from before)
- **Lease** deals use the real industry-standard lease formula: gross capitalized cost, cap cost reduction, net cap cost, residual value (based on MSRP and residual %), money factor, monthly depreciation + rent charge, and a mileage program -- verified by hand against a real dealer lease worksheet's math (residual and depreciation figures matched exactly; total payment differs only due to which fees a given lender chooses to capitalize vs. collect upfront, a configuration choice this simplified version doesn't model)
- Both types share the same pricing fields (price, rebate, trade, tax, term) so switching types doesn't throw away what's already been entered

**F&I Menu Products**
- Every deal (retail or lease) can now include GAP insurance, an extended service contract, a maintenance plan, aftermarket/accessories, dealer fees, and a license fee -- the actual products F&I managers sell, not just taxes and a doc fee

**Sales & F&I: Full Redesign**
- **Layout rebuilt from the ground up**: a two-column page (main content + a sticky Summary sidebar that stays visible while you scroll) replaces the old flat grid of many small boxes. Lease fields that used to be scattered across four separate cards now live in one consolidated panel with internal section dividers (Capitalization → Cap Cost Reduction → Residual → Payment), read top-to-bottom the way the numbers actually flow into each other
- **Three real deal types**: Retail (loan), Lease (full industry-standard lease math), and **Cash** (no financing at all -- shows a lump sum due instead of a monthly payment)
- **Trade-in now captures the actual vehicle**: year, make, model, and mileage alongside the value/payoff numbers, not just two bare dollar figures
- **"📑 Duplicate as New Scenario"**: clones a deal's current numbers into a brand-new Deal # so a rep can compare, say, a 36 vs. 48-month lease side by side without overwriting the original -- a lighter-weight version of the "Scenario #2" tabs found in full DMS platforms
- **Vehicle Management tie-in**: a car's status now updates automatically as its deal progresses -- assigning a deal moves an available car to "pending," and reaching Delivered/Closed/Finalized marks it "sold" and stamps the sale date, without anyone touching Inventory by hand
- **Service module groundwork**: every vehicle now carries an `openROs` field (empty until Service is built). The deal page already shows a "🔧 Service History" line for the assigned vehicle, so the moment Service exists, a sales manager sees open repair orders right from the deal screen -- no rework needed later
**Fee Formula Corrections (from real statutory research)**
- **California VLF**: now uses the actual statutory $200-wide valuation bracket midpoint (Rev. & Tax. Code §10753.2(b)), not the raw price -- and correctly always calculates at "year 1" value, since CA law resets the VLF depreciation clock to year one on every ownership transfer (§10753.2(c)), and a dealership sale *is* a transfer. Updated the CHP fee to the correct $34 (was using an outdated $29) and added the $3 Alternative Fuel/Technology surcharge that's easy to miss in simplified breakdowns.
- **Arizona VLT**: fixed a real conceptual error. The $2.80 vs $2.89 rate split is **not** "new car vs. used car" -- Arizona's own tax documentation is explicit that $2.80 applies during a vehicle's *first 12 months of registration* and $2.89 to every renewal after that, regardless of whether the car itself is new or used. Since a dealership sale is always a fresh registration for the buyer, every sale calculated here now correctly uses the first-year rate and full 60%-of-price assessed value -- a 10-year-old trade-in and a brand-new car get the same VLT rate, which is actually correct. Also added the statutory $10 minimum.
- Both corrections came from re-verifying against primary sources (CA DMV handbook citations, Arizona JLBC Tax Handbook) rather than trusting the first plausible-sounding explanation -- the "new vs. used" framing for AZ's rate is repeated on many informational sites but isn't what Arizona's own documentation actually says.

**Taxes & Fees: Admin-Configurable Reference Table (CA and AZ), Now With Full Coverage**
- **All 58 California counties and all 15 Arizona counties** now have real reference rates seeded (CDTFA rate table effective July 2026 for CA; ADOR-published rates for AZ's two largest counties, with the remaining 13 defaulting to state-only until their county add-ons are confirmed -- honestly labeled, not guessed) -- not a handful of major metros, the whole state
- **Tax configuration moved out of the sales workflow entirely.** Fee Defaults and Taxes & Fees used to live as buttons on the Deals tab, visible to anyone working a deal. They now live behind a separate **⚙️ Admin** entry point in the top nav, away from day-to-day sales screens. Role-based access (so only actual admins can reach it) is planned but not enforced yet -- this is a visibility/workflow separation, not a security boundary yet.
- Rebuilt from a hardcoded formula into how real DMS platforms actually do it: a **🗺️ Taxes & Fees** admin screen (behind ⚙️ Admin) where sales tax rates are set up once per State / County / City, with separate State/County/City percentages that sum to the combined rate -- visible and editable, not buried in code
- Falls back sensibly: an exact City match wins if one exists, otherwise a County-level default, otherwise the state's own default record
- "🧮 Auto-Calculate Tax & DMV Fees" (Deal Terms panel) looks up the customer's State/County/City (from their Credit Application address) against this table for the sales tax rate, and calculates License Fee / Registration Fee using real, verified state formulas:
  - **California**: taxes the *full* vehicle price -- trade-in does **not** reduce the taxable amount (Rev. & Tax. Code §6012). DMV fees: $74 base + $29 CHP + a value-tiered Transportation Improvement Fee, $28 title, and the Vehicle License Fee (0.65% of price) mapped onto License Fee.
  - **Arizona**: trade-in *does* reduce the taxable amount. DMV fees: a genuinely age-dependent Vehicle License Tax -- 60% of price in year one, depreciating 16.25%/year, taxed at 2.80% (new) or 2.89% (used) -- calculated from the vehicle's actual model year.
  - **Any other state** falls back to California's numbers, clearly labeled (`"CA (fallback -- TX not yet built)"`) rather than an unlabeled guess.
- **County auto-fills from ZIP** on the Credit Application (tab out of the Zip field), shown as its own editable field so a rep can correct it near a county boundary -- and a corrected county is honored as an override on the next calculation.
- All of this is verified against real published formulas and cross-checked by hand, including a case that matches a real dealership tax worksheet example exactly (7.25% state + 0.5% county + 1.5% city = 9.25% combined).

**Configurable Fee Defaults** (⚙️ Fee Defaults on the Deals tab): Doc Fee, Title Fee, Registration Fee, License Fee, Dealer Fees, Acquisition Fee, and default tax rate auto-fill on every new deal instead of being re-typed -- admin-only editing is planned but not enforced yet

## Module structure

This app is organized as a DMS (Dealer Management System) with a left sidebar, similar in spirit to platforms like Tekion or DriveCentric. Hover over the sidebar to see full labels; click a module to switch into it:

- **CRM** \u2014 Dashboard, Leads, AI Assistant
- **Sales & F&I** \u2014 Deals (desking + credit applications)
- **Vehicle Management System** \u2014 Inventory
- **Service** \u2014 not built yet; currently a placeholder describing what's planned (appointment scheduling, repair order tracking, technician assignment, parts lookup, and linking service customers back into the CRM)

Each module is being built out one at a time -- CRM and Sales & F&I are the most complete today, Vehicle Management (Inventory) covers the basics, and Service is next on the roadmap.

**Vehicle Photos & Picture Texts**
- Upload photos to any car in inventory (Edit Car → Photos section) -- shown as a thumbnail in the Inventory table
- From a lead's profile, the **Send Text** box lets you attach one of their interested vehicle's photos, sending a real **MMS** (picture text) instead of plain SMS
- Photos are stored in **Cloudinary** (see "Setting up photo storage" below), so they survive redeploys. Lists load small, automatically resized thumbnails; picture texts get a copy resized to stay under carriers' size limits
- JPEG, PNG, WebP, GIF, or HEIC; up to 8 photos of 5 MB each per upload. Deleting a photo -- or the whole car -- also deletes it from storage

**Real SMS (Twilio)**
- A dedicated "Send Text" flow on each lead's profile that sends an actual SMS via Twilio, not just a logged note -- the send and the log entry happen together automatically
- Separate on purpose from the manual "log a call I already made" form, since one triggers a real message and the other is just historical record-keeping

**Leads Pipeline (Kanban board)**
- Toggle between a table view and a drag-and-drop pipeline view of leads, styled after how DriveCentric and Tekion visualize lead flow
- Drag a card from one stage to another (New → Contacted → Negotiating → Won/Lost) to update that lead's status instantly

**AI Lead Snapshot**
- One click on a lead's profile generates a short AI summary of where things stand with that customer -- their situation, momentum, and one recommended next action -- instead of re-reading their whole communication history

**"Needs Follow-Up" Alerts**
- Any open lead (not won or lost, not snoozed, and with no follow-up task scheduled) that hasn't been contacted in 3+ days gets flagged automatically, both on the Dashboard (a running count) and as a badge on their card/row -- modeled after the "smart alerts for leads going cold" feature in real dealership CRMs

**AI Assistant**
- A chat panel that can answer questions about your actual data -- "how many cars have we sold?", "summarize my leads by status", "which deals still need credit approval?" -- or generate a free-form report on request
- An **"✨ AI Suggested Reply"** button on every lead's profile that drafts a short, context-aware follow-up message based on that customer's info, their interested vehicle, and their recent communication log -- one click adds it to the activity log once you're happy with it
- Runs on Google's Gemini API (free tier, no credit card required) -- see **Setting up the AI features** below
- SSNs are stripped out before anything is sent to the AI provider, even though the rest of a deal's info (income, employer, deal status) is included so the assistant can actually be useful

**Dark Mode**
- Toggle in the top nav, saved across visits (persists in the browser)
- Every screen -- including the printable proposal preview on-screen -- adapts; printing always forces light colors regardless of the current theme, since a dark-background printout wastes ink and looks broken on paper

**Dashboard**
- Current inventory value (sum of asking prices for available cars)
- Total profit realized on sold cars (price − cost)
- Average days on lot for sold vehicles
- Lead-to-sale conversion rate

## Product decisions worth calling out

- **Days-on-lot and conversion rate are the two numbers I'd check every morning** if I ran this dealership — they surface capital tied up in slow-moving inventory and whether the sales process is actually working, not just whether leads are coming in.
- **Leads link directly to a car**, not just a free-text note, so the dashboard can eventually answer "which cars generate leads that don't close" — a real prioritization question for what to stock next.
- **Status changes to "sold" auto-timestamp the sale**, so days-on-lot didn't require the user to remember to fill in a date manually — reducing a step is a small thing, but it's the difference between data that's actually accurate and data nobody bothers keeping current.
- **The deal calculator's tax math is a documented simplification**, not a hidden assumption: sales tax is calculated on price minus trade-in (the common rule in most states), applied before rebates (also the common rule, since manufacturer rebates are usually still taxed). Real tax treatment varies by state, and the proposal explicitly says so in its fine print rather than presenting a number as more authoritative than it is.
- **Deal status and credit status are tracked as two separate fields, not one.** A deal can be fully priced out ("Working") long before a credit application is ever submitted, and a credit app can come back "Approved" while the desking numbers are still being negotiated. Collapsing these into a single status would force an artificial ordering that doesn't match how deals actually move in a dealership.
- **The credit application saves independently from the desking numbers**, via its own API endpoint. A sales rep re-working the price shouldn't risk overwriting sensitive buyer information (or vice versa) just because both live on the same "deal" record.
- **The co-applicant reuses the exact same field template as the primary applicant**, generated from one function instead of two near-identical blocks of HTML. A joint application asks the same questions of both people, so the two forms can never drift out of sync with each other -- a bug fix or new field only has to happen once.
- **"Individual vs Business" lives on both the lead and the credit application, not just one place.** A lead's type is a CRM-level fact about who the prospect is; the application type is a financing decision that could reasonably differ (e.g., a sole proprietor buying under their own name instead of the business's). Tying them together would have been simpler but less accurate to how dealerships actually operate.
- **Heading text uses a separate color variable from background navy**, even though both start from the same navy color in light mode. A color chosen for a background (dark navy on white) doesn't automatically work as text on a dark surface -- reusing it directly made dashboard numbers nearly invisible in dark mode. Splitting them into `--navy` (backgrounds) and `--heading` (text) fixed the contrast without a special case for every dark-mode override.
- **The communication log is a list of timestamped entries, not a single notes field.** A single text box gets overwritten -- the fact that a customer was called on Monday and texted on Wednesday is lost the moment someone edits it. A real sales process needs the history, not just the latest state.
- **Deal search is one box, not seven.** A salesperson trying to find a deal doesn't know in advance whether they remember the customer's name, the VIN, or the phone number -- they just remember *something*. One search field that checks all of it is faster than making them pick the right field first.
- **A deal can exist with no customer and no vehicle attached.** Requiring both up front would force a fake placeholder lead or car just to get a deal number, which is worse than just letting `leadId`/`carId` be `null` until they're actually known. The same PUT endpoint that saves pricing changes also saves a later customer/vehicle assignment -- there's no separate "finish setting up this deal" flow to keep in sync.
- **Retail and lease share one set of pricing fields (price, rebate, trade, tax, term) instead of two.** The math genuinely differs between them, but the raw inputs mostly don't -- duplicating "vehicle price" into a retail-only and lease-only version would mean re-entering the same number if a deal type gets switched, for no real benefit.
- **F&I products are calculated once and used by both deal types**, rather than copy-pasted into the retail and lease calculators separately. A GAP premium behaves identically whether it's rolled into a loan or a lease's capitalized cost.
- **The lease panel is one card with internal sections, not four separate cards.** Capitalization, Cap Cost Reduction, Residual, and Payment are sequential -- each number depends on the one before it -- so splitting them into disconnected boxes actively worked against understanding the math, even though each individual box was tidy on its own.
- **Vehicle status sync lives in one shared function, called from both deal creation and every deal update**, instead of being duplicated in two places. The first version of this only handled updates and silently missed the very common case of a deal's *first* save -- caught by testing the actual creation flow, not just assuming the update path covered everything.
- **The "Duplicate as New Scenario" feature creates a real second deal, not a hidden alternate view of the same one.** A true side-by-side "Scenario 1 / Scenario 2" tab system (like full DMS platforms have) is a bigger feature than this pass covered -- this is the pragmatic version that gets 90% of the value (real comparison, nothing lost if one scenario is deleted) without the added complexity of multiple calculation states living inside a single deal record.
- **State-specific tax rules are a real behavioral switch, not just different numbers.** California and Arizona don't just have different tax *rates* -- they have opposite rules about whether a trade-in reduces the taxable amount at all. Treating this as "one formula with a state-dependent percentage" would have quietly produced wrong numbers for whichever state wasn't the one originally tested against.
- **Unsupported states fall back to California, and say so explicitly** (`"CA (fallback -- TX not yet built)"`) rather than silently returning a number that looks just as authoritative as a real calculation. A labeled placeholder is honest; an unlabeled guess is the kind of thing that erodes trust in every other number on the page once someone notices it's wrong.
- **DMV fee math is verified against the actual published formulas, not approximated from a percentage.** Arizona's Vehicle License Tax genuinely depends on the vehicle's age (60% of value, depreciating 16.25%/year) -- using the vehicle's real model year instead of a flat percentage was the difference between a number that's actually defensible and one that just looks plausible.
- **County is looked up from ZIP but stored as its own editable field, not hidden inside a rate calculation.** A ZIP-to-county mapping is inherently approximate near boundaries -- surfacing the county name (instead of silently picking a rate behind the scenes) means a sales rep can see and correct it, and a corrected county is honored as an override the next time fees are calculated.
- **Sales tax rates live in an editable reference table, not a hardcoded formula.** The first version of this calculated rates from a JavaScript object baked into the server -- accurate, but invisible and un-editable without touching code. Real DMS platforms treat this as data a dealer configures, not logic a developer owns. Switching to a State/County/City table (with the same verified numbers as its seed data) means a rate can be corrected or a new jurisdiction added by anyone, not just by shipping a code change.
- **Two separate "State" input fields silently disagreeing with each other was a real, fixable bug, not just bad UX.** The Desking tab had its own State box, disconnected from the address on the Credit Application tab. Auto-Calculate read the wrong one. The fix wasn't validation -- it was recognizing that a customer's address has exactly one state, so there should be exactly one input for it, kept in sync everywhere it's used.
- **Every AI call goes through one function, not scattered `fetch` calls.** Both the chat assistant and the suggested-reply feature call the same `callAI()` function in `server.js`. That's the only place that knows Gemini's specific request format -- swapping providers, or adding a fallback if one provider goes down, means changing one function instead of hunting through the codebase.
- **SSNs are redacted before anything reaches the AI provider, but income, employer, and deal status are not.** A blanket "redact everything sensitive" approach would make the assistant useless for its actual job (answering questions about deals). The redaction list is deliberately narrow: strip what could enable identity theft, keep what's needed to be useful.
- **Sending a real text is a separate action from logging one manually.** They look similar in the UI but do very different things -- one dials out to a real phone, the other just records history. Folding them into a single form would risk someone accidentally sending a real SMS while just trying to log a call they made from their cell phone.
- **"Needs Follow-Up" is computed from activity recency, not a manually-set flag.** A salesperson forgetting to flag a lead is exactly the failure mode this feature exists to catch -- so it can't depend on someone remembering to flag it themselves. It's derived automatically from whether anyone has logged contact in the last few days.
- **The Kanban board and the table view share the exact same underlying `leads` data and the same `openLeadProfile()` function.** Dragging a card just calls the same `PUT /api/leads/:id` endpoint the Edit Details form already uses -- there's no separate "pipeline" data model to keep in sync with the table.
- **Photo uploads only appear on the Edit Car screen, not Add Car.** A photo needs a car ID to attach to, and that ID doesn't exist until the car's first save. Rather than fake an ID or save a draft car, the flow just asks for the basics first, then photos on the follow-up edit -- an honest reflection of the actual dependency instead of hiding it.
- **Calculations happen server-side, not in the browser.** The frontend just displays whatever the API returns — it never recomputes the math itself. That way there's one source of truth, and if the formula ever needs to change (say, a state-specific tax rule), it only changes in one place.

## Tech stack

- **Backend:** Node.js + Express, REST API
- **Storage:** PostgreSQL (`db.js`). Every record belongs to a dealership, so one install can serve multiple stores.
- **Frontend:** Vanilla HTML/CSS/JavaScript, no framework

## Users, roles, and signing in

Everyone signs in with their own email and password. Every page and every piece of data requires being signed in, and each user only ever sees their own dealership's data.

| Role | Can do |
|---|---|
| **Admin** | Everything, including managing users, fee defaults, and tax rates |
| **Sales Manager** | Everything except users and settings: inventory, deletes, all leads and deals |
| **Salesperson** | Leads, deals, and credit apps; can't change inventory or delete records |
| **F&I Manager** | Same as Salesperson for now (F&I-specific access comes later) |

Who can do what lives in one table, `PERMISSIONS` in `auth.js`.

**Creating the first admin account:** a new install has no users. On startup the server writes a one-time setup link to its logs (on Render: your web service → **Logs**):
```
No user accounts exist yet. To create the first admin account, open:
  https://your-app.onrender.com/login.html?setup=...
```
Open it, enter your name, email, and a password (8+ characters), and you're signed in as the admin. Add everyone else from **⚙️ Admin → Users & Roles**. The link only works once; until an admin exists, each restart prints a new one.

**Day to day:**
- Staff change their own password from the 👤 button at the top.
- Forgotten passwords: an admin uses **Reset Password** in Users & Roles.
- When someone leaves, **Deactivate** them. They're signed out immediately and can't sign back in; their history stays.
- Sign-ins last 12 hours. 10 wrong passwords in a row for an account locks it for 15 minutes.
- Passwords are stored hashed (scrypt) and can't be read back by anyone, including admins.

## Setting up encryption

SSNs and driver's license numbers on credit applications are encrypted before they're saved (AES-256-GCM), so anyone who gets into the database directly (a leaked connection string, a backup) sees scrambled text. Everyone signed in to the app still sees the full numbers.

The key comes from the `DATA_ENCRYPTION_KEY` setting, and the app won't start without it.

**On Render:** web service → **Environment** → **Add Environment Variable**. Key `DATA_ENCRYPTION_KEY`; for the value, click **Generate** (or paste any random value of 32+ characters). Save.

**Locally:** add `DATA_ENCRYPTION_KEY=...` to `.env`. Generate a value with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

⚠️ **Keep a copy of the key somewhere safe outside Render** (a password manager). If it's lost or changed, existing SSNs and license numbers can never be read again.

SSNs saved before encryption existed are encrypted automatically the first time the server starts with a key.

## Audit log

Every change is recorded: who did it, when, and exactly which fields changed from what to what. That covers vehicles, customers and their activity log, texts sent, deals and credit apps, tax rates, fee defaults, and user accounts, plus sign-ins, failed sign-in attempts, and sign-outs. Deleted records keep a copy in the log.

- View it under **⚙️ Admin → Audit Log** (admins and sales managers). Filter by record type, date range, or search by customer, vehicle, deal number, or staff name.
- Entries can't be edited or deleted from the app.
- SSNs, license numbers, and passwords are never written to the log; it only notes that they changed.
- To protect the history, general edits can't overwrite server-managed fields (a lead's activity log, a deal's number or credit app, a car's photos) -- those only change through their own screens, which log them.

## Setting up photo storage

Car photos are stored in [Cloudinary](https://cloudinary.com) (free plan: roughly 25 GB). Without it, photos are saved on the server's own disk -- fine on your computer, but on Render that disk is wiped on every redeploy.

1. Sign up at [cloudinary.com](https://cloudinary.com/users/register_free).
2. On the Cloudinary dashboard, find **API environment variable** and copy it. It looks like `cloudinary://123456789012345:abcdEFGH...@your-cloud-name`.
3. On Render: web service → **Environment** → add `CLOUDINARY_URL` and paste it. Save.

The server log says which storage is in use at startup (`Car photos: stored in Cloudinary (...)`). Photos are organized in Cloudinary under `dealerships/<dealership>/cars/<car>/`.

## Key machine integration (KeyTrak, KeyWatcher, Traka...)

Inventory has a **Key** column showing whose name each car's key is checked out under ("🔑 Sam Sales · 2:14 PM"), or "🔑 In · slot 12" when it's back. Keys out longer than 2 hours show in red. Search inventory by stock # to look up a key without walking to the key machine. It refreshes every 30 seconds.

**The key machine stays in charge of keys.** The CRM only displays what it reports -- checking keys in and out still happens at the machine.

### Connecting a key machine
1. **⚙️ Admin → Integrations (Key Machine) → Create token** (admins only). Copy the token -- it's shown once. Revoke it any time to cut the connection off.
2. Whoever connects the key machine (its vendor's integration, or a small connector at the store) sends each check-out / check-in to:

```
POST https://<your-site>/api/integrations/keys/events
Authorization: Bearer <token>
Content-Type: application/json

{
  "action": "check_out",            // or "check_in", "missing" (also understood: "out", "in", "returned"...)
  "tagCode": "A-114",               // the key machine's id for the key -- and/or --
  "stockNumber": "ST-4821",         // or "vin": "1HGCM82633A004352"
  "personName": "Sam Sales",        // who has it
  "personEmail": "sam@store.com",   // optional: links it to their CRM login
  "slot": "12",                     // optional: cabinet slot, on check-in
  "occurredAt": "2026-09-24T14:05:00Z", // optional: when it happened (defaults to now)
  "eventId": "kt-99812"             // optional but recommended: the machine's event id
}
```

**How events are handled**
- **Matching:** by `tagCode` first; otherwise the car with that stock # or VIN. Keys are created automatically the first time a car's key is seen; the first tag code seen for a car's key is remembered, so later events can send just the tag. A car with two keys (two tags) shows both.
- **Resent events** with the same `eventId` are counted once (`"status": "duplicate"`).
- **Late events** older than the key's current status are recorded but don't change it (`"status": "recorded_late"`). Times in the future (a machine clock running ahead) are treated as now.
- **Unknown cars** (a stock # not in the CRM yet) are saved and listed under **Integrations → Events that didn't match a car** (`202`, `"status": "unmatched"`).
- Each dealership's token only ever matches its own inventory.
- Responses: `200` applied / duplicate / recorded_late, `202` unmatched, `400` invalid event (with a message), `401` missing or revoked token.

### Which connection method?
That depends on what the key-machine vendor offers the store: an official integration that sends events to this address (best -- real time), scheduled data exports that a small connector reads and forwards, or a connector on the store's key-machine PC. Ask the vendor's integration team or the store's account rep which is available.

## Setting up the AI features

The AI Assistant and Suggested Reply button need a free Google Gemini API key to work (everything else in the app works fine without one).

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey) and grab a free key (no credit card required).
2. In the `car-crm` folder, copy `.env.example` to a new file named `.env`.
3. Paste your key in: `GEMINI_API_KEY=your-key-here`
4. Restart the server (`npm start`).

`.env` is gitignored, so your key never gets committed. If you deploy this (e.g. to Render), set `GEMINI_API_KEY` as an environment variable in that platform's dashboard instead of using a `.env` file.

**Swapping providers later:** every AI call in this project funnels through one function, `callAI()`, in `server.js`. Switching to OpenAI, Anthropic, or any other provider only means rewriting that one function -- the redaction logic, the context building, and both API routes stay exactly the same.

## Setting up real SMS (Twilio)

The "Send Text" feature on a lead's profile needs a Twilio account to actually send messages.

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) and grab a free trial phone number.
2. In your `.env` file, add:
   ```
   TWILIO_ACCOUNT_SID=your-sid-here
   TWILIO_AUTH_TOKEN=your-token-here
   TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
   ```
3. Restart the server.

**Trial account limitations** (not bugs): Twilio trial accounts can only text phone numbers you've manually verified in the Twilio console first, and every message gets a "Sent from your Twilio trial account" prefix. Both go away once you upgrade to a paid account.

## Setting up the database

The app stores everything in PostgreSQL and won't start without a `DATABASE_URL`.

**On Render**
1. In the Render dashboard, click **New → Postgres** and create a database (pick the same region as your web service).
2. Open the new database and copy its **Internal Database URL**.
3. Open your web service → **Environment** → add `DATABASE_URL` and paste the URL. Save; Render redeploys automatically.

**Locally**, put a connection string in your `.env` file:
```
DATABASE_URL=postgres://user:password@localhost:5432/dealership_crm
```
If you want to point your local copy at the Render database instead, use its **External Database URL** and add `?sslmode=require` to the end.

**What happens on first start:** the server creates its tables, creates a default dealership, and copies in everything from `data/db.json` (cars, leads, deals, tax rates, settings). That import only ever happens once, into an empty database -- it can't duplicate or overwrite data. After that, `data/db.json` is no longer used.

**Database changes over time** are listed in the `MIGRATIONS` array in `db.js` and applied automatically on startup, each exactly once.

## Running it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser. Sample data is loaded on the first start so you can see it working immediately.

## Running the tests

The tests run against a real Postgres database, which they **wipe first** -- use a separate throwaway database, never your real one:

```bash
TEST_DATABASE_URL=postgres://user:password@localhost:5432/dealership_crm_test npm test
```

## What I'd add next

- State-specific tax rule presets, since tax treatment of trade-ins and rebates varies by state
- Email/SMS reminders for leads that have gone quiet
- CSV export for tax/accounting purposes

## Project structure

```
car-crm/
├── server.js          # Express API (cars, leads, deals, credit apps, AI endpoints)
├── db.js              # Postgres connection, migrations, and record storage
├── auth.js            # Sign-in, sessions, roles/permissions, user management
├── audit.js           # Audit log: recording changes and reading them back
├── encryption.js      # Encrypts SSNs and license numbers at rest
├── vin.js             # VIN validation and decoding (NHTSA vPIC)
├── photos.js          # Car photo storage (Cloudinary, or local disk)
├── keys.js            # Key status from the key machine (KeyTrak etc.) + integration tokens
├── providers.js       # Appraisal data sources: live (NHTSA recalls) and not-yet-connected slots
├── .env.example       # Template for your settings and keys (copy to .env)
├── data/db.json       # Sample data, imported once on first start
├── test/              # API tests (run against a throwaway Postgres database)
├── public/
│   ├── index.html       # App shell + modals
│   ├── login.html       # Sign-in page (also creates the first admin)
│   ├── style.css        # Styling
│   └── app.js            # Frontend logic (fetch calls, rendering, forms)
└── package.json
```
