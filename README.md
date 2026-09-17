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

**Lead Profiles**
- Click any customer's name to open their **Profile**: contact info, source, interested vehicle, and status at a glance
- **Communication Log**: log calls, texts, emails, and notes with a timestamp, newest first -- a real activity history instead of one cramped notes field
- **Related Deals**: every deal tied to this customer, with the deal number linking straight into that deal's desking/credit app workspace
- **"+ Create Deal"** right from the profile, using the customer's already-linked vehicle -- no need to re-pick the customer and car from a dropdown when you're already looking at their record

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
- ⚠️ **Photos live on the server's disk, same as `db.json`** -- on a host with an ephemeral filesystem (Render's free tier), uploaded photos disappear on every restart/redeploy, exactly like the rest of the data. Fine for a demo, not for real production use without switching to real file storage (e.g. S3, Cloudinary).

**Real SMS (Twilio)**
- A dedicated "Send Text" flow on each lead's profile that sends an actual SMS via Twilio, not just a logged note -- the send and the log entry happen together automatically
- Separate on purpose from the manual "log a call I already made" form, since one triggers a real message and the other is just historical record-keeping

**Leads Pipeline (Kanban board)**
- Toggle between a table view and a drag-and-drop pipeline view of leads, styled after how DriveCentric and Tekion visualize lead flow
- Drag a card from one stage to another (New → Contacted → Negotiating → Won/Lost) to update that lead's status instantly

**AI Lead Snapshot**
- One click on a lead's profile generates a short AI summary of where things stand with that customer -- their situation, momentum, and one recommended next action -- instead of re-reading their whole communication history

**"Needs Follow-Up" Alerts**
- Any open lead (not won or lost) that hasn't been contacted in 3+ days gets flagged automatically, both on the Dashboard (a running count) and as a badge on their card/row -- modeled after the "smart alerts for leads going cold" feature in real dealership CRMs

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
- **Every AI call goes through one function, not scattered `fetch` calls.** Both the chat assistant and the suggested-reply feature call the same `callAI()` function in `server.js`. That's the only place that knows Gemini's specific request format -- swapping providers, or adding a fallback if one provider goes down, means changing one function instead of hunting through the codebase.
- **SSNs are redacted before anything reaches the AI provider, but income, employer, and deal status are not.** A blanket "redact everything sensitive" approach would make the assistant useless for its actual job (answering questions about deals). The redaction list is deliberately narrow: strip what could enable identity theft, keep what's needed to be useful.
- **Sending a real text is a separate action from logging one manually.** They look similar in the UI but do very different things -- one dials out to a real phone, the other just records history. Folding them into a single form would risk someone accidentally sending a real SMS while just trying to log a call they made from their cell phone.
- **"Needs Follow-Up" is computed from activity recency, not a manually-set flag.** A salesperson forgetting to flag a lead is exactly the failure mode this feature exists to catch -- so it can't depend on someone remembering to flag it themselves. It's derived automatically from whether anyone has logged contact in the last few days.
- **The Kanban board and the table view share the exact same underlying `leads` data and the same `openLeadProfile()` function.** Dragging a card just calls the same `PUT /api/leads/:id` endpoint the Edit Details form already uses -- there's no separate "pipeline" data model to keep in sync with the table.
- **Photo uploads only appear on the Edit Car screen, not Add Car.** A photo needs a car ID to attach to, and that ID doesn't exist until the car's first save. Rather than fake an ID or save a draft car, the flow just asks for the basics first, then photos on the follow-up edit -- an honest reflection of the actual dependency instead of hiding it.
- **Calculations happen server-side, not in the browser.** The frontend just displays whatever the API returns — it never recomputes the math itself. That way there's one source of truth, and if the formula ever needs to change (say, a state-specific tax rule), it only changes in one place.

## Tech stack

- **Backend:** Node.js + Express, REST API
- **Storage:** JSON file (kept intentionally simple — no database setup required to run this)
- **Frontend:** Vanilla HTML/CSS/JavaScript, no framework

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

## Running it locally

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser. Sample data is pre-loaded so you can see it working immediately.

## What I'd add next

- State-specific tax rule presets, since tax treatment of trade-ins and rebates varies by state
- Photo uploads per vehicle
- Email/SMS reminders for leads that have gone quiet
- Multi-user support with basic auth (for a shop with more than one salesperson)
- Swap the JSON file for a real database (SQLite or Postgres) if usage grew beyond a single dealership
- CSV export for tax/accounting purposes

## Project structure

```
car-crm/
├── server.js          # Express API (cars, leads, deals, credit apps, AI endpoints)
├── .env.example         # Template for your Gemini API key (copy to .env)
├── data/db.json        # JSON data store (seeded with sample data)
├── public/
│   ├── index.html       # App shell + modals
│   ├── style.css        # Styling
│   └── app.js            # Frontend logic (fetch calls, rendering, forms)
└── package.json
```
