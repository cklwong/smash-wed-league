/**
 * Dev-only mock of the Apps Script backend (gas/Code.gs), for experimenting
 * with the This week match desk without a real spreadsheet/deployment.
 *
 * Enable by loading the site with ?mock=1 in the URL - index.html's <head>
 * conditionally document.writes this script before the page's own inline
 * script runs, so every fetch() call the app makes (rankings, week, join,
 * check-in, start/record/edit/cancel match, ...) is intercepted here instead
 * of hitting script.google.com. Nothing changes for normal (non-?mock) loads.
 *
 * Each week's game-day rules come from site/week-engine.js - the same engine
 * the Cloudflare Worker (worker/) runs - so this sandbox exercises them; this
 * file only adds the seed data, canned past weeks, and the admin actions.
 *
 * State lives only in memory - reload the page to reset to the seed below.
 * Any PIN/passphrase is accepted (this is a sandbox, not a security check).
 */
(function () {
  const key = (n) => (n || '').toString().trim().toLowerCase();
  const isGuestLabel = (n) => /^Guest[A-D]\d*$/i.test((n || '').toString().trim());
  const uid = () => Math.random().toString(36).slice(2, 10);
  const LETTERS = ['A', 'B', 'C', 'D'];
  // Always >= 2 pools: <=16 -> 2, <=21 -> 3, else 4 (poolSplitSizes() in
  // gas/Code.gs) - for the canned past weeks below.
  function splitSizes(n) {
    const k = n <= 16 ? 2 : (n <= 21 ? 3 : 4);
    const base = Math.floor(n / k), extra = n % k;
    return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  }

  // Deterministic PRNG so reloading the page (without ?fresh) gives the same
  // seed data every time - makes it easier to talk about "Player 01" reliably.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(20260715);

  // ---- seed roster: 24 confirmed (fills the 24-cap exactly) + 2 waitlisted ----
  // Placeholder names only - deliberately not drawn from any real roster.
  const NAMES = [
    'Player 01', 'Player 02', 'Player 03', 'Player 04', 'Player 05', 'Player 06', 'Player 07',
    'Player 08', 'Player 09', 'Player 10', 'Player 11', 'Player 12', 'Player 13',
    'Player 14', 'Player 15', 'Player 16', 'Player 17', 'Player 18', 'Player 19',
    'Player 20', 'Player 21', 'Player 22', 'Player 23', 'Player 24',
    'Player 25', 'Player 26' // last 2 land on the waitlist (CAP = 24)
  ];
  const RANKINGS = NAMES.map((name, i) => {
    const trend = [];
    const weeks = 3 + Math.floor(rand() * 3); // 3-5 weeks of history
    for (let w = weeks; w >= 1; w--) {
      const d = new Date(Date.now() - w * 7 * 86400000);
      const base = 24 - i * 0.5;
      const pool = LETTERS[Math.floor(rand() * LETTERS.length)] + (1 + Math.floor(rand() * 6));
      trend.push({ date: d.toISOString().slice(0, 10), score: Math.round((base + (rand() * 8 - 4)) * 10) / 10, pool });
    }
    return { name, rank: i + 1, avg: Math.round((24 - i * 0.55) * 100) / 100, trend };
  });
  // Two players last played ~3 months ago, so the Standings page's
  // "haven't played in 2 months" hiding has someone to hide.
  ['Player 07', 'Player 19'].forEach(n => {
    const r = RANKINGS.find(x => x.name === n);
    r.trend.forEach(t => {
      const d = new Date(t.date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 12 * 7);
      t.date = d.toISOString().slice(0, 10);
    });
  });

  // Every date's live state (site/week-engine.js - the same engine the
  // Cloudflare Worker runs, so the sandbox exercises its rules). Only the
  // fixed "This week" session and weeks created with createWeek exist;
  // past weeks are canned below.
  const ENGINE = createWeekEngine(window);
  const ST = {};
  const BANS = {}; // lowercased name -> {name, until} - mirrors PLAYER_BANS in gas/Code.gs
  const CREATED_WEEKS = []; // ISO dates created via the mock createWeek() action this session
  let SHEET_EDITORS = []; // mirrors the SHEET_EDITORS script property
  function sessionDate() { return (typeof getSessionDateISO === 'function') ? getSessionDateISO() : ''; }
  function weekState(date) {
    if (!ST[date]) {
      const session = date === sessionDate();
      const exists = session || CREATED_WEEKS.includes(date);
      const signups = session
        ? NAMES.map((name, i) => ({ name, checkedIn: i < NAMES.length - 2, noShow: false })) // the waitlist isn't "at the venue"
        : [];
      ST[date] = ENGINE.fromView({ date, exists, signups, pools: [], live: { matches: [], checkins: {}, walkins: [] } }, { bans: {} });
      // ?doubles=1 starts the sandbox with tonight already set up as a team
      // doubles night (otherwise switch it on the Admin tab like the real site).
      if (session && STATE_FLAGS.doubles) ST[date].event = ENGINE.relayEvent('exhibition');
    }
    const st = ST[date];
    st.ranks = RANKINGS.map((r) => r.name); // seeding order, kept current across renames
    st.bans = BANS;
    return st;
  }
  const qs = new URLSearchParams(location.search);
  const STATE_FLAGS = { doubles: qs.get('doubles') === '1' };

  // Mirrors computeNextWeek()/peekNextWeekDate() in gas/Code.gs: reports
  // what the next date would be - one week after the mock's fixed "This
  // week" session.
  function peekNextWeekDate() {
    const base = sessionDate();
    if (!base) return { ok: false, error: 'mock: no session date available' };
    const d = new Date(base + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    return { ok: true, date: d.toISOString().slice(0, 10) };
  }

  // Mirrors createWeek() in gas/Code.gs: there's no real spreadsheet here to
  // duplicate a tab in, so this just echoes back the (possibly overridden)
  // date the site confirmed, and remembers it so weekDates() (which drives
  // the Join page) includes it right away.
  function createWeek(dateISO) {
    const peek = peekNextWeekDate();
    if (!peek.ok) return peek;
    const date = dateISO || peek.date;
    if (!CREATED_WEEKS.includes(date)) CREATED_WEEKS.push(date);
    if (ST[date]) ST[date].exists = true;
    return { ok: true, date };
  }

  // Mirrors listWeekDates() in gas/Code.gs: the mock's fixed "This week"
  // session plus any weeks created via the mock createWeek() action.
  function weekDates() {
    const base = sessionDate();
    const dates = base ? [base] : [];
    CREATED_WEEKS.forEach((d) => { if (!dates.includes(d)) dates.push(d); });
    const formats = {};
    dates.forEach((d) => { const st = weekState(d); if (ENGINE.isRelay(st)) formats[d] = { format: 'relay', rpMode: st.event.rpMode }; });
    return { dates: dates.sort(), formats };
  }

  // Mirrors renamePlayer() in gas/Code.gs: renames a player in RANKINGS (the
  // season roster) plus wherever they appear in each week's signups/pools,
  // and optionally stashes an email on the ranking entry (not sent anywhere
  // in the sandbox - MailApp doesn't exist here).
  function renamePlayer(oldName, newName, email) {
    if (!oldName || !newName) return { ok: false, error: 'Both the current and new name are required.' };
    const r = RANKINGS.find((p) => key(p.name) === key(oldName));
    if (!r) return { ok: false, error: 'No player named "' + oldName + '" found in the season standings.' };
    r.name = newName;
    if (email) r.email = email;
    let tabsUpdated = 0;
    Object.values(ST).forEach((st) => {
      let hit = false;
      st.signups.forEach((s) => { if (key(s.name) === key(oldName)) { s.name = newName; hit = true; } });
      Object.keys(st.pools).forEach((L) => {
        st.pools[L] = st.pools[L].map((n) => (key(n) === key(oldName) ? newName : n));
      });
      if (hit) tabsUpdated++;
    });
    return { ok: true, tabsUpdated };
  }

  // Mirrors listPlayerEmails() in gas/Code.gs, for the rename tool's dropdown.
  function listPlayerEmails() {
    const emails = {};
    RANKINGS.forEach((p) => { if (p.email) emails[p.name] = p.email; });
    return { ok: true, emails };
  }

  // Mirrors noShowSummary() in gas/Code.gs - the sandbox only has one mutable
  // week (past weeks are canned with no no-shows), so this just reflects
  // tonight's signups.
  function noShowSummary() {
    const dateISO = sessionDate();
    const players = weekState(dateISO).signups.filter((s) => s.noShow).map((s) => ({ name: s.name, count: 1, dates: dateISO ? [dateISO] : [] }));
    players.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { ok: true, players };
  }

  // Mirrors banPlayer()/unbanPlayer()/listBans() in gas/Code.gs.
  function banPlayer(name, until) {
    name = (name || '').trim();
    until = (until || '').trim();
    if (!name) return { ok: false, error: 'Player name is required.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: 'Ban end date must be YYYY-MM-DD.' };
    BANS[key(name)] = { name, until };
    return { ok: true };
  }
  function unbanPlayer(name) {
    delete BANS[key(name)];
    return { ok: true };
  }
  function listBans() {
    const today = new Date().toISOString().slice(0, 10);
    const bans = Object.values(BANS).filter((b) => b.until >= today)
      .sort((a, b) => a.until.localeCompare(b.until));
    return { ok: true, bans };
  }

  function getWeek(date) {
    const week = ENGINE.toView(weekState(date));
    week.now = Date.now();
    return week;
  }

  // ---- Past weeks: canned, fully-scored sessions for the Past weeks tab ----
  // (Mirrors what finalized weeks look like: every pair in every drawn pool
  // has both mirrored grid cells filled.)
  function pastWednesdays(n) {
    const base = (typeof getSessionDateISO === 'function') ? getSessionDateISO() : new Date().toISOString().slice(0, 10);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const d = new Date(base + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - 7 * i);
      out.push(d.toISOString().slice(0, 10));
    }
    return out; // most recent first, like the real backend's weeks list
  }

  let PAST_WEEKS = null;
  function pastWeeks() {
    if (PAST_WEEKS) return PAST_WEEKS;
    PAST_WEEKS = {};
    const prand = mulberry32(42);
    pastWednesdays(2).forEach((dateISO, wi) => {
      const count = wi === 0 ? 18 : 14; // one 3-pool week, one 2-pool week
      const names = NAMES.slice(0, count);
      const sizes = splitSizes(count);
      const pools = [];
      let pos = 0;
      sizes.forEach((size, pi) => {
        const members = names.slice(pos, pos + size);
        pos += size;
        const grid = Array.from({ length: size }, () => Array(size).fill(''));
        for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) {
          const iWins = prand() < 0.5 + (j - i) * 0.06; // better seeds win a bit more often
          const loser = 10 + Math.floor(prand() * 10);
          grid[i][j] = iWins ? 21 : loser;
          grid[j][i] = iWins ? loser : 21;
        }
        pools.push({
          label: LETTERS[pi], drawn: true,
          players: members.map((n) => ({ name: n, gw: 0, gl: 0, ptsWL: '', score: '', rank: '', rankPts: '' })),
          grid
        });
      });
      PAST_WEEKS[dateISO] = {
        date: dateISO, exists: true, hasScores: true,
        signups: names.map((n) => ({ name: n, checkedIn: true, noShow: false })),
        pools,
        live: { matches: [], checkins: {} },
        now: Date.now()
      };
    });
    return PAST_WEEKS;
  }

  // Mirrors getHeadToHead() in gas/Code.gs: scans every drawn pool grid this
  // player appears in over the last 6 weeks (canned past weeks, plus
  // tonight's live pools once scores exist) and tallies a record + individual
  // games per opponent within that window.
  const H2H_WEEK_WINDOW = 6;
  function headToHead(name) {
    const k = key(name);
    const totals = {};
    const weeks = Object.values(pastWeeks());
    const tonight = getWeek(sessionDate());
    if (tonight.pools.length) weeks.push(tonight);
    weeks.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0)); // most-recent-first
    weeks.slice(0, H2H_WEEK_WINDOW).forEach((week) => {
      (week.pools || []).forEach((p) => {
        if (!p.drawn) return;
        const idx = p.players.findIndex((pl) => key(pl.name) === k);
        if (idx === -1) return;
        for (let j = 0; j < p.players.length; j++) {
          if (j === idx) continue;
          const opp = p.players[j];
          if (isGuestLabel(opp.name)) continue;
          const a = p.grid[idx][j], b = p.grid[j][idx];
          if (typeof a !== 'number' || typeof b !== 'number') continue;
          const oppKey = key(opp.name);
          if (!totals[oppKey]) totals[oppKey] = { name: opp.name.trim(), wins: 0, losses: 0, matches: [] };
          const won = a > b;
          if (won) totals[oppKey].wins++; else totals[oppKey].losses++;
          totals[oppKey].matches.push({ date: week.date, scoreFor: a, scoreAgainst: b, won });
        }
      });
    });
    const opponents = Object.values(totals).map((o) => {
      o.matches.sort((m1, m2) => (m2.date < m1.date ? -1 : m2.date > m1.date ? 1 : 0)); // most-recent-first
      return o;
    }).sort((x, y) => (y.wins + y.losses) - (x.wins + x.losses) || x.name.localeCompare(y.name));
    return { opponents };
  }

  function handlePost(body) {
    if (ENGINE.ACTIONS.includes(body.action)) {
      // Same as the Worker: the match id is minted before the action runs,
      // so the backend and every device agree on it.
      if (body.action === 'startMatch' && !body.id) body.id = uid();
      return ENGINE.apply(weekState(body.date), body, Date.now());
    }
    switch (body.action) {
      case 'getpin': return { ok: true, pin: '123456' }; // dev sandbox: any passphrase works
      case 'verifyPin': return { ok: true }; // dev sandbox: any PIN works
      case 'finalizeRankings': { // dev sandbox: any passphrase works
        const st = weekState(body.date);
        if (ENGINE.isRelay(st) && st.event.rpMode !== 'ranked') return { ok: true, exhibition: true, date: body.date };
        return { ok: true, finalized: true, date: body.date, updated: RANKINGS.length, added: [], skipped: [] };
      }
      case 'resetWeek': return ENGINE.resetWeek(weekState(body.date));
      case 'setEventFormat': return body.date ? ENGINE.setEventFormat(weekState(body.date), body) : { ok: false, error: 'Missing date.' };
      case 'syncReload': return { ok: true }; // the Worker's "Reload from the sheet" - nothing to reload here
      case 'createWeek': return createWeek(body.date);
      case 'peekNextWeekDate': return peekNextWeekDate();
      case 'renamePlayer': return renamePlayer(body.oldName, body.newName, body.email);
      case 'listPlayerEmails': return listPlayerEmails();
      case 'noShowSummary': return noShowSummary();
      case 'banPlayer': return banPlayer(body.name, body.until);
      case 'unbanPlayer': return unbanPlayer(body.name);
      case 'listBans': return listBans();
      case 'getSheetEditors': return { ok: true, emails: SHEET_EDITORS };
      case 'setSheetEditors': { // mirrors setSheetEditors() in gas/Code.gs (no real tabs to protect here)
        const list = String(body.emails || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
        if (bad.length) return { ok: false, error: 'Not a valid email: ' + bad.join(', ') };
        SHEET_EDITORS = [...new Map(list.map((e) => [key(e), e])).values()];
        return { ok: true, emails: SHEET_EDITORS, updated: SHEET_EDITORS.length ? 3 : 0, warnings: [] };
      }
      default: return { ok: false, error: 'mock: unhandled action ' + body.action };
    }
  }

  // Deep-copy every response like a real HTTP round-trip would: the app
  // mutates its cached week (optimistic updates), and handing out live
  // references would let those mutations bleed into this mock's state.
  const jsonResponse = (obj) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(obj)) });

  window.fetch = async function (url, opts) {
    try {
      const isPost = opts && (opts.method || 'GET').toUpperCase() === 'POST';
      if (!isPost) {
        const qs = String(url).split('?')[1] || '';
        const action = new URLSearchParams(qs).get('action');
        if (action === 'rankings') return jsonResponse({ players: RANKINGS, weeks: Object.keys(pastWeeks()) });
        if (action === 'week') {
          const date = new URLSearchParams(qs).get('date');
          return jsonResponse(pastWeeks()[date] || getWeek(date));
        }
        if (action === 'headtohead') return jsonResponse(headToHead(new URLSearchParams(qs).get('name')));
        if (action === 'weekDates') return jsonResponse(weekDates());
        return jsonResponse({ error: 'mock: unknown GET action ' + action });
      }
      const body = JSON.parse((opts && opts.body) || '{}');
      return jsonResponse(handlePost(body));
    } catch (err) {
      console.error('[mock-backend]', err);
      return jsonResponse({ ok: false, error: String(err) });
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    const badge = document.createElement('div');
    badge.textContent = 'MOCK BACKEND — data is local only, resets on reload';
    badge.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999;background:#8A5A15;color:#fff;'
      + 'font:600 12px/1 -apple-system,sans-serif;text-align:center;padding:6px;letter-spacing:.03em;';
    document.body.appendChild(badge);
  });

  window.__MOCK_STATE = ST; // console access to each date's sandbox "sheet" (e.g. inspect grids for the 'p' marker)

  console.log('%c[mock-backend] active — network calls to Apps Script are intercepted.', 'color:#2F7D52;font-weight:bold');
  console.log('[mock-backend] seed: 24 confirmed + 2 waitlisted, pools not drawn yet. Any PIN works for Generate pools.');
})();
