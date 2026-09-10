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
- **Calculations happen server-side, not in the browser.** The frontend just displays whatever the API returns — it never recomputes the math itself. That way there's one source of truth, and if the formula ever needs to change (say, a state-specific tax rule), it only changes in one place.

## Tech stack

- **Backend:** Node.js + Express, REST API
- **Storage:** JSON file (kept intentionally simple — no database setup required to run this)
- **Frontend:** Vanilla HTML/CSS/JavaScript, no framework

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
├── server.js          # Express API (cars, leads, stats endpoints)
├── data/db.json        # JSON data store (seeded with sample data)
├── public/
│   ├── index.html       # App shell + modals
│   ├── style.css        # Styling
│   └── app.js            # Frontend logic (fetch calls, rendering, forms)
└── package.json
```
