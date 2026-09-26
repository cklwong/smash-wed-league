# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Wednesday-night badminton league site: players sign up online, get drawn
into round-robin pools, and follow a live board while an organizer runs
check-in and the match desk from an admin-signed-in device.

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
  inline CSS/JS, no build step, no framework. It's a single-page app with
  four tabs — Standings, This week, Past weeks, Join — plus an Admin panel.
  It talks to the backend only through `fetch()` calls to `GAS_URL`, a
  constant near the top of the `<script>` block.
- **`gas/Code.gs`** is a Google Apps Script project bound to the league
  spreadsheet. It's deployed as a Web App and exposes a small JSON API via
  `doGet`/`doPost` (full endpoint list is in the file's header comment) that
  reads and writes the spreadsheet directly. There is no database besides
  the spreadsheet itself.
- **The spreadsheet** (`2026 Smash Wed League.xlsx` in the repo root is just
  a local reference copy — the live one lives in Google Drive) is the actual
  data store. Every weekly tab uses a fixed template: column A is the signup
  list, column B is check-in/no-show status, and four pool blocks (A–D) hold
  seeded slots and a score grid. The `Rankings` tab accumulates one
  rank/points column-pair per finalized week and computes standings with its
  own formulas — `Code.gs` writes raw values, the sheet's formulas do the
  rank/avg math.
- **`site/mock-backend.js`** is a stand-in for `Code.gs` used only for local
  frontend development in a browser, without touching the real spreadsheet.

## Commands

There is no build, lint, or test suite — this is a static HTML file plus a
Google Apps Script file, edited directly.

- **Run the frontend locally**: open `site/index.html?mock=1` in a browser.
  The `?mock=1` query param makes `index.html`'s `<head>` `document.write` in
  `site/mock-backend.js` before the app's own script runs, so every `fetch()`
  call is intercepted with in-memory seed data instead of hitting
  `script.google.com`. Reload to reset state to the seed; any PIN/passphrase
  is accepted in mock mode (it's a sandbox, not a security check).
- **Test against the real backend**: open `site/index.html` normally (no
  `?mock=1`) — it uses the `GAS_URL` deployment URL hardcoded near the top of
  the inline `<script>`.
- **Deploy the frontend**: push to `main` touching anything under `site/` —
  `.github/workflows/pages.yml` publishes `site/` as-is to GitHub Pages.
  Nothing to build or install.
- **Deploy the backend**: manual and easy to forget. `gas/Code.gs` in this
  repo is only a *tracked copy*; the live backend runs from the Apps Script
  editor bound to the spreadsheet (Extensions → Apps Script). Editing
  `Code.gs` here does nothing until you copy the new contents into the Apps
  Script editor and deploy a new Web App version (Deploy → Manage
  deployments → Edit → New version). Treat the repo as source of truth and
  the Apps Script editor as the deploy target — keep them in sync.

## Architecture notes

- **Weekly tab geometry is load-bearing.** `Code.gs` locates data by fixed
  cell position, not by searching — see `POOL_LAYOUT`, `SLOT_COL`,
  `GRID_FIRST_COL`, `CONTACT_COL`, `NOSHOW_GUEST_COL` near the top of
  `gas/Code.gs`. Pool grids are formula-driven off the column-E seed slots
  (grid headers are `=E2` etc.), so "drawing a pool" is just writing names
  into column E. When creating a new week's tab, always duplicate an
  existing week (or use the `createWeek` action) rather than building one
  from scratch, so geometry and formulas stay intact. Never manually
  reorder/insert columns in a weekly tab or the Rankings tab — the script
  also locates Rankings columns by scanning header text like `M/D/YY RP`.
- **Auth model**: every mutating admin action requires `secret` (the
  `ADMIN_SECRET` script property) checked server-side in `Code.gs`
  (`checkAdminSecret`/`checkRunAuth`) — the frontend hiding admin controls
  from signed-out users is UX only, not the security boundary. A separate
  per-event PIN (looked up via the `getpin` action with the admin secret on
  the Admin tab; `sendWeeklyPin` still exists to email it but no longer runs
  on a schedule) gates the check-in/match-desk actions during a live
  session.
- **Finalization**: a week auto-finalizes (`maybeFinalizeWeek`) once every
  scheduled game is scored, writing a new `M/D/YY R`/`M/D/YY RP` column pair
  into Rankings. `autoFinalizeWeekly` (Wednesday-9:30pm trigger) catches
  weeks whose last score was typed directly into the sheet instead of
  through the site, and sweeps up that week's stale PIN/live-state script
  properties (`cleanupPastEventProperties`).
  `forceFinalizeWeek` (the site's "Finalize rankings" button) re-runs
  finalize for an already-finalized week, overwriting its column pair in
  place — use this after a post-hoc score correction.
- **Standings tie-breaking**: `computeRankings`/`applyTieBreaks` resolve
  equal-Avg ties by most-recent-week rank points, then most-recent
  head-to-head, with unresolved ties sharing one rank number but shuffled
  randomly (not alphabetically, since pool seeding sorts on this field).
  This runs once per finalize and is persisted to the Rankings sheet's
  "Sorted Name"/"Sorted Rank" columns by `writeSortedRankings()` —
  `getRankings()` just reads that snapshot back, so order is stable across
  page loads until the next finalize.
- **In-progress match marker**: a lone `p` in the weekly score grid marks a
  match currently on court on the site's Live tab (highlighted by
  conditional formatting). `recordScore` overwrites it with the real score;
  cancelling the match clears it.
- **Manual finalize-surgery helpers** in `Code.gs`, run from the Apps Script
  editor: set `MANUAL_FINALIZE_DATE` then call `dryRunFinalizeDate()` (logs
  what a finalize would write without touching the sheet) or
  `runFinalizeDate()` (runs it for real). `fixAvgFormulas()` force-rewrites
  the Rankings Avg column if its formulas get mangled.
- **Signup column A**: new week tabs (`createWeek` → `clearSignupsForNewWeek`)
  start with an empty signup list - no "Max limit (24ppl)"/"Wait List Below"
  labels and no stray "Sorted Name"/"Sorted Rank" copy below it; the site
  enforces the cap/waitlist by position. Past tabs still have them, so
  `parseSignups` keeps skipping them (`isSignupLabel`). Tabs already created
  before this change are cleaned by running
  `removeSignupLabelsFromUpcomingWeeks()` once from the editor (only tabs
  dated today or later; it shifts rows up so the list stays contiguous).
  The Rankings tab's own Sorted Name/Rank columns are unrelated and stay.
- **Walk-ins** (both formats): the organizer adds someone who didn't sign up
  from the "Walk-ins" card (returning-player dropdown or a typed new name)
  via `addWalkIn` - appended to the signup list with no email and checked
  in, and remembered in `LIVE_<date>.walkins` so `editWalkIn` can fix a
  typo'd name (signup list, pool seat, match log, relay teams/games) and
  `removeWalkIn` can undo one added by mistake (refused once they hold a
  singles pool seat or have played a relay game). Only desk walk-ins can
  be edited/removed this way. On singles nights `singlesDrawEligible` seats
  the first 24 non-no-shows, then fills spots freed by no-shows with
  checked-in players from past the cap (walk-ins, waitlisters who turned
  up); the Check-in list shows those past-cap check-ins with a waitlist tag.
- **Team doubles nights** (code calls them "relay", after an earlier
  rotating-pairs format): any date can be switched from singles to a team
  doubles night on the Admin tab (`setEventFormat`, stored as an
  `EVENT_<YYYY-MM-DD>` script property; no property = singles, so singles
  weeks are untouched). Teams/games live as JSON in cell A1 of a separate
  `Relay M/D/YY` tab (rows below are a read-only readable copy) - never in
  the weekly tab's pool geometry. The site's This week page renders these
  nights via `paintRelay` in `index.html`, with the same Check-in / Live /
  Pools sub-tabs as singles (Pools = teams, pairs, playing order, results).
  Format: each team's positions fix its pairs for the night (P1+P2, P3+P4,
  ...); in each of the two rounds every pair plays twice, against two
  different opposing pairs; a 1-1 tie goes to one tiebreak game. A team's
  playing order per round lists each pair index twice (game k = first
  team's k-th entry vs second team's); the default comes from
  `RELAY_REST_ORDERS` (separate `a`/`b` orders per pair count, brute-forced
  to spread rest), round 2 follows round 1 unless given its own `order[2]`,
  and a round's order locks once its first game starts. Games only start
  when both teams in a matchup have the same, even number of players
  (`relayMatchupProblem`). The pure rules (`relayPairs`/`relayOrder`/
  `relayDefaultOrder`/`relayTieView`/`relayPlayerStats`/`relayTeamSizes`)
  exist in both `Code.gs` and `index.html` and must stay in sync (the mock
  reuses the page's copies). Singles-only actions (`generatePools`,
  `startMatch`, `recordScore`, `editScore`, `cancelMatch`) refuse on these
  dates. Ranking points per night: exhibition (nothing written to Rankings)
  or ranked (doubles won + `RELAY_TEAM_BONUS` for a tie win, R label
  `T<team>`). The team draw (`drawTeams`) takes every confirmed signup
  except no-shows and fills teams in standings tiers - the top group
  snake-split between A and B, the next between C and D, ... -
  `relayTeamSizes` gives every team whole pairs and equal matchups, padding
  with "Guest N" placeholders (the fewest needed, on the last teams).
  Walk-ins and late players are added through `relayAddPlayer` (=
  `addWalkIn` plus an optional team; `relayPlaceOnTeam` puts them in a
  Guest N placeholder's spot if the team has one); guests (named, or
  "Guest N") are team-only, listed in the relay state's `guests`, and never
  get rank points. Test with `site/index.html?mock=1&relay=1`.
- **One-time environment setup** on a fresh spreadsheet binding: set the
  `ADMIN_EMAILS` and `ADMIN_SECRET` script properties (Project Settings →
  Script Properties) - optionally also `SHEET_EDITORS` (comma-separated emails
  allowed to hand-edit protected week/relay tabs; easiest set from the site's
  Admin tab "Sheet editors" box, which also adds them to already-protected
  tabs of today's/upcoming events only - past events stay owner-only, and
  `autoFinalizeWeekly` calls `removeSheetEditorsFromPastTabs()` to take them
  back off once an event's date has passed; the
  Project Settings panel can fail to save on this project), then run `setupTriggers()` once to authorize `MailApp`
  (also used for the new-player welcome email on signup) and install the
  Wednesday-9:30pm `autoFinalizeWeekly` trigger. It does not install a
  recurring PIN email - the PIN is retrieved on demand from the Admin tab.
