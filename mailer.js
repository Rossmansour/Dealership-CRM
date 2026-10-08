// mailer.js -- Sends email from the CRM.
//
// Not live until the store has a sending service: set RESEND_API_KEY and
// EMAIL_FROM (an address on a domain verified with Resend). Until then
// nothing is sent, and send() says why, so callers can show "not sent".

let transport = null;
// Tests swap in a pretend sender.
function setTransport(fn) { transport = fn; }

const ready = () => !!(transport || (process.env.RESEND_API_KEY && process.env.EMAIL_FROM));

async function send({ to, subject, text }) {
  const list = [...new Set((Array.isArray(to) ? to : [to]).filter(Boolean))];
  if (!list.length) return { sent: false, reason: 'Nobody to send it to.' };
  if (transport) return transport({ to: list, subject, text });
  if (!ready()) return { sent: false, reason: "Email isn't set up yet (needs RESEND_API_KEY and EMAIL_FROM)." };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: list, subject, text })
  });
  if (!res.ok) return { sent: false, reason: `Email service error (${res.status}).` };
  return { sent: true, id: (await res.json().catch(() => ({}))).id };
}

module.exports = { send, ready, setTransport };
