# Smash Wed Worker (Cloudflare)

A small API on Cloudflare's free Workers plan that sits between the site and
the Apps Script backend, so game-day taps and signups answer in a fraction of
a second instead of waiting for Apps Script and the spreadsheet.

```
Players' / organizers' browsers
      │  fetch(WORKER_URL, ...)          (site/index.html; empty WORKER_URL = old direct path)
      ▼
Cloudflare Worker  (worker/src/index.js)
  ├─ EventDO: one database per event date (worker/src/core.js)
  │    answers check-in, match desk, doubles games, walk-ins, join/leave
  │    at once, then replays them to Apps Script in the background
  ├─ MetaDO: cached standings, event dates, head-to-head (worker/src/meta.js)
  └─ everything else (admin tools) → straight to Apps Script
      │  POST syncBatch / syncHydrate (SYNC_KEY)
      ▼
Google Apps Script (gas/Code.gs) → the spreadsheet (still the source of truth)
```

## How it stays correct

- Each event date has its own Durable Object holding two copies of the week:
  **base**, exactly as Apps Script last reported it (Code.gs `syncSnapshot`),
  and **st**, which is base plus every action not yet confirmed. The site is
  shown st.
- An action is checked first: the sign-in against hashes of the admin
  passphrase and event PIN that Apps Script provides, then the same rules
  Code.gs applies (`site/week-engine.js`, also what `?mock=1` runs). It is
  then applied to st, queued, and answered.
- About half a second later, an alarm sends the queue to Code.gs `syncBatch`,
  which replays each action in order as the organizer. Timestamps (match
  timers, check-in times) are kept from the original tap. The reply carries a
  fresh snapshot that becomes the new base, and anything still queued is
  re-applied on top.
- So the sheet is still the record. If the sheet ever disagrees, for example
  because it refused an action or someone edited the tab by hand, its version
  wins on the next sync. Refusals are listed on the Admin tab's **Sheet sync**
  box.
- When nothing is pending, a copy older than 10 minutes re-reads the sheet in
  the background. **Reload this week from the sheet** (Admin tab) does it
  immediately, after flushing anything pending.
- Admin actions that rewrite a whole week (finalize, reset, format switch)
  first wait for the queue to reach the sheet, then run in Apps Script, then
  reload the week. Everything else (create week, renames, bans, sheet editors, ...)
  goes straight to Apps Script as before.
- If Apps Script is unreachable, actions still answer and queue up. Syncing
  retries with back-off: 2 s, 5 s, 15 s, 30 s, 1 min, then every 2 min.

Trade-offs, agreed up front:
- Signup confirmation emails arrive about a minute after joining, when the
  join is replayed.
- Don't hand-edit a week's tab while it's in use. If you must, press **Reload
  this week from the sheet** afterwards.

## One-time setup

1. **Apps Script.** Paste the current `gas/Code.gs` into the Apps Script
   editor and deploy a new version (Deploy → Manage deployments → Edit → New
   version). Then run `setupSyncKey()` once from the editor and copy the
   `SYNC_KEY = …` value from the execution log.
2. **Cloudflare.** Go to Workers & Pages → Create application → Import a
   repository → `cklwong/smash-wed-league`.
   - Project name: `smash-wed`. It must match `name` in `wrangler.jsonc`.
   - Production branch: `main`.
   - Root directory: `worker`.
   - Build command: empty. Deploy command: `npx wrangler deploy`.
   - Build watch paths: `worker/*`, `site/week-engine.js`,
     `site/relay-rules.js`. The Worker bundles those two site files.
3. **Secret.** On the Worker, go to Settings → Variables and Secrets → Add →
   type *Secret*, name `SYNC_KEY`, value = the key from step 1. Then
   redeploy, or wait for the next build.
4. **Check it.** Open `https://smash-wed.<your-subdomain>.workers.dev/?action=health`.
   It should return `{"ok":true,"worker":"smash-wed","syncKey":{"set":true,"length":64,"fingerprint":"…"}}`.
   The length and fingerprint must match what `setupSyncKey()` logs; `"set":false` means the
   secret isn't visible at run time (it belongs under Settings → Variables and Secrets, not
   under Settings → Build). Then try
   `?action=week&date=<an event date>`; it should return that week's JSON.
5. **Switch the site over.** Set `WORKER_URL` near the top of the
   `<script>` in `site/index.html` to the Worker's URL and push to `main`.
   To go back, set it to `''`. For a single visit, add `?direct=1` to the
   page URL to bypass the Worker.

`GAS_URL` in `wrangler.jsonc` must match the Apps Script deployment URL, the
same one as `GAS_URL` in `site/index.html`. If you ever make a brand-new
deployment rather than a new version of the existing one, update both.

## Free-plan limits

The Workers Free plan needs no card and never bills. Going over a daily limit
makes requests fail until 00:00 UTC; it doesn't charge.

| Resource | Free per day | A league night |
| --- | --- | --- |
| Worker requests | 100,000 | ~30 phones polling every 10 s for 3 h ≈ 32k |
| Durable Object requests | 100,000 | about the same |
| CPU per request | 10 ms | ~1 ms (`npm test` checks the heaviest doubles call stays under 10 ms) |
| Storage | 5 GB | well under 1 MB per event date |

## Local development

```sh
cd worker
npm install
npm test                 # Node tests: src/core.js + src/meta.js against a fake Apps Script
printf 'SYNC_KEY=dev\n' > .dev.vars
npx wrangler dev --var GAS_URL:<an Apps Script URL or a local fake>
```

The site's `?mock=1` sandbox runs the same `site/week-engine.js`, so
game-day rule changes can be tried there first. When changing a rule, change
it in `gas/Code.gs` and `site/week-engine.js` (or `site/relay-rules.js` for
the doubles rules) together.
