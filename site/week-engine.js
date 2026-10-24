/**
 * One event date's live state and every game-day action on it, in plain
 * JavaScript - the same rules gas/Code.gs applies to the spreadsheet, ported
 * so they can run without a round-trip to Apps Script.
 *
 * Used by:
 *   - the Cloudflare Worker (worker/src/event.js): answers check-in, the
 *     match desk, doubles games and signups instantly from its own copy of
 *     the week, then replays each action against Code.gs in the background
 *     (Code.gs stays the source of truth - every reply from it replaces this
 *     copy, see worker/README.md);
 *   - the ?mock=1 sandbox (site/mock-backend.js), so the sandbox exercises
 *     exactly the code the Worker runs.
 *
 * Every action mirrors the same-named function in gas/Code.gs (named in each
 * comment) - keep them in sync. Errors use Code.gs's wording, since the site
 * shows them as-is.
 *
 * State (`st`), one per date:
 *   { date, exists,
 *     signups: [{name, checkedIn, noShow}],          // column A/B, in order
 *     pools: {A: [seat names], ...},                 // drawn pools only (column E)
 *     grids: {A: [[number | '' | 'p']], ...},       // score grids, 'p' = on court
 *     guestMap: {lowercased no-show: 'GuestA1'},     // NOSHOW_GUEST_COL
 *     live: {matches: [], checkins: {}, walkins: {}},// LIVE_<date> property
 *     event: null | {format:'relay', rpMode, cap, teamBonus, teamCounts},
 *     relay: null | {rev, teams, games, guests, requests},  // Doubles tab A1
 *     ranks: [names in standings order],             // pool/team seeding
 *     bans: {lowercased name: {name, until}} }        // PLAYER_BANS
 *
 * Loaded as a classic <script> after relay-rules.js it defines the global
 * createWeekEngine(rules); required/imported it exports it.
 */
