# DealerDomus launch checklist

Things to set up or decide before real stores use DealerDomus. Check them off as they're done.

## Accounts and keys (set on Render → Environment)

- [ ] **Twilio (texting)** -- buy a local number, register for A2P 10DLC (carriers require it for business texting; takes a few days to a couple of weeks, have the LLC's EIN ready), then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`. Until then, texts, photos, and videos can't actually be sent.
- [ ] **Email for the CRM** -- pick a domain, sign up for a sending service (Resend, Postmark, or SendGrid), add its DNS records (SPF/DKIM) so mail doesn't land in spam. Then the CRM's Email tab needs to be built to actually send (today it only logs emails).
- [ ] **AI key** -- confirm `GEMINI_API_KEY` is set, so the task planner reads notes and the AI Assistant works. (Switching to Claude is possible: one function plus an Anthropic key.)
- [ ] **Rotate the database password** (deferred earlier).
- [ ] **Rotate the Cloudinary API key** (deferred earlier).
- [ ] **Paid plans** -- Render (app + database with daily backups), Cloudinary (video uses storage and bandwidth fast), Twilio, MarketCheck, email service.

## Turn on in the app

- [ ] **AI task planning every morning** -- Sales Pipeline → ⚙ next to "My tasks today".
- [ ] **Store ZIP code** in Market Pricing → Pricing rules (market data needs it).
- [ ] **Duplicate Leads** -- run "Check all customers" once after importing a store's data.
- [ ] **Round robin and store hours** -- Admin → Round Robin & Store Hours.

## Business and legal

- [ ] DBA for DealerDomus under the existing LLC.
- [ ] Trademark the DealerDomus name.
- [ ] Business and cyber insurance.
- [ ] Customer contract, privacy policy, and FTC Safeguards Rule written policy.
- [ ] SOC 2 (later, when bigger groups ask).

## Launch and growth

- [ ] Domain: marketing site at the root, the app at `app.` (Render → Custom Domains; don't touch existing MX records).
- [ ] Separate staging and production on Render.
- [ ] RouteOne and Dealertrack partner applications (after the first paying store).
- [ ] First store pilot (your store or one of Jeff's), then a case study.
