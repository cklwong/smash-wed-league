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
 * State lives only in memory - reload the page to reset to the seed below.
 * Any PIN/passphrase is accepted (this is a sandbox, not a security check).
 */
(function () {
  const key = (n) => (n || '').toString().trim().toLowerCase();
  const isGuestLabel = (n) => /^Guest[A-D]\d*$/i.test((n || '').toString().trim());
  const uid = () => Math.random().toString(36).slice(2, 10);
  const CAPACITY = { A: 9, B: 8, C: 7, D: 7 };
  const LETTERS = ['A', 'B', 'C', 'D'];

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

  function rankFor(name) {
    const k = key(name);
    let prefixHit = null, hits = 0;
    for (const r of RANKINGS) {
      const rk = key(r.name);
      if (rk === k) return r.rank;
      if (rk.indexOf(k + ' ') === 0) { prefixHit = r; hits++; }
    }
    return hits === 1 ? prefixHit.rank : 9999;
  }

  const STATE = {
    signups: NAMES.map((name) => ({ name, checkedIn: true, noShow: false })),
    drawn: false,
    pools: {},   // letter -> [names / seat labels]
    grids: {},   // letter -> NxN score matrix
    guestMap: {},// lowercased no-show name -> the guest label covering their seat
    live: { matches: [], checkins: {} }
  };
  STATE.signups[STATE.signups.length - 1].checkedIn = false; // waitlist isn't "at the venue"
  STATE.signups[STATE.signups.length - 2].checkedIn = false;

  // Always >= 2 pools: <=16 -> 2, <=21 -> 3, else 4. Extras to earlier pools.
  // (Mirrors poolSplitSizes() in gas/Code.gs and site/index.html.)
  function splitSizes(n) {
    const k = n <= 16 ? 2 : (n <= 21 ? 3 : 4);
    const base = Math.floor(n / k), extra = n % k;
    return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
  }

  function findSlot(name) {
    const k = key(name);
    for (const L of Object.keys(STATE.pools)) {
      const i = STATE.pools[L].findIndex((n) => key(n) === k);
      if (i >= 0) return { L, i };
    }
    return null;
  }
  function filled(v) { return v !== '' && v !== null && v !== undefined; }
  // In-progress marker startMatch writes into a game's top-right grid cell
  // (mirrors isInProgressMarker in gas/Code.gs) - never a score.
  function isMarker(v) { return typeof v === 'string' && v.trim().toLowerCase() === 'p'; }
  function isScore(v) { return filled(v) && !isMarker(v); }
  // The one cell that carries a pair's marker: row of the lower index.
  function markerCell(slotA, slotB) {
    const top = slotA.i < slotB.i ? slotA : slotB;
    const other = top === slotA ? slotB : slotA;
    return { L: top.L, r: top.i, c: other.i };
  }
  function clearMarker(slotA, slotB) {
    const m = markerCell(slotA, slotB);
    if (isMarker(STATE.grids[m.L][m.r][m.c])) STATE.grids[m.L][m.r][m.c] = '';
  }
  function slotHasScores(L, i) {
    const n = STATE.pools[L].length;
    for (let c = 0; c < n; c++) if (filled(STATE.grids[L][i][c])) return true;
    for (let r = 0; r < n; r++) if (filled(STATE.grids[L][r][i])) return true;
    return false;
  }
  function hasAnyScoresAnywhere() {
    return Object.keys(STATE.grids).some((L) => STATE.grids[L].some((row) => row.some(isScore)));
  }

  function generatePools(padGuests, redraw) {
    const eligible = STATE.signups.slice(0, 24).filter((s) => !s.noShow);
    if (eligible.length < 12) {
      return { ok: false, error: 'Only ' + eligible.length + ' eligible players — the session is cancelled below 12.' };
    }
    if (STATE.drawn) {
      if (!redraw) return { ok: false, error: 'Pools are already drawn.' };
      if (hasAnyScoresAnywhere()) return { ok: false, error: 'Games have started — pools can no longer be redrawn.' };
    }
    const sorted = eligible
      .map((s, i) => ({ name: s.name, rank: rankFor(s.name), idx: i }))
      .sort((a, b) => a.rank - b.rank || a.idx - b.idx);
    const sizes = splitSizes(sorted.length);
    const letters = LETTERS.slice(0, sizes.length);
    const pad = new Set((padGuests || []).map((x) => String(x).toUpperCase()));

    const pools = {}; let pos = 0;
    letters.forEach((L, i) => {
      const members = sorted.slice(pos, pos + sizes[i]).map((p) => p.name);
      pos += sizes[i];
      if (pad.has(L) && members.length < CAPACITY[L]) members.push('Guest' + L);
      pools[L] = members;
    });

    STATE.pools = pools;
    STATE.grids = {};
    letters.forEach((L) => {
      const n = pools[L].length;
      STATE.grids[L] = Array.from({ length: n }, () => Array(n).fill(''));
    });
    STATE.guestMap = {};
    STATE.live.matches = [];
    STATE.drawn = true;
    return { ok: true, pools: letters.map((L) => ({ label: L, players: pools[L] })) };
  }

  function checkin(name) {
    const s = STATE.signups.find((x) => key(x.name) === key(name));
    if (!s) return { ok: false, error: 'Signup not found for ' + name };
    let seated = true;
    if (s.noShow && STATE.drawn) {
      const guestLabel = STATE.guestMap[key(name)];
      if (guestLabel) {
        const slot = findSlot(guestLabel);
        if (slot) {
          if (slotHasScores(slot.L, slot.i)) {
            return { ok: false, error: guestLabel + ' has already played — ' + name + ' cannot rejoin tonight.' };
          }
          STATE.pools[slot.L][slot.i] = s.name;
        } else {
          seated = false;
        }
        delete STATE.guestMap[key(name)];
      } else {
        seated = false;
      }
    }
    s.checkedIn = true; s.noShow = false;
    STATE.live.checkins[key(name)] = Date.now();
    return { ok: true, seated };
  }

  function noshow(name) {
    const s = STATE.signups.find((x) => key(x.name) === key(name));
    if (!s) return { ok: false, error: 'Signup not found for ' + name };
    if (s.noShow) return { ok: true };
    const slot = findSlot(s.name);
    if (slot) {
      let n = 1;
      const re = new RegExp('^Guest' + slot.L + '(\\d+)$', 'i');
      STATE.pools[slot.L].forEach((v) => { const m = (v || '').match(re); if (m && Number(m[1]) >= n) n = Number(m[1]) + 1; });
      const label = 'Guest' + slot.L + n;
      STATE.pools[slot.L][slot.i] = label;
      STATE.guestMap[key(s.name)] = label;
    }
    s.noShow = true; s.checkedIn = false;
    delete STATE.live.checkins[key(name)];
    return { ok: true };
  }

  function clearstatus(name) {
    const s = STATE.signups.find((x) => key(x.name) === key(name));
    if (!s) return { ok: false, error: 'Signup not found for ' + name };
    if (s.noShow) {
      const guestLabel = STATE.guestMap[key(name)];
      if (guestLabel) {
        const slot = findSlot(guestLabel);
        if (slot) {
          if (slotHasScores(slot.L, slot.i)) {
            return { ok: false, error: guestLabel + ' has already played — the no-show cannot be undone.' };
          }
          STATE.pools[slot.L][slot.i] = s.name;
        }
        delete STATE.guestMap[key(name)];
      }
    }
    s.checkedIn = false; s.noShow = false;
    return { ok: true };
  }

  function join(name, contact) {
    if (!name) return { ok: false, error: 'Missing name' };
    if (STATE.signups.some((s) => key(s.name) === key(name))) return { ok: false, error: 'Already signed up' };
    STATE.signups.push({ name, checkedIn: false, noShow: false });
    return { ok: true, row: STATE.signups.length, position: STATE.signups.length };
  }
  function leave(name) {
    const i = STATE.signups.findIndex((s) => key(s.name) === key(name));
    if (i < 0) return { ok: false, error: 'Signup not found for ' + name };
    STATE.signups.splice(i, 1);
    return { ok: true };
  }

  function validateScores(scoreA, scoreB) {
    const a = Number(scoreA), b = Number(scoreB);
    if (!isFinite(a) || !isFinite(b) || a % 1 !== 0 || b % 1 !== 0 || a < 0 || b < 0) {
      return { ok: false, error: 'Scores must be whole numbers, 0 or more.' };
    }
    if (a === b) return { ok: false, error: 'A game cannot end in a tie.' };
    return { ok: true, a, b };
  }

  // Guest games write a minimal 1-0 grid result for the real player (their
  // actual score is kept as the match's infoScore instead); guest-vs-guest
  // games never touch the grid at all.
  function writePairScore(nameA, nameB, scoreA, scoreB) {
    const a = findSlot(nameA), b = findSlot(nameB);
    if (!a) return { ok: false, error: nameA + ' no longer holds a pool seat.' };
    if (!b) return { ok: false, error: nameB + ' no longer holds a pool seat.' };
    if (a.L !== b.L) return { ok: false, error: 'Those players are in different pools.' };
    const guestA = isGuestLabel(nameA), guestB = isGuestLabel(nameB);
    if (guestA && guestB) {
      clearMarker(a, b); // no score lands in the grid, so the marker must go
      return { ok: true, infoOnly: true };
    }
    let recA = scoreA, recB = scoreB;
    if (guestA) { recA = 0; recB = 1; }
    if (guestB) { recA = 1; recB = 0; }
    STATE.grids[a.L][a.i][b.i] = recA;
    STATE.grids[b.L][b.i][a.i] = recB;
    return { ok: true, infoOnly: guestA || guestB };
  }

  function startMatch(a, b, guestNames, clientId) {
    if (!STATE.drawn) return { ok: false, error: 'Pools have not been drawn yet.' };
    const slotA = findSlot(a), slotB = findSlot(b);
    if (!slotA) return { ok: false, error: (a || '?') + ' does not hold a pool seat.' };
    if (!slotB) return { ok: false, error: (b || '?') + ' does not hold a pool seat.' };
    if (slotA.L !== slotB.L) return { ok: false, error: 'Those players are in different pools.' };
    if (slotA.i === slotB.i) return { ok: false, error: 'Pick two different players.' };
    if (isScore(STATE.grids[slotA.L][slotA.i][slotB.i]) || isScore(STATE.grids[slotB.L][slotB.i][slotA.i])) {
      return { ok: false, error: 'That game already has a score.' };
    }
    const busy = STATE.live.matches.find((m) => !m.finishedAt && (key(m.a) === key(a) || key(m.a) === key(b) || key(m.b) === key(a) || key(m.b) === key(b)));
    if (busy) return { ok: false, error: busy.a + ' vs ' + busy.b + ' is still on court — record or cancel it first.' };

    const id = (typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64) ? clientId : uid();
    const match = { id, pool: slotA.L, a: STATE.pools[slotA.L][slotA.i], b: STATE.pools[slotB.L][slotB.i], startedAt: Date.now() };
    const mc = markerCell(slotA, slotB);
    STATE.grids[mc.L][mc.r][mc.c] = 'p'; // in-progress marker, cleared/overwritten on record or cancel
    const gn = {};
    [match.a, match.b].forEach((n) => { if (isGuestLabel(n) && guestNames && guestNames[n]) gn[n] = String(guestNames[n]).trim().slice(0, 40); });
    if (Object.keys(gn).length) match.guestNames = gn;
    STATE.live.matches.push(match);
    return { ok: true, match };
  }

  function recordScore(matchId, scoreA, scoreB) {
    const match = STATE.live.matches.find((m) => m.id === matchId);
    if (!match) return { ok: false, error: 'Match not found — refresh and try again.' };
    if (match.finishedAt) return { ok: false, error: 'This match was already recorded.' };
    const v = validateScores(scoreA, scoreB);
    if (!v.ok) return v;
    const w = writePairScore(match.a, match.b, v.a, v.b);
    if (!w.ok) return w;
    match.finishedAt = Date.now(); // starts both players' waiting timers
    if (w.infoOnly) match.infoScore = [v.a, v.b];
    return { ok: true };
  }

  function editScore(a, b, scoreA, scoreB, matchId) {
    const v = validateScores(scoreA, scoreB);
    if (!v.ok) return v;
    if (!isGuestLabel(a) && !isGuestLabel(b)) {
      const slotA = findSlot(a), slotB = findSlot(b);
      if (!slotA) return { ok: false, error: (a || '?') + ' does not hold a pool seat.' };
      if (!slotB) return { ok: false, error: (b || '?') + ' does not hold a pool seat.' };
      if (slotA.L !== slotB.L) return { ok: false, error: 'Those players are in different pools.' };
      STATE.grids[slotA.L][slotA.i][slotB.i] = v.a;
      STATE.grids[slotB.L][slotB.i][slotA.i] = v.b;
      return { ok: true };
    }
    const keyA = key(a), keyB = key(b);
    let match = null;
    STATE.live.matches.forEach((m) => {
      if (!m.finishedAt) return;
      const want = matchId ? m.id === matchId
        : ((key(m.a) === keyA && key(m.b) === keyB) || (key(m.a) === keyB && key(m.b) === keyA));
      if (want && (!match || m.finishedAt > match.finishedAt)) match = m;
    });
    if (!match) return { ok: false, error: 'No recorded match found for that guest game.' };
    match.infoScore = key(match.a) === keyA ? [v.a, v.b] : [v.b, v.a];
    return { ok: true };
  }

  function cancelMatch(matchId) {
    const i = STATE.live.matches.findIndex((m) => m.id === matchId);
    if (i < 0) return { ok: false, error: 'Match not found — it may already be cancelled.' };
    if (STATE.live.matches[i].finishedAt) return { ok: false, error: 'That match already finished — use Edit instead.' };
    const m = STATE.live.matches[i];
    const slotA = findSlot(m.a), slotB = findSlot(m.b);
    if (slotA && slotB && slotA.L === slotB.L) clearMarker(slotA, slotB);
    STATE.live.matches.splice(i, 1);
    return { ok: true };
  }

  function getWeek() {
    const pools = STATE.drawn
      ? Object.keys(STATE.pools).map((L) => ({
          label: L, drawn: true,
          players: STATE.pools[L].map((n) => ({ name: n, gw: 0, gl: 0, ptsWL: '', score: '', rank: '', rankPts: '' })),
          // Like gas/Code.gs getWeek: the payload's grid contract is number | ''
          grid: STATE.grids[L].map((row) => row.map((v) => (isMarker(v) ? '' : v)))
        }))
      : [];
    return {
      date: (typeof getSessionDateISO === 'function' ? getSessionDateISO() : ''),
      exists: true,
      hasScores: hasAnyScoresAnywhere(),
      signups: STATE.signups,
      pools,
      live: { matches: STATE.live.matches, checkins: STATE.live.checkins },
      now: Date.now()
    };
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
  // player appears in (canned past weeks, plus tonight's live pools once
  // scores exist) and tallies a season-long record + individual games per opponent.
  function headToHead(name) {
    const k = key(name);
    const totals = {};
    const weeks = Object.values(pastWeeks());
    if (STATE.drawn) weeks.push(getWeek());
    weeks.forEach((week) => {
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
    switch (body.action) {
      case 'join': return join(body.name, body.contact);
      case 'leave': return leave(body.name);
      case 'getpin': return { ok: true, pin: '123456' }; // dev sandbox: any passphrase works
      case 'generatePools': return generatePools(body.padGuests, body.redraw);
      case 'checkin': return checkin(body.name);
      case 'noshow': return noshow(body.name);
      case 'clearstatus': return clearstatus(body.name);
      case 'startMatch': return startMatch(body.a, body.b, body.guestNames, body.id);
      case 'recordScore': return recordScore(body.matchId, body.scoreA, body.scoreB);
      case 'editScore': return editScore(body.a, body.b, body.scoreA, body.scoreB, body.matchId);
      case 'cancelMatch': return cancelMatch(body.matchId);
      case 'finalizeRankings': return { ok: true, finalized: true, date: body.date, updated: RANKINGS.length, added: [], skipped: [] }; // dev sandbox: any passphrase works
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
          return jsonResponse(pastWeeks()[date] || getWeek());
        }
        if (action === 'headtohead') return jsonResponse(headToHead(new URLSearchParams(qs).get('name')));
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

  window.__MOCK_STATE = STATE; // console access to the sandbox "sheet" (e.g. inspect grids for the 'p' marker)

  console.log('%c[mock-backend] active — network calls to Apps Script are intercepted.', 'color:#2F7D52;font-weight:bold');
  console.log('[mock-backend] seed: 24 confirmed + 2 waitlisted, pools not drawn yet. Any PIN works for Generate pools.');
})();