function createWeekEngine(R) {
  var CAP = 24;
  var RELAY_CAP = 32;
  var RELAY_TEAM_COUNTS = [4, 6];
  var RELAY_TEAM_BONUS = 2;
  var RELAY_ROUNDS = 2;
  var RELAY_TIEBREAK_ROUND = 3;
  var RELAY_TEAM_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  var POOL_LETTERS = ['A', 'B', 'C', 'D'];
  var POOL_SIZE = { A: 9, B: 8, C: 7, D: 7 }; // POOL_LAYOUT sizes in Code.gs
  var SINGLES_ONLY = ['generatePools', 'startMatch', 'recordScore', 'editScore', 'cancelMatch'];

  function key(n) { return (n == null ? '' : String(n)).trim().toLowerCase(); }
  function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }
  function filled(v) { return v !== '' && v !== null && v !== undefined; }
  function isMarker(v) { return typeof v === 'string' && v.trim().toLowerCase() === 'p'; }
  function isScore(v) { return filled(v) && !isMarker(v); }
  function isGuestLabel(n) { return /^Guest[A-D]\d*$/i.test(String(n || '').trim()); }
  function emptyGrid(n) {
    var g = [];
    for (var i = 0; i < n; i++) { var row = []; for (var j = 0; j < n; j++) row.push(''); g.push(row); }
    return g;
  }

  // ---- state <-> the site's week payload ----

  // A fresh state from Code.gs's computeWeek() payload plus what that payload
  // leaves out (syncSnapshot in Code.gs): which grid cells hold the on-court
  // marker, the no-show guest swaps, seeding order and bans.
  function fromView(view, extra) {
    extra = extra || {};
    var st = {
      date: view.date,
      exists: !!view.exists,
      signups: (view.signups || []).map(function (s) { return { name: s.name, checkedIn: !!s.checkedIn, noShow: !!s.noShow }; }),
      pools: {},
      grids: {},
      guestMap: clone(extra.guestMap) || {},
      live: { matches: [], checkins: {}, walkins: {} },
      event: view.event ? clone(view.event) : null,
      relay: view.relay ? clone(view.relay) : null,
      ranks: (extra.ranks || []).slice(),
      bans: clone(extra.bans) || {}
    };
    (view.pools || []).forEach(function (p) {
      if (!p.drawn) return;
      st.pools[p.label] = p.players.map(function (pl) { return pl.name; });
      st.grids[p.label] = (p.grid && p.grid.length ? clone(p.grid) : emptyGrid(POOL_SIZE[p.label] || p.players.length));
    });
    (extra.markers || []).forEach(function (m) {
      var g = st.grids[m[0]];
      if (g && g[m[1]] && !isScore(g[m[1]][m[2]])) g[m[1]][m[2]] = 'p';
    });
    if (view.live) {
      st.live.matches = clone(view.live.matches) || [];
      st.live.checkins = clone(view.live.checkins) || {};
      (view.live.walkins || []).forEach(function (k) { st.live.walkins[key(k)] = true; });
    }
    if (st.relay) normalizeRelay(st.relay);
    return st;
  }

  // The site's GET ?action=week payload (same shape as Code.gs computeWeek).
  function toView(st) {
    var pools = POOL_LETTERS.filter(function (L) { return st.pools[L]; }).map(function (L) {
      return {
        label: L, drawn: true,
        players: st.pools[L].map(function (n) { return { name: n, gw: 0, gl: 0, ptsWL: '', rank: '', rankPts: '' }; }),
        grid: st.grids[L].map(function (row) { return row.map(function (v) { return isMarker(v) ? '' : v; }); })
      };
    });
    var week = {
      date: st.date,
      exists: !!st.exists,
      hasScores: hasAnyScores(st),
      signups: st.signups.map(function (s) { return { name: s.name, checkedIn: s.checkedIn, noShow: s.noShow }; }),
      pools: pools
    };
    if (!st.exists) return week;
    week.live = { matches: clone(st.live.matches), checkins: clone(st.live.checkins), walkins: Object.keys(st.live.walkins) };
    if (isRelay(st)) {
      week.event = clone(st.event);
      week.relay = clone(relayState(st));
    }
    return week;
  }

  function normalizeRelay(r) {
    if (!r.teams) r.teams = [];
    if (!r.games) r.games = [];
    if (!r.rev) r.rev = 0;
    return r;
  }

  // ---- shared lookups ----

  function isRelay(st) { return !!(st.event && st.event.format === 'relay'); }
  function capFor(st) { return isRelay(st) ? RELAY_CAP : CAP; }
  function relayEvent(rpMode) {
    return { format: 'relay', rpMode: rpMode === 'ranked' ? 'ranked' : 'exhibition', cap: RELAY_CAP, teamBonus: RELAY_TEAM_BONUS, teamCounts: RELAY_TEAM_COUNTS.slice() };
  }
  function relayState(st) {
    if (!st.relay) st.relay = { rev: 0, teams: [], games: [] };
    return normalizeRelay(st.relay);
  }
  // Code.gs saveRelayState bumps rev on every saved change; the reply
  // always carries the state (updateRelayState).
  function relayReply(st, result) {
    var r = relayState(st);
    if (result.ok !== false) r.rev = (r.rev || 0) + 1;
    result.relay = clone(r);
    return result;
  }
  function findSignupIdx(st, name) {
    var k = key(name);
    for (var i = 0; i < st.signups.length; i++) if (key(st.signups[i].name) === k) return i;
    return -1;
  }
  function findSignup(st, name) { var i = findSignupIdx(st, name); return i < 0 ? null : st.signups[i]; }
  function drawn(st) { return POOL_LETTERS.some(function (L) { return !!st.pools[L]; }); }
  function findSlot(st, name) {
    var k = key(name);
    for (var i = 0; i < POOL_LETTERS.length; i++) {
      var L = POOL_LETTERS[i], seats = st.pools[L];
      if (!seats) continue;
      for (var s = 0; s < seats.length; s++) if (key(seats[s]) === k) return { L: L, i: s };
    }
    return null;
  }
  // Code.gs slotHasScores: anything in the seat's grid row or column
  // (the on-court marker counts too).
  function slotHasScores(st, L, i) {
    var g = st.grids[L];
    for (var c = 0; c < g.length; c++) if (filled(g[i][c])) return true;
    for (var r = 0; r < g.length; r++) if (filled(g[r][i])) return true;
    return false;
  }
  function hasAnyScores(st) {
    return POOL_LETTERS.some(function (L) {
      return st.grids[L] && st.grids[L].some(function (row) { return row.some(isScore); });
    });
  }
  function markerCell(a, b) {
    var top = a.i < b.i ? a : b, other = top === a ? b : a;
    return { L: top.L, r: top.i, c: other.i };
  }
  function clearMarker(st, a, b) {
    var m = markerCell(a, b);
    if (isMarker(st.grids[m.L][m.r][m.c])) st.grids[m.L][m.r][m.c] = '';
  }
  // Code.gs matchNameIndex / rankFor: exact name, else a unique "first name"
  // prefix; unmatched players seed last (9999) in signup order.
  function rankFor(st, name) {
    var k = key(name), prefixHit = -1, hits = 0;
    for (var i = 0; i < st.ranks.length; i++) {
      var rk = key(st.ranks[i]);
      if (rk === k) return i;
      if (rk.indexOf(k + ' ') === 0) { prefixHit = i; hits++; }
    }
    return hits === 1 ? prefixHit : 9999;
  }
  function seeded(st, list) {
    return list.map(function (s, i) { return { name: s.name, rank: rankFor(st, s.name), idx: i }; })
      .sort(function (a, b) { return a.rank - b.rank || a.idx - b.idx; });
  }
  function validateScores(scoreA, scoreB) {
    var a = Number(scoreA), b = Number(scoreB);
    if (!isFinite(a) || !isFinite(b) || a % 1 !== 0 || b % 1 !== 0 || a < 0 || b < 0) {
      return { ok: false, error: 'Scores must be whole numbers, 0 or more.' };
    }
    if (a === b) return { ok: false, error: 'A game cannot end in a tie.' };
    return { ok: true, a: a, b: b };
  }
  function relayNightError() {
    return { ok: false, error: 'This is a team doubles night — run it from the This week page.' };
  }

  // ---- signups (Code.gs addJoin / joinWithPartner / removeJoin) ----

  // Code.gs activeBanFor: a ban covers weeks dated on or before `until`.
  function activeBanFor(st, name) {
    var b = st.bans[key(name)];
    if (!b) return null;
    if (st.date && st.date > b.until) return null;
    return b;
  }
  function addJoin(st, name) {
    name = String(name || '').trim();
    if (!name) return { ok: false, error: 'Missing name' };
    var ban = activeBanFor(st, name);
    if (ban) return { ok: false, error: ban.name + ' is banned from signing up through ' + ban.until + '.' };
    if (findSignup(st, name)) return { ok: false, error: 'Already signed up' };
    st.signups.push({ name: name, checkedIn: false, noShow: false });
    return { ok: true, position: st.signups.length, cap: capFor(st) };
  }
  function setPartnerRequest(st, name, partner, mix) {
    var r = relayState(st), k = key(name);
    r.requests = (r.requests || []).filter(function (q) { return key(q.name) !== k; });
    if (partner) r.requests.push({ name: name, partner: partner });
    else if (mix) r.requests.push({ name: name, partner: '', mix: true });
    r.rev = (r.rev || 0) + 1;
  }
  function join(st, b) {
    var name = String(b.name || '').trim(), partner = String(b.partner || '').trim().slice(0, 40), mix = !!b.mix;
    if (!isRelay(st)) return addJoin(st, name);
    if (!partner && !mix) {
      var had = (relayState(st).requests || []).some(function (q) { return key(q.name) === key(name); });
      var idx = findSignupIdx(st, name);
      if (!had || idx < 0) return addJoin(st, name);
      setPartnerRequest(st, st.signups[idx].name, '');
      return { ok: true, partnerOnly: true, cleared: true, position: idx + 1, cap: capFor(st) };
    }
    if (key(partner) === key(name)) return { ok: false, error: 'Pick someone other than yourself as your partner.' };
    var at = findSignupIdx(st, name), result;
    if (at >= 0) {
      name = st.signups[at].name;
      result = { ok: true, partnerOnly: true, position: at + 1, cap: capFor(st) };
    } else {
      result = addJoin(st, name);
      if (!result.ok) return result;
    }
    setPartnerRequest(st, name, partner, !partner);
    if (partner) result.partner = partner;
    else result.mix = true;
    return result;
  }
  function leave(st, b) {
    var idx = findSignupIdx(st, b.name);
    if (idx < 0) return { ok: false, error: 'Signup not found for ' + b.name };
    var nm = st.signups[idx].name;
    st.signups.splice(idx, 1);
    delete st.guestMap[key(nm)];
    if (isRelay(st) && (relayState(st).requests || []).some(function (q) { return key(q.name) === key(nm); })) setPartnerRequest(st, nm, '');
    return { ok: true };
  }

  // ---- check-in (Code.gs setCheckin / setNoShow / clearStatus) ----

  function checkin(st, b, now) {
    var s = findSignup(st, b.name);
    if (!s) return { ok: false, error: 'Signup not found for ' + b.name };
    var seated = true;
    if (s.noShow && drawn(st)) {
      var label = st.guestMap[key(s.name)];
      if (label) {
        var slot = findSlot(st, label);
        if (slot) {
          if (slotHasScores(st, slot.L, slot.i)) return { ok: false, error: label + ' has already played — ' + s.name + ' cannot rejoin tonight.' };
          st.pools[slot.L][slot.i] = s.name;
        } else {
          seated = false;
        }
        delete st.guestMap[key(s.name)];
      } else {
        seated = false;
      }
    }
    s.checkedIn = true; s.noShow = false;
    st.live.checkins[key(s.name)] = now;
    return { ok: true, seated: seated };
  }
  function noshow(st, b) {
    var s = findSignup(st, b.name);
    if (!s) return { ok: false, error: 'Signup not found for ' + b.name };
    if (s.noShow) return { ok: true };
    var slot = findSlot(st, s.name);
    if (slot) {
      var n = 1, re = new RegExp('^Guest' + slot.L + '(\\d+)$', 'i');
      st.pools[slot.L].forEach(function (v) { var m = String(v || '').match(re); if (m && Number(m[1]) >= n) n = Number(m[1]) + 1; });
      var label = 'Guest' + slot.L + n;
      st.pools[slot.L][slot.i] = label;
      st.guestMap[key(s.name)] = label;
    }
    s.noShow = true; s.checkedIn = false;
    delete st.live.checkins[key(s.name)];
    return { ok: true };
  }
  function clearstatus(st, b) {
    var s = findSignup(st, b.name);
    if (!s) return { ok: false, error: 'Signup not found for ' + b.name };
    if (s.noShow) {
      var label = st.guestMap[key(s.name)];
      if (label) {
        var slot = findSlot(st, label);
        if (slot) {
          if (slotHasScores(st, slot.L, slot.i)) return { ok: false, error: label + ' has already played — the no-show cannot be undone.' };
          st.pools[slot.L][slot.i] = s.name;
        }
        delete st.guestMap[key(s.name)];
      }
    }
    s.checkedIn = false; s.noShow = false;
    delete st.live.checkins[key(s.name)];
    return { ok: true };
  }

  // ---- singles pools and the match desk (Code.gs generatePools,
  // startMatch, recordScore, editScore, cancelMatch) ----

  // Code.gs singlesDrawEligible.
  function singlesDrawEligible(signups) {
    var eligible = signups.slice(0, CAP).filter(function (s) { return !s.noShow; });
    for (var i = CAP; i < signups.length && eligible.length < CAP; i++) {
      if (signups[i].checkedIn && !signups[i].noShow) eligible.push(signups[i]);
    }
    return eligible;
  }
  // Code.gs poolSplitSizes.
  function poolSplitSizes(n) {
    var k = n <= 16 ? 2 : (n <= 21 ? 3 : 4);
    var base = Math.floor(n / k), extra = n % k, out = [];
    for (var i = 0; i < k; i++) out.push(base + (i < extra ? 1 : 0));
    return out;
  }
  function generatePools(st, b) {
    var eligible = singlesDrawEligible(st.signups);
    if (eligible.length < 12) return { ok: false, error: 'Only ' + eligible.length + ' eligible players — the session is cancelled below 12.' };
    if (drawn(st)) {
      if (!b.redraw) return { ok: false, error: 'Pools are already drawn.' };
      if (hasAnyScores(st)) return { ok: false, error: 'Games have started — pools can no longer be redrawn.' };
    }
    var sorted = seeded(st, eligible), sizes = poolSplitSizes(sorted.length);
    var pad = {};
    (b.padGuests || []).forEach(function (L) { pad[String(L).toUpperCase()] = true; });
    var out = [], pos = 0;
    st.pools = {}; st.grids = {};
    for (var i = 0; i < sizes.length; i++) {
      var L = POOL_LETTERS[i];
      var members = sorted.slice(pos, pos + sizes[i]).map(function (p) { return p.name; });
      pos += sizes[i];
      if (pad[L] && members.length < POOL_SIZE[L]) members.push('Guest' + L);
      st.pools[L] = members;
      st.grids[L] = emptyGrid(POOL_SIZE[L]);
      out.push({ label: L, players: members.slice() });
    }
    st.guestMap = {};
    st.live.matches = [];
    return { ok: true, pools: out };
  }
  function findUnfinishedFor(st, name) {
    var k = key(name);
    for (var i = 0; i < st.live.matches.length; i++) {
      var m = st.live.matches[i];
      if (!m.finishedAt && (key(m.a) === k || key(m.b) === k)) return m;
    }
    return null;
  }
  function startMatch(st, b, now) {
    var a = findSlot(st, b.a), c = findSlot(st, b.b);
    if (!a) return { ok: false, error: (b.a || '?') + ' does not hold a pool seat.' };
    if (!c) return { ok: false, error: (b.b || '?') + ' does not hold a pool seat.' };
    if (a.L !== c.L) return { ok: false, error: 'Those players are in different pools.' };
    if (a.i === c.i) return { ok: false, error: 'Pick two different players.' };
    var g = st.grids[a.L];
    if (isScore(g[a.i][c.i]) || isScore(g[c.i][a.i])) return { ok: false, error: 'That game already has a score.' };
    var nameA = st.pools[a.L][a.i], nameB = st.pools[c.L][c.i];
    var busy = findUnfinishedFor(st, nameA) || findUnfinishedFor(st, nameB);
    if (busy) return { ok: false, error: busy.a + ' vs ' + busy.b + ' is still on court — record or cancel it first.' };
    var id = (typeof b.id === 'string' && b.id.length > 0 && b.id.length <= 64) ? b.id : null;
    if (!id) return { ok: false, error: 'Missing match id.' }; // the Worker/mock always fills one in
    var match = { id: id, pool: a.L, a: nameA, b: nameB, startedAt: now };
    [nameA, nameB].forEach(function (n) {
      if (isGuestLabel(n) && b.guestNames && b.guestNames[n]) {
        if (!match.guestNames) match.guestNames = {};
        match.guestNames[n] = String(b.guestNames[n]).trim().slice(0, 40);
      }
    });
    st.live.matches.push(match);
    var mc = markerCell(a, c);
    st.grids[mc.L][mc.r][mc.c] = 'p';
    return { ok: true, match: clone(match) };
  }
  // Code.gs writePairScore: guest games land as 1-0 for the real player,
  // guest-vs-guest games never touch the grid.
  function writePairScore(st, nameA, nameB, sa, sb) {
    var a = findSlot(st, nameA), c = findSlot(st, nameB);
    if (!a) return { ok: false, error: nameA + ' no longer holds a pool seat.' };
    if (!c) return { ok: false, error: nameB + ' no longer holds a pool seat.' };
    if (a.L !== c.L) return { ok: false, error: 'Those players are in different pools.' };
    var gA = isGuestLabel(nameA), gB = isGuestLabel(nameB);
    if (gA && gB) { clearMarker(st, a, c); return { ok: true, infoOnly: true }; }
    var ra = sa, rb = sb;
    if (gA) { ra = 0; rb = 1; }
    if (gB) { ra = 1; rb = 0; }
    st.grids[a.L][a.i][c.i] = ra;
    st.grids[c.L][c.i][a.i] = rb;
    return { ok: true, infoOnly: gA || gB };
  }
  // Code.gs weekIsComplete.
  function weekIsComplete(st) {
    var letters = POOL_LETTERS.filter(function (L) { return st.pools[L]; });
    if (!letters.length) return false;
    return letters.every(function (L) {
      var seats = st.pools[L], g = st.grids[L];
      for (var i = 0; i < seats.length; i++) for (var j = i + 1; j < seats.length; j++) {
        if (isGuestLabel(seats[i]) && isGuestLabel(seats[j])) continue;
        if (typeof g[i][j] !== 'number' || typeof g[j][i] !== 'number') return false;
      }
      return true;
    });
  }
  function recordScore(st, b, now) {
    var v = validateScores(b.scoreA, b.scoreB);
    if (!v.ok) return v;
    var m = null;
    st.live.matches.forEach(function (x) { if (x.id === b.matchId) m = x; });
    if (!m) return { ok: false, error: 'Match not found — refresh and try again.' };
    if (m.finishedAt) return { ok: false, error: 'This match was already recorded.' };
    var w = writePairScore(st, m.a, m.b, v.a, v.b);
    if (!w.ok) return w;
    m.finishedAt = now;
    if (w.infoOnly) m.infoScore = [v.a, v.b];
    return { ok: true, complete: weekIsComplete(st) };
  }
  function editScore(st, b) {
    var v = validateScores(b.scoreA, b.scoreB);
    if (!v.ok) return v;
    if (!isGuestLabel(b.a) && !isGuestLabel(b.b)) {
      var a = findSlot(st, b.a), c = findSlot(st, b.b);
      if (!a) return { ok: false, error: (b.a || '?') + ' does not hold a pool seat.' };
      if (!c) return { ok: false, error: (b.b || '?') + ' does not hold a pool seat.' };
      if (a.L !== c.L) return { ok: false, error: 'Those players are in different pools.' };
      st.grids[a.L][a.i][c.i] = v.a;
      st.grids[c.L][c.i][a.i] = v.b;
      return { ok: true };
    }
    var ka = key(b.a), kb = key(b.b), match = null;
    st.live.matches.forEach(function (m) {
      if (!m.finishedAt) return;
      var want = b.matchId ? m.id === b.matchId
        : ((key(m.a) === ka && key(m.b) === kb) || (key(m.a) === kb && key(m.b) === ka));
      if (want && (!match || m.finishedAt > match.finishedAt)) match = m;
    });
    if (!match) return { ok: false, error: 'No recorded match found for that guest game.' };
    match.infoScore = key(match.a) === ka ? [v.a, v.b] : [v.b, v.a];
    return { ok: true };
  }
  function cancelMatch(st, b) {
    for (var i = 0; i < st.live.matches.length; i++) {
      var m = st.live.matches[i];
      if (m.id !== b.matchId) continue;
      if (m.finishedAt) return { ok: false, error: 'That match already finished — use Edit instead.' };
      st.live.matches.splice(i, 1);
      var a = findSlot(st, m.a), c = findSlot(st, m.b);
      if (a && c && a.L === c.L) clearMarker(st, a, c);
      return { ok: true };
    }
    return { ok: false, error: 'Match not found — it may already be cancelled.' };
  }

  // ---- walk-ins (Code.gs addWalkIn / editWalkIn / removeWalkIn) ----

  // Code.gs relayPlaceOnTeam.
  function relayPlaceOnTeam(team, name) {
    for (var i = team.players.length - 1; i >= 0; i--) {
      var guest = String(team.players[i]).trim();
      if (!/^guest \d+$/i.test(guest)) continue;
      team.players[i] = name;
      if (team.lineup2) team.lineup2 = team.lineup2.map(function (p) { return key(p) === key(guest) ? name : p; });
      return;
    }
    team.players.push(name);
  }
  function addWalkIn(st, b, now) {
    var relay = isRelay(st);
    var name = String(b.name || '').trim().slice(0, 40);
    if (!name) return { ok: false, error: 'Enter the player\'s name.' };
    if (relay && R.isRelayGuest(name, relayState(st))) return { ok: false, error: name + ' is on a team as a guest — take them off first to add them as a player.' };
    var idx = findSignupIdx(st, name), position, isNew = false;
    if (idx >= 0) {
      name = st.signups[idx].name;
      position = idx + 1;
    } else {
      var j = addJoin(st, name);
      if (!j.ok) return j;
      position = j.position;
      isNew = true;
      st.live.walkins[key(name)] = true;
    }
    var ci = checkin(st, { name: name }, now);
    if (!ci.ok) return ci;
    var result;
    if (!relay) {
      result = { ok: true, seated: ci.seated };
    } else if (b.team === null || b.team === undefined || b.team === '') {
      result = { ok: true, relay: clone(relayState(st)) };
    } else {
      var ti = Number(b.team), r = relayState(st);
      result = (function () {
        if (!r.teams[ti]) return { ok: false, error: 'Unknown team.' };
        for (var i = 0; i < r.teams.length; i++) {
          var hit = r.teams[i].players.some(function (p) { return key(p) === key(name); });
          if (hit && i === ti) return { ok: true, unchanged: true };
          if (hit) return { ok: false, error: name + ' is already on Team ' + r.teams[i].id + '.' };
        }
        relayPlaceOnTeam(r.teams[ti], name);
        return { ok: true };
      })();
      relayReply(st, result);
    }
    result.position = position;
    result.waitlisted = position > capFor(st);
    result.name = name;
    result.walkIn = isNew;
    return result;
  }
  function walkInTarget(st, name) {
    if (!st.live.walkins[key(name)]) return { ok: false, error: 'Only walk-ins added at the desk can be changed here.' };
    var idx = findSignupIdx(st, name);
    if (idx < 0) return { ok: false, error: 'Signup not found for ' + name };
    return { ok: true, idx: idx };
  }
  function editWalkIn(st, b) {
    var t = walkInTarget(st, b.oldName);
    if (!t.ok) return t;
    var newName = String(b.newName || '').trim().slice(0, 40);
    if (!newName) return { ok: false, error: 'Enter the corrected name.' };
    var oldKey = key(b.oldName), newKey = key(newName), old = st.signups[t.idx].name;
    if (newKey !== oldKey && findSignup(st, newName)) return { ok: false, error: newName + ' is already signed up tonight.' };
    var relay = isRelay(st);
    if (relay && newKey !== oldKey && R.isRelayGuest(newName, relayState(st))) return { ok: false, error: newName + ' is on a team as a guest.' };
    var swap = function (n) { return key(n) === oldKey ? newName : n; };
    st.signups[t.idx].name = newName;
    if (!relay) {
      var slot = findSlot(st, old);
      if (slot) st.pools[slot.L][slot.i] = newName;
    }
    delete st.live.walkins[oldKey];
    st.live.walkins[newKey] = true;
    if (st.live.checkins[oldKey] !== undefined) {
      st.live.checkins[newKey] = st.live.checkins[oldKey];
      if (newKey !== oldKey) delete st.live.checkins[oldKey];
    }
    st.live.matches.forEach(function (m) { m.a = swap(m.a); m.b = swap(m.b); });
    if (relay) {
      var r = relayState(st);
      r.teams.forEach(function (tm) { tm.players = tm.players.map(swap); if (tm.lineup2) tm.lineup2 = tm.lineup2.map(swap); });
      r.games.forEach(function (g) { g.a = (g.a || []).map(swap); g.b = (g.b || []).map(swap); });
      r.rev = (r.rev || 0) + 1;
    }
    return { ok: true, name: newName };
  }
  function removeWalkIn(st, b) {
    var t = walkInTarget(st, b.name);
    if (!t.ok) return t;
    var k = key(b.name), nm = st.signups[t.idx].name, relay = isRelay(st);
    if (relay) {
      var played = relayState(st).games.some(function (g) { return (g.a || []).concat(g.b || []).some(function (n) { return key(n) === k; }); });
      if (played) return { ok: false, error: nm + ' has already played a game tonight — take them off their team instead.' };
    } else {
      var slot = findSlot(st, nm);
      if (slot) return { ok: false, error: nm + ' has a seat in Pool ' + slot.L + ' — mark them No show instead, or redraw after removing.' };
    }
    st.signups.splice(t.idx, 1);
    delete st.guestMap[k];
    delete st.live.walkins[k];
    delete st.live.checkins[k];
    if (relay) {
      var r = relayState(st);
      r.teams.forEach(function (tm) {
        tm.players = tm.players.filter(function (p) { return key(p) !== k; });
        if (tm.lineup2) tm.lineup2 = tm.lineup2.filter(function (p) { return key(p) !== k; });
      });
      r.rev = (r.rev || 0) + 1;
    }
    return { ok: true };
  }

  // ---- team doubles (Code.gs drawTeams, relaySaveTeams, relayStartGame,
  // relayScore, relayClearGame, relayResolvePairs) ----

  function relayGuard(st) {
    if (!isRelay(st)) return { ok: false, error: st.date + ' is not a team doubles night.' };
    return { ok: true };
  }
  function drawTeams(st, b) {
    var k = Number(b.teamCount);
    if (RELAY_TEAM_COUNTS.indexOf(k) === -1) return { ok: false, error: 'Pick ' + RELAY_TEAM_COUNTS.join(' or ') + ' teams.' };
    var eligible = st.signups.slice(0, RELAY_CAP).filter(function (s) { return !s.noShow; });
    if (eligible.length < k * 2) return { ok: false, error: 'Only ' + eligible.length + ' eligible players — need at least ' + (k * 2) + ' for ' + k + ' teams.' };
    var r = relayState(st);
    if (r.teams.length) {
      if (!b.redraw) return relayReply(st, { ok: false, error: 'Teams are already drawn.' });
      if (r.games.length) return relayReply(st, { ok: false, error: 'Games have started — teams can no longer be redrawn.' });
    }
    var names = seeded(st, eligible).map(function (p) { return p.name; });
    var plan = R.relayTeamSizes(names.length, k), guestNo = 0;
    r.teams = R.relayDrawTeams(names, plan.sizes, R.relayRequestPairs(r.requests, names)).map(function (list, t) {
      var team = { id: RELAY_TEAM_IDS[t], players: list.slice() };
      for (var x = 0; x < plan.guests[t]; x++) team.players.push('Guest ' + (++guestNo));
      return team;
    });
    r.games = [];
    r.guests = [];
    return relayReply(st, { ok: true });
  }
  function relaySaveTeams(st, b) {
    var r = relayState(st), teams = b.teams;
    if (!Array.isArray(teams)) return { ok: false, error: 'Missing teams.' };
    if (!r.teams.length) return relayReply(st, { ok: false, error: 'Draw teams first.' });
    if (Number(b.rev) !== r.rev) return relayReply(st, { ok: false, stale: true, error: 'Teams were changed on another device — showing the latest now; please redo your change.' });
    if (teams.length !== r.teams.length) return relayReply(st, { ok: false, error: 'The number of teams cannot change after the draw — redraw instead.' });
    var seen = {}, clean = [];
    for (var i = 0; i < teams.length; i++) {
      var t = teams[i] || {};
      if (t.id !== r.teams[i].id) return relayReply(st, { ok: false, error: 'Team order mismatch — refresh and try again.' });
      var players = [], list = Array.isArray(t.players) ? t.players : [];
      for (var j = 0; j < list.length; j++) {
        var nm = String(list[j] || '').trim().slice(0, 40);
        if (!nm) continue;
        if (seen[key(nm)]) return relayReply(st, { ok: false, error: nm + ' is listed on more than one team.' });
        seen[key(nm)] = true;
        players.push(nm);
      }
      var lineup2 = Array.isArray(t.lineup2) ? R.relayLineup({ players: players, lineup2: t.lineup2 }, 2) : null;
      if (lineup2 && lineup2.join('\n') === players.join('\n')) lineup2 = null; // same as round 1
      var ct = { id: t.id, players: players };
      if (lineup2) ct.lineup2 = lineup2;
      clean.push(ct);
    }
    var onTeam = {};
    clean.forEach(function (t2) { t2.players.forEach(function (p) { onTeam[key(p)] = p; }); });
    var cleanGuests = [], gSeen = {}, guests = Array.isArray(b.guests) ? b.guests : [];
    for (var gi = 0; gi < guests.length; gi++) {
      var gk = key(guests[gi]);
      if (!gk || gSeen[gk] || !onTeam[gk]) continue;
      if (findSignup(st, gk)) return relayReply(st, { ok: false, error: onTeam[gk] + ' is signed up for tonight — add them as a player, not a guest.' });
      gSeen[gk] = true;
      cleanGuests.push(onTeam[gk]);
    }
    r.teams = clean;
    r.guests = cleanGuests;
    return relayReply(st, { ok: true });
  }
  function relayResolvePairs(r, tie, round, seq, aPair, bPair) {
    if (tie < 0 || tie >= R.relayTieCount(r)) return { ok: false, error: 'Unknown tie.' };
    var v = R.relayTieView(r, tie);
    if (round === RELAY_TIEBREAK_ROUND) {
      if (!v.needsTiebreak) return { ok: false, error: 'This tie doesn\'t need a tiebreak game.' };
      var pick = function (pair, team) {
        if (!Array.isArray(pair) || pair.length !== 2) return null;
        var out = [];
        for (var i = 0; i < 2; i++) {
          var hit = null;
          team.players.forEach(function (p) { if (!hit && key(p) === key(pair[i])) hit = p; });
          if (!hit) return null;
          out.push(hit);
        }
        return out[0] === out[1] ? null : out;
      };
      var a = pick(aPair, v.a), c = pick(bPair, v.b);
      if (!a || !c) return { ok: false, error: 'Pick two different players from each team for the tiebreak.' };
      return { ok: true, a: a, b: c };
    }
    if (round < 1 || round > RELAY_ROUNDS) return { ok: false, error: 'Unknown round.' };
    if (v.problem) return { ok: false, error: v.problem };
    var g = v.rounds[round - 1].games[seq];
    if (!g || !g.a || !g.b) return { ok: false, error: 'Unknown game.' };
    return { ok: true, a: g.a, b: g.b };
  }
  function gameKey(b) { return { tie: Number(b.tie), round: Number(b.round), seq: Number(b.seq) || 0 }; }
  function relayStartGame(st, b, now) {
    var r = relayState(st), k = gameKey(b);
    if (R.relayFindGame(r, k.tie, k.round, k.seq)) return relayReply(st, { ok: false, error: 'That game is already on court or scored.' });
    var p = relayResolvePairs(r, k.tie, k.round, k.seq, b.aPair, b.bPair);
    if (!p.ok) return relayReply(st, p);
    var clash = R.relayOnCourt(r, p.a.concat(p.b));
    if (clash.length) return relayReply(st, { ok: false, error: clash.join(' and ') + (clash.length > 1 ? ' are' : ' is') + ' still on court in another game — score or cancel that game first.' });
    r.games.push({ tie: k.tie, round: k.round, seq: k.seq, a: p.a, b: p.b, startedAt: now });
    return relayReply(st, { ok: true });
  }
  // Code.gs relayIsComplete.
  function relayIsComplete(r) {
    var n = R.relayTieCount(r);
    if (!n) return false;
    for (var t = 0; t < n; t++) if (!R.relayTieView(r, t).done) return false;
    return true;
  }
  function relayScore(st, b, now) {
    var v = validateScores(b.scoreA, b.scoreB);
    if (!v.ok) return v;
    var r = relayState(st), k = gameKey(b);
    var game = R.relayFindGame(r, k.tie, k.round, k.seq);
    if (!game) {
      var p = relayResolvePairs(r, k.tie, k.round, k.seq, b.aPair, b.bPair);
      if (!p.ok) return relayReply(st, p);
      game = { tie: k.tie, round: k.round, seq: k.seq, a: p.a, b: p.b };
      r.games.push(game);
    }
    game.sa = v.a; game.sb = v.b; game.finishedAt = now;
    return relayReply(st, { ok: true, complete: relayIsComplete(r) });
  }
  function relayClearGame(st, b) {
    var r = relayState(st), k = gameKey(b);
    for (var i = 0; i < r.games.length; i++) {
      var g = r.games[i];
      if (g.tie === k.tie && g.round === k.round && g.seq === k.seq) { r.games.splice(i, 1); return relayReply(st, { ok: true }); }
    }
    return relayReply(st, { ok: false, error: 'Game not found — it may already be cleared.' });
  }

  // ---- whole-week admin actions (the sandbox runs these here; the Worker
  // sends them straight to Code.gs and reloads the week after) ----

  // Code.gs resetWeek.
  function resetWeek(st) {
    st.pools = {}; st.grids = {}; st.guestMap = {};
    st.live.matches = []; st.live.checkins = {};
    st.signups.forEach(function (s) { s.checkedIn = false; s.noShow = false; });
    if (st.relay) { st.relay.teams = []; st.relay.games = []; st.relay.rev = (st.relay.rev || 0) + 1; }
    return { ok: true };
  }
  // Code.gs setEventFormat.
  function setEventFormat(st, b) {
    if (b.format === 'relay') {
      if (!isRelay(st) && drawn(st)) return { ok: false, error: 'Singles pools are already drawn for ' + st.date + ' — reset the week first.' };
      st.event = relayEvent(b.rpMode);
    } else if (b.format === 'singles') {
      if (isRelay(st) && relayState(st).teams.length) return { ok: false, error: 'Doubles teams are already drawn for ' + st.date + ' — reset the week first.' };
      st.event = null;
    } else {
      return { ok: false, error: 'Unknown format: ' + b.format };
    }
    return { ok: true, event: st.event ? clone(st.event) : { format: 'singles', cap: CAP } };
  }

  // Actions apply() handles (the Worker answers these itself).
  var ACTIONS = {
    join: join, leave: leave,
    checkin: checkin, noshow: noshow, clearstatus: clearstatus,
    generatePools: generatePools, startMatch: startMatch, recordScore: recordScore,
    editScore: editScore, cancelMatch: cancelMatch,
    addWalkIn: addWalkIn, editWalkIn: editWalkIn, removeWalkIn: removeWalkIn,
    relayAddPlayer: function (st, b, now) { var g = relayGuard(st); return g.ok ? addWalkIn(st, b, now) : g; },
    drawTeams: function (st, b) { var g = relayGuard(st); return g.ok ? drawTeams(st, b) : g; },
    relaySaveTeams: function (st, b) { var g = relayGuard(st); return g.ok ? relaySaveTeams(st, b) : g; },
    relayStartGame: function (st, b, now) { var g = relayGuard(st); return g.ok ? relayStartGame(st, b, now) : g; },
    relayScore: function (st, b, now) { var g = relayGuard(st); return g.ok ? relayScore(st, b, now) : g; },
    relayClearGame: function (st, b) { var g = relayGuard(st); return g.ok ? relayClearGame(st, b) : g; }
  };

  // Applies one action to st in place and returns its reply (same shape as
  // Code.gs's). Auth is the caller's job. A failed action leaves st as it
  // was, except that relay replies always carry the current relay state.
  function apply(st, body, now) {
    var fn = ACTIONS[body.action];
    if (!fn) return { ok: false, error: 'unknown action: ' + body.action };
    if (!st.exists) return { ok: false, error: 'No tab exists for ' + st.date };
    if (SINGLES_ONLY.indexOf(body.action) !== -1 && isRelay(st)) return relayNightError();
    return fn(st, body, now == null ? Date.now() : now);
  }

  return {
    ACTIONS: Object.keys(ACTIONS),
    apply: apply,
    fromView: fromView,
    toView: toView,
    resetWeek: resetWeek,
    setEventFormat: setEventFormat,
    relayEvent: relayEvent,
    hasAnyScores: hasAnyScores,
    capFor: capFor,
    isRelay: isRelay,
    clone: clone
  };
}

if (typeof module === 'object' && module.exports) {
  module.exports = { createWeekEngine: createWeekEngine };
}
