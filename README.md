# Smash Wed League

A Wednesday-night badminton league site: players sign up, check in, get drawn
into round-robin pools, and score their own games — no organizer needed on
the night except to generate pools and hand out the weekly PIN.

## How the pieces fit together

```
Players' browsers
      │  fetch(GAS_URL, ...)
      ▼
site/index.html  ──deployed by GitHub Pages (.github/workflows/pages.yml)──
      │
      │  HTTPS GET/POST (JSON)
      ▼
Google Apps Script Web App (gas/Code.gs, bound to the spreadsheet)
      │
      ▼
"2026 Smash Wed League" Google Spreadsheet
  - one tab per week, named M/D/YY (e.g. "7/15/26")
  - a "Rankings" tab with season standings
```

- **`site/index.html`** is the entire frontend: one static HTML file with
  inline CSS/JS, no build step. It's a single-page app with four tabs —
  Standings, This week, Past weeks, Join — plus an Admin panel. It talks to
  the backend only through `fetch()` calls to `GAS_URL`, a constant near the
  top of the `<script>` block.
- **`gas/Code.gs`** is a Google Apps Script project bound to the league
  spreadsheet. It's deployed as a Web App and exposes a small JSON API
  (`doGet`/`doPost` — see the endpoint list in the comment header of that
  file) that reads and writes the spreadsheet directly.
- **The spreadsheet** (`2026 Smash Wed League.xlsx` locally is just a
  reference copy — the live one lives in Google Drive) is the actual
  database. Every weekly tab uses a fixed template: column A is the signup
  list, column B is check-in/no-show status, and four pool blocks (A–D) hold
  seeded slots and a score grid. The `Rankings` tab accumulates one
  rank/points column-pair per finalized week and computes standings with its
  own formulas.
- **`site/mock-backend.js`** is a stand-in for `Code.gs` used only for local
  frontend development in a browser, without touching the real spreadsheet.

## Running the badminton league: what organizers and players do

### Players

1. **Join** — On the Join tab, pick the upcoming Wednesday, enter your name
   (or pick your name if you've played before) and contact info, and submit.
   You land on the confirmed list or the waitlist depending on when you
   signed up (cap is 24; waitlist is never auto-promoted once pools are
   drawn).
2. **Check in** — On the night, open the This week tab and tap "Check in"
   next to your name. If you can't make it, tap "No show" so your spot can
   be handed to a guest instead of sitting empty. Both actions are open to
   everyone — no PIN needed.
3. **Play** — Once pools are drawn, the This week tab shows your pool and
   live matches. Anyone can start a match between two same-pool players who
   haven't played yet, and record the final score when it's done (whole
   numbers, no ties). Scores can be corrected later from the same screen.
4. **Track standings** — The Standings tab shows season rank, rolling
   average, and a trend chart per player, computed from the Rankings sheet.
   Past weeks are browsable on their own tab once finalized.

### Organizer

1. **Each week**, a tab named `M/D/YY` must exist in the spreadsheet ahead of
   time (copy the previous week's tab and clear it, keeping the formula
   template intact) so players have somewhere to join.
2. **Wednesday at noon**, a time-driven trigger (`sendWeeklyPin`, installed
   by `setupTriggers()`) emails a 6-digit PIN for that date to the addresses
   in the `ADMIN_EMAILS` script property. The PIN can also be looked up any
   time from the Admin tab on the site using the `ADMIN_SECRET` passphrase.
3. **At pool time**, the organizer opens the Admin panel, enters the PIN, and
   taps "Generate pools" (or "Redraw" if it's before any scores are entered).
   Pools are seeded by season rank (best players in Pool A) with padding
   guest slots as needed; below 12 eligible players the session is cancelled.
4. **During play**, no organizer action is needed — check-in, no-show,
   starting matches, and recording scores are all self-service.
5. **After the last game**, the week auto-finalizes: rank points get written
   into the Rankings sheet as a new column pair, and standings recalculate
   automatically. A nightly trigger (`autoFinalizeDaily`) catches any week
   whose last score was typed directly into the sheet instead of through the
   site.

## Maintaining the site, spreadsheet, and Apps Script

### GitHub Pages (`site/`)

- Edit `site/index.html` directly — it's the whole app, no build step.
- Any push to `main` that touches `site/` triggers
  `.github/workflows/pages.yml`, which publishes the `site/` directory as-is
  to GitHub Pages. There's nothing to build or install.
- To test locally, open `site/index.html` in a browser with
  `site/mock-backend.js` wired in (or point `GAS_URL` at a real deployment)
  rather than editing the live site to check changes.

### Google Apps Script (`gas/Code.gs`)

- **This is the part that's easy to forget:** `gas/Code.gs` in this repo is
  only a *tracked copy*. The actual backend runs from Apps Script's own
  editor, bound to the spreadsheet (Extensions → Apps Script). **Editing
  `Code.gs` here does nothing to the live site until you manually copy the
  new contents into the Apps Script editor and deploy a new Web App
  version** (Deploy → Manage deployments → Edit → New version).
- One-time setup on a fresh binding: set the `ADMIN_EMAILS` and
  `ADMIN_SECRET` script properties (Project Settings → Script Properties),
  then run `setupTriggers()` once from the editor to authorize `MailApp` and
  install the Wednesday-noon PIN email and nightly auto-finalize triggers.
- Because the deploy step is manual, keep `gas/Code.gs` in the repo in sync
  with whatever you paste into Apps Script — treat the repo as the source of
  truth and the Apps Script editor as the deploy target, not the other way
  around.

### The spreadsheet

- Weekly tabs follow a fixed template (pool seed slots, score grid position,
  status column) that `Code.gs` depends on by cell position — see the
  geometry constants (`POOL_LAYOUT`, `SLOT_COL`, `GRID_FIRST_COL`, etc.) near
  the top of `gas/Code.gs`. When creating a new week's tab, duplicate an
  existing week rather than building one from scratch, so the geometry and
  formulas stay intact.
- The `Rankings` tab's Rank and Avg columns are spreadsheet formulas, not
  written by the script — `Code.gs` only writes the raw R/RP value pairs per
  finalized week; the sheet's own formulas do the rest.
- Avoid manually reordering or inserting columns in either sheet type,
  since the script locates data by fixed column position and by scanning
  header text like `M/D/YY RP`.
