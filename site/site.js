// site.js -- the "Book a demo" form. Requests go to DealerDomus itself and
// show up as a new customer (source: Website) in the store's CRM Domus.
document.getElementById('year').textContent = new Date().getFullYear();

// Where the app lives. On the app's own server this is the same place; if
// the site is hosted separately, set <meta name="app-url" content="https://app...">.
const APP_URL = (document.querySelector('meta[name="app-url"]') || {}).content || '';

document.getElementById('demoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = document.getElementById('demoMsg');
  const data = Object.fromEntries(new FormData(form));
  msg.className = 'form-msg';
  if (!data.name.trim() || !data.dealership.trim() || !/^\S+@\S+\.\S+$/.test(data.email.trim())) {
    msg.textContent = 'Please add your name, dealership, and a valid email.';
    msg.classList.add('err');
    return;
  }
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    const res = await fetch(`${APP_URL}/api/public/demo-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
    form.reset();
    msg.textContent = "Thanks! We'll be in touch soon to set up your demo.";
    msg.classList.add('ok');
  } catch (err) {
    msg.textContent = err.message;
    msg.classList.add('err');
  }
  btn.disabled = false;
  btn.textContent = 'Request a demo';
});
