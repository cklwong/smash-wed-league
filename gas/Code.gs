/**
 * Web App backend for the Smash Wed league site.
 * Bind this script to the "2026 Smash Wed League" spreadsheet:
 * Extensions > Apps Script, paste this in as Code.gs, then Deploy.
 *
 * One-time setup (Apps Script editor):
 *   1. Project Settings > Script Properties: set
 *        ADMIN_EMAILS  - comma-separated organizer emails for the weekly PIN email
 *        ADMIN_SECRET  - passphrase organizers type on the site to retrieve an event PIN
 *   2. Run setupTriggers() once (authorizes MailApp and installs the Wednesday
 *      noon trigger that emails the event PIN, plus the nightly auto-finalize
 *      check). sendWeeklyPin() can also be run manually to (re)send the
 *      current week's PIN.
 *
 * When a week's pool play completes (every game scored), the week is
 * finalized automatically: rank points are written into the Rankings sheet
 * as a new "M/D/YY R" + "M/D/YY RP" column pair and long-term absences are
 * marked (see the finalization section at the bottom of this file).
 *
 * Endpoints (after deploying as a Web App):
 *   GET  ?action=rankings              -> { players: [{name, rank, avg, trend: [{date, score, pool}]}], weeks: ['YYYY-MM-DD', ...] } (pool is a "A6"-style pool+rank label for that week; rank is tie-broken - the sheet's own Rank column ties on equal Avg, so equal-rank groups are re-ordered by most-recent-week rank points then most-recent head-to-head, with unresolved ties sharing one rank number [skip-style] but shuffled randomly rather than alphabetically, since pool seeding sorts on this field. This tie-break runs once per finalize and is persisted to the Rankings sheet's "Sorted Name"/"Sorted Rank" columns [A/B] by writeSortedRankings() - getRankings() just reads that snapshot back, so the order is stable across views until the next finalize, not re-shuffled on every request)
 *   GET  ?action=week&date=YYYY-MM-DD  -> { date, exists, hasScores, signups, pools }
 *   GET  ?action=headtohead&name=NAME  -> { opponents: [{name, wins, losses, matches: [{date, scoreFor, scoreAgainst, won}, ...]}, ...] } (record over NAME's last 6 completed weeks + every individual game vs each opponent shared a pool with in that window; matches are most-recent-first)
 *   POST { action:'join', date, name, contact } -> { ok, row } or { ok:false, error } (if contact looks like an email, sends a welcome email with the site link)
 *   POST { action:'leave', date, name }         -> { ok:true } or { ok:false, error }
 *   POST { action:'getpin', date, secret }      -> { ok, pin }
 *   POST { action:'generatePools', date, pin, padGuests:['A',...], redraw } -> { ok, pools }
 *   POST { action:'checkin', date, name, secret }       -> { ok, seated } (admin passphrase; restores a no-show's pool spot if their guest hasn't played; seated:false means a redraw is needed to seat them)
 *   POST { action:'noshow', date, name, secret }        -> { ok } (admin passphrase; marks 'ns' and swaps their pool spot for GuestX1, GuestX2, ...)
 *   POST { action:'clearstatus', date, name, secret }   -> { ok } (admin passphrase; undo a mis-tapped check-in / no-show)
 *   POST { action:'startMatch', date, a, b, guestNames, secret } -> { ok, match } (admin passphrase; puts a same-pool unplayed pair on court; guestNames maps a guest seat label to who's playing as it tonight)
 *   POST { action:'recordScore', date, matchId, scoreA, scoreB, secret } -> { ok } (admin passphrase; writes the score grid and stops the match; guest games count 1-0 for the real player, actual score kept as info)
 *   POST { action:'editScore', date, a, b, scoreA, scoreB, matchId, secret } -> { ok } (admin passphrase; fixes a finished game's score; guest games only update the info score)
 *   POST { action:'cancelMatch', date, matchId, secret }-> { ok } (admin passphrase; removes a mis-started, unfinished match)
 *   POST { action:'finalizeRankings', date, secret } -> { ok, finalized, updated, added, skipped } (admin passphrase; re-runs finalize for a fully-scored week, overwriting its Rankings column pair - this also recomputes the tie-broken standings snapshot, see writeSortedRankings())
 *   POST { action:'resetWeek', date, secret } -> { ok } (admin passphrase; wipes a week's pool draw, every score, and check-in/no-show status back to the undrawn template state - for testing, not during a real session)
 *   POST { action:'createWeek', secret } -> { ok, date } (admin passphrase; duplicates the most recently dated week tab as a new blank tab one week later, wiping signups/draw/scores from the copy)
 */

var CONTACT_COL = 30; // column AD - far past the template's used columns, to avoid clobbering formulas
var NOSHOW_GUEST_COL = 31; // column AE - remembers which Guest label replaced a no-show, for swap-back
var CAP = 24;
var SITE_URL = 'https://cklwong.github.io/smash-wed-league/';

// Fixed weekly-tab template geometry. Pool grids are formula-driven off the
// column-E seed slots (grid headers are =E2 etc.), so drawing a pool is just
// writing names into E. The score grid is a size x size block starting at
// column H on the slot rows.
var SLOT_COL = 5;      // column E
var GRID_FIRST_COL = 8; // column H
var POOL_LAYOUT = {
  A: { firstSlotRow: 2,  size: 9 },
  B: { firstSlotRow: 13, size: 8 },
  C: { firstSlotRow: 24, size: 7 },
  D: { firstSlotRow: 35, size: 7 }
};
var POOL_LETTERS = ['A', 'B', 'C', 'D'];

function doGet(e) {
  var action = (e.parameter && e.parameter.action) || '';
  var result;
  try {
    if (action === 'rankings') result = getRankings();
    else if (action === 'week') result = getWeek(e.parameter.date);
    else if (action === 'headtohead') result = getHeadToHead(e.parameter.name);
    else if (action === 'weekDates') result = getWeekDates();
    else result = { error: 'unknown action: ' + action };
  } catch (err) {
    result = { error: String(err) };
  }
  return jsonOutput(result);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) {}
  var result;
  try {
    if (body.action === 'join') result = addJoin(body.date, body.name, body.contact);
    else if (body.action === 'leave') result = removeJoin(body.date, body.name);
    else if (body.action === 'getpin') result = getPin(body.date, body.secret);
    else if (body.action === 'verifyPin') result = checkPin(body.date, body.pin);
    else if (body.action === 'generatePools') result = generatePools(body.date, body.pin, body.padGuests, body.redraw, body.secret);
    else if (body.action === 'checkin') result = setCheckin(body.date, body.name, body.secret, body.pin);
    else if (body.action === 'noshow') result = setNoShow(body.date, body.name, body.secret, body.pin);
    else if (body.action === 'clearstatus') result = clearStatus(body.date, body.name, body.secret, body.pin);
    else if (body.action === 'startMatch') result = startMatch(body.date, body.a, body.b, body.guestNames, body.id, body.secret, body.pin);
    else if (body.action === 'recordScore') result = recordScore(body.date, body.matchId, body.scoreA, body.scoreB, body.secret, body.pin);
    else if (body.action === 'editScore') result = editScore(body.date, body.a, body.b, body.scoreA, body.scoreB, body.matchId, body.secret, body.pin);
    else if (body.action === 'cancelMatch') result = cancelMatch(body.date, body.matchId, body.secret, body.pin);
    else if (body.action === 'finalizeRankings') result = forceFinalizeWeek(body.date, body.secret);
    else if (body.action === 'resetWeek') result = resetWeek(body.date, body.secret);
    else if (body.action === 'createWeek') result = createWeek(body.date, body.secret);
    else if (body.action === 'peekNextWeekDate') result = peekNextWeekDate(body.secret);
    else result = { error: 'unknown action: ' + body.action };
  } catch (err) {
    result = { error: String(err) };
  }
  return jsonOutput(result);
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Short-TTL cache for the read endpoints - absorbs duplicate/concurrent
// requests (multiple phones on league night, the 45s schedule poll, repeat
// player-modal opens) without needing invalidation wired into every write
// action. Staleness is bounded by ttlSeconds.
function cached(key, ttlSeconds, compute) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  var result = compute();
  cache.put(key, JSON.stringify(result), ttlSeconds);
  return result;
}

// '2026-07-15' -> '7/15/26' (matches this workbook's tab naming)
function tabNameForDate(dateISO) {
  var parts = dateISO.split('-');
  var y = parseInt(parts[0], 10) % 100;
  var m = parseInt(parts[1], 10);
  var d = parseInt(parts[2], 10);
  return m + '/' + d + '/' + y;
}

function getWeekSheet(dateISO) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabNameForDate(dateISO));
}

// Column A is the signup list, in order, down to the first truly blank row.
// "Max limit (24ppl)" / "Wait List Below" are inline labels the organizer drops
// into that same column - they're not people and must be skipped, not treated
// as the end of the list, since real waitlisted names continue after them.
// Past the first blank row the sheet reuses column A for a stray rankings copy.
function parseSignups(data) {
  var signups = [];
  for (var r = 1; r < data.length; r++) {
    var name = (data[r][0] || '').toString().trim();
    if (!name) break;
    if (/max limit/i.test(name) || /wait list/i.test(name)) continue;
    var status = (data[r][1] || '').toString().trim().toLowerCase();
    signups.push({
      row: r + 1, // 1-based sheet row
      name: name,
      checkedIn: status === 'y',
      noShow: /^(ns|no ?show)$/.test(status)
    });
  }
  return signups;
}

// A started-but-unfinished game holds this marker in its top-right grid cell
// (written by startMatch) so the sheet's conditional formatting can highlight
// games in progress. It is never a score - every reader must ignore it.
function isInProgressMarker(v) {
  return typeof v === 'string' && v.trim().toLowerCase() === 'p';
}

// Each pool's header ("Pool A", "Pool B", ...) sits on whatever row follows the
// previous pool's block, not all on row 1 - so we scan every row for it. Each row
// also repeats "Pool X" later as the heading for a trailing Rank/Rank Pts summary
// block; only the first occurrence per letter (per row scanned) is the real one.
function parsePools(data) {
  var seenLabels = {};
  var pools = [];
  for (var r2 = 0; r2 < data.length; r2++) {
    var headerRow = data[r2];
    for (var c = 0; c < headerRow.length; c++) {
      var label = (headerRow[c] || '').toString().trim();
      var m = label.match(/^Pool ([A-D])$/);
      if (!m || seenLabels[m[1]]) continue;
      seenLabels[m[1]] = true;

      // Trailing seats past a pool's actual player count are blank - skip
      // over them without stopping the scan; only the literal "GW" header
      // marks the true end of the seat-header block (whatever its real
      // width is - POOL_LAYOUT.size isn't a reliable stand-in for that, so
      // don't use it here, only for the grid dimensions below).
      var members = [];
      var cc = c + 1;
      while (cc < headerRow.length) {
        var h = (headerRow[cc] || '').toString().trim();
        if (h === 'GW') break;
        if (h) members.push(h);
        cc++;
      }
      var summaryCol = cc; // GW column index
      var drawn = members.length > 0 && !/^[A-D]\d+$/.test(members[0]);

      // Raw score grid (numbers or ''), so the site can compute live standings
      // and per-game results without depending on the sheet's formula columns.
      var lay = POOL_LAYOUT[m[1]];
      var grid = [];
      if (drawn) {
        for (var gr = 0; gr < lay.size; gr++) {
          var grow = data[lay.firstSlotRow - 1 + gr] || [];
          var line = [];
          for (var gc = 0; gc < lay.size; gc++) {
            var gv = grow[GRID_FIRST_COL - 1 + gc];
            line.push(gv === undefined || gv === null || isInProgressMarker(gv) ? '' : gv);
          }
          grid.push(line);
        }
      }

      // Summary block is 6 columns: GW, GL, Pts W-L, Score (tie-break helper,
      // unused here), Rank, Rank Pts.
      var players = members.map(function (memberName, i) {
        var prow = data[r2 + 1 + i] || [];
        return {
          name: drawn ? memberName : ((prow[4] || '').toString().trim() || memberName),
          gw: prow[summaryCol] || 0,
          gl: prow[summaryCol + 1] || 0,
          ptsWL: prow[summaryCol + 2] || '',
          rank: prow[summaryCol + 4] || '',
          rankPts: prow[summaryCol + 5] || ''
        };
      });
      pools.push({ label: m[1], drawn: drawn, players: players, grid: grid });
    }
  }
  return pools;
}

// Cached, read-only view for the site's GET ?action=week - never call this
// from a finalize/write path, since a stale hit could hide a just-recorded
// score. Those paths call computeWeek() directly instead.
function getWeek(dateISO) {
  // `now` is excluded from the cached payload (and always computed fresh)
  // since the client uses it to sync its clock against the server's -
  // caching it would let SERVER_OFFSET drift by up to the cache TTL.
  var result = cached('week_' + dateISO, 15, function () { return computeWeek(dateISO); });
  result.now = Date.now();
  return result;
}

function computeWeek(dateISO) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { date: dateISO, exists: false, hasScores: false, signups: [], pools: [] };
  var data = sheet.getDataRange().getValues();
  var signups = parseSignups(data).map(function (s) {
    return { name: s.name, checkedIn: s.checkedIn, noShow: s.noShow };
  });
  var pools = parsePools(data);
  var live = getLiveState(dateISO);
  return {
    date: dateISO, exists: true, hasScores: anyScoresEntered(data),
    signups: signups, pools: pools,
    live: { matches: live.matches, checkins: live.checkins }
  };
}

// True once any score has been typed into any pool's H..H+size grid block.
function anyScoresEntered(data) {
  for (var i = 0; i < POOL_LETTERS.length; i++) {
    var lay = POOL_LAYOUT[POOL_LETTERS[i]];
    for (var r = 0; r < lay.size; r++) {
      var row = data[lay.firstSlotRow - 1 + r] || [];
      for (var c = 0; c < lay.size; c++) {
        var v = row[GRID_FIRST_COL - 1 + c];
        if (v !== '' && v !== null && v !== undefined && !isInProgressMarker(v)) return true;
      }
    }
  }
  return false;
}

// '7/1/26 RP' -> '2026-07-01'; returns null if the header doesn't look like a date
function headerToISODate(header) {
  var m = header.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  var mo = parseInt(m[1], 10), da = parseInt(m[2], 10), yr = parseInt(m[3], 10);
  if (yr < 100) yr += 2000;
  return yr + '-' + (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da;
}

// Reads the Rankings sheet into { players, weeks, data } - players carry
// name/avg/trend plus the sheet's raw =RANK.EQ() rank (still tied on equal
// Avg at this point). Shared by computeRankings() (which layers the
// persisted tie-broken order from columns A/B on top) and
// writeSortedRankings() (which recomputes that tie-broken order and writes
// it back).
function readRankingsSheet(sheet) {
  var data = sheet.getDataRange().getValues();
  var header = data[1] || []; // row 1 is a "DO NOT TOUCH" label row; row 2 has real headers

  var nameCol = header.indexOf('Name');
  var rankCol = header.indexOf('Rank');
  var avgCol = header.indexOf('Avg (4 of 6wk)');
  var dateCols = [];
  var labelCols = []; // the paired "M/D/YY R" column (pool+rank, e.g. "A6") - always immediately left of RP
  var dateLabels = [];
  for (var c = 0; c < header.length; c++) {
    var h = (header[c] || '').toString();
    if (/ RP$/.test(h)) { // most-recent-first
      dateCols.push(c);
      labelCols.push(c - 1);
      dateLabels.push(headerToISODate(h));
    }
  }

  // The RP headers are exactly the finalized weeks - the site's Past weeks
  // list. Header order = most recent first.
  var weeks = [];
  for (var w = 0; w < dateLabels.length; w++) {
    if (dateLabels[w]) weeks.push(dateLabels[w]);
  }

  var players = [];
  for (var r = 2; r < data.length; r++) {
    var row = data[r];
    var name = (row[nameCol] || '').toString().trim();
    if (!name) continue;
    var trend = [];
    for (var i = dateCols.length - 1; i >= 0; i--) { // reverse -> chronological
      var v = row[dateCols[i]];
      if (v === '' || v === null || typeof v === 'string') continue; // skip blanks / "1mo absence"
      trend.push({ date: dateLabels[i], score: Number(v), pool: (row[labelCols[i]] || '').toString().trim() });
    }
    players.push({
      name: name,
      rank: Number(row[rankCol]) || 9999,
      avg: Number(row[avgCol]) || 0,
      trend: trend
    });
  }
  return { players: players, weeks: weeks, data: data };
}

function getRankings() {
  return cached('rankings', 60, computeRankings);
}

function getWeekDates() {
  return cached('weekDates', 60, listWeekDates);
}

// All dated weekly tabs currently in the spreadsheet, ascending - drives the
// Join page's date picker so a newly created (but not yet finalized) week
// is immediately selectable, instead of the Join page guessing at upcoming
// Wednesdays independent of whether a tab actually exists for them.
function listWeekDates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dates = [];
  ss.getSheets().forEach(function (sh) {
    var iso = headerToISODate(sh.getName());
    if (iso) dates.push(iso);
  });
  dates.sort();
  return { dates: dates };
}

// Returns season standings with the tie-broken order that writeSortedRankings()
// persisted into columns A/B ("Sorted Name"/"Sorted Rank") the last time a
// week finalized - not recomputed here, so every viewer of the standings
// page sees the same order for the week instead of a fresh random shuffle
// (unresolved ties are randomized, see applyTieBreaks()) on every load. The
// returned array's order is taken directly from A/B's row order too, not
// just the rank number - two players sharing one rank number still need a
// stable relative order (rankFor() below relies on it for pool seeding),
// and re-deriving that from rank number alone would lose it. Players not
// yet in that snapshot (e.g. just added, no finalize since) fall back to
// the sheet's raw =RANK.EQ() rank, sorted after everyone in the snapshot.
function computeRankings() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  if (!sheet) return { players: [] };
  var read = readRankingsSheet(sheet);
  var players = read.players, weeks = read.weeks, data = read.data;

  var sortedInfo = {}; // lowercased name -> { rank, pos } from columns A/B, pos = row order there
  var pos = 0;
  for (var r = 2; r < data.length; r++) {
    var nm = (data[r][RANKINGS_SORTED_NAME_COL - 1] || '').toString().trim();
    var rk = data[r][RANKINGS_SORTED_RANK_COL - 1];
    if (!nm || rk === '' || rk === null) continue;
    sortedInfo[nm.toLowerCase()] = { rank: Number(rk), pos: pos };
    pos++;
  }
  players.forEach(function (p) {
    var info = sortedInfo[p.name.trim().toLowerCase()];
    if (info) { p.rank = info.rank; p._pos = info.pos; }
    else { p._pos = 1e6 + p.rank; } // not in the snapshot yet - after everyone who is
  });
  players.sort(function (a, b) { return a._pos - b._pos; });
  players.forEach(function (p) { delete p._pos; });
  return { players: players, weeks: weeks };
}

// Recomputes the tie-broken season order (including a fresh random shuffle
// for any still-unresolved ties) and writes it into the Rankings sheet's
// "Sorted Name"/"Sorted Rank" columns (A/B) - the snapshot getRankings()
// reads back on every view and generatePools() seeds pools from (via
// getRankings()). Called once per finalize (doFinalizeWeek), not on every
// read, so the order stays stable for everyone viewing that week.
function writeSortedRankings(sheet) {
  var read = readRankingsSheet(sheet);
  // applyTieBreaks() groups tied players by scanning for adjacent equal
  // ranks, so they must be rank-sorted first.
  read.players.sort(function (a, b) { return a.rank - b.rank; });
  applyTieBreaks(read.players, read.weeks);
  var rows = read.players.map(function (p) { return [p.name, p.rank]; });
  if (rows.length) {
    sheet.getRange(RANKINGS_FIRST_DATA_ROW, RANKINGS_SORTED_NAME_COL, rows.length, 2).setValues(rows);
  }
  var clearFrom = RANKINGS_FIRST_DATA_ROW + rows.length;
  if (clearFrom <= RANKINGS_LAST_DATA_ROW) {
    sheet.getRange(clearFrom, RANKINGS_SORTED_NAME_COL, RANKINGS_LAST_DATA_ROW - clearFrom + 1, 2).clearContent();
  }
}

// Manual editor entry point for re-syncing columns A/B without a full
// re-finalize - same pattern as fixAvgFormulas().
function writeSortedRankingsNow() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  if (!sheet) { Logger.log('Rankings sheet not found'); return; }
  writeSortedRankings(sheet);
  Logger.log('Wrote sorted rankings to columns A/B.');
}

// The sheet's Rank column is =RANK.EQ() on Avg, which gives every player in
// a tied group the same number and doesn't order them further. This walks
// the rank-sorted list, re-orders each tied group with resolveTiedGroup(),
// then renumbers: players whose order got fully resolved (by week/
// head-to-head) each get their own consecutive number, but anyone left
// unresolved keeps sharing one rank number with the rest of their tied
// cluster (skip-style, like standard competition ranking) - both the
// standings display and pool seeding (which sorts on this same `rank`
// field) depend on this, so genuine ties should still look tied, and the
// random shuffle resolveTiedGroup leaves them in is what actually decides
// pool-seeding order among them (no alphabetical or sign-up-order bias).
function applyTieBreaks(players, weeks) {
  var nextRank = 1;
  var i = 0;
  while (i < players.length) {
    var j = i + 1;
    while (j < players.length && players[j].rank === players[i].rank) j++;
    if (j - i > 1) {
      // A 0 Avg tie is long-term absences bottoming out together, not a
      // real competitive tie - skip the week/head-to-head lookups and just
      // shuffle them like any other unresolved group.
      if (players[i].avg !== 0) {
        resolveTiedGroup(players, i, j, weeks);
      } else {
        var group0 = players.slice(i, j);
        shuffle(group0);
        group0.forEach(function (p) { p._tied = true; });
        for (var z = i; z < j; z++) players[z] = group0[z - i];
      }
    } else {
      players[i]._tied = false;
    }
    nextRank = assignGroupRanks(players, i, j, nextRank);
    i = j;
  }
  for (var c = 0; c < players.length; c++) delete players[c]._tieKey;
}

// Assigns rank numbers to players[start..end) - one originally-tied group,
// already reordered/marked by resolveTiedGroup - continuing from nextRank.
// Runs of players still marked _tied share one number and the counter
// skips past the whole run; everyone else gets their own consecutive
// number. Returns the next rank number to use for the following group.
function assignGroupRanks(players, start, end, nextRank) {
  var i = start;
  while (i < end) {
    if (players[i]._tied) {
      var j = i + 1;
      while (j < end && players[j]._tied) j++;
      for (var k = i; k < j; k++) { players[k].rank = nextRank; delete players[k]._tied; }
      nextRank += (j - i);
      i = j;
    } else {
      players[i].rank = nextRank;
      delete players[i]._tied;
      nextRank++;
      i++;
    }
  }
  return nextRank;
}

// Fisher-Yates shuffle, in place.
function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

// Reorders players[start..end) (a group tied on rank) in place per the
// season tie-break rules:
//   - exactly 2 tied: most recent head-to-head result between them
//   - 3+ tied: most recent week where every tied player has a score, highest
//     rank-points-that-week wins; any players still tied after that fall
//     back to the same pairwise head-to-head rule
//   - anyone still unresolved (no common week, or no head-to-head history)
//     is shuffled randomly and marked _tied, so applyTieBreaks() keeps them
//     sharing one rank number instead of inventing a fake distinct order
function resolveTiedGroup(players, start, end, weeks) {
  var group = players.slice(start, end);
  if (group.length === 2) {
    orderByHeadToHead(group, weeks);
  } else {
    orderByMostRecentCommonWeek(group, weeks);
    var i = 0;
    while (i < group.length) {
      var j = i + 1;
      while (j < group.length && group[j]._tieKey === group[i]._tieKey) j++;
      if (j - i > 1) {
        var sub = group.slice(i, j);
        orderByHeadToHead(sub, weeks);
        for (var k = i; k < j; k++) group[k] = sub[k - i];
      }
      i = j;
    }
  }
  for (var m = start; m < end; m++) players[m] = group[m - start];
}

// Sorts a tied group by rank points earned in the most recent week where
// every player in the group has a score (walking back through weeks - most
// recent first - until one qualifies). Sets _tieKey on each player so the
// caller can find any still-equal sub-runs left to resolve, and marks
// everyone resolved (_tied = false) - any residual equal-key run gets
// re-marked by orderByHeadToHead() if it can't separate them further. If no
// common week exists at all, everyone gets the same key (0), forming one
// big residual run handled the same way.
function orderByMostRecentCommonWeek(group, weeks) {
  var weekDate = null;
  for (var w = 0; w < weeks.length && !weekDate; w++) {
    var d = weeks[w];
    var allPlayed = true;
    for (var g = 0; g < group.length; g++) {
      var has = false;
      for (var t = 0; t < group[g].trend.length; t++) {
        if (group[g].trend[t].date === d) { has = true; break; }
      }
      if (!has) { allPlayed = false; break; }
    }
    if (allPlayed) weekDate = d;
  }
  group.forEach(function (p) {
    p._tieKey = 0;
    if (weekDate) {
      for (var t = 0; t < p.trend.length; t++) {
        if (p.trend[t].date === weekDate) { p._tieKey = p.trend[t].score; break; }
      }
    }
  });
  group.sort(function (a, b) { return b._tieKey - a._tieKey; });
  group.forEach(function (p) { p._tied = false; });
}

// Orders a tied pair by their most recent head-to-head result (winner
// first), marking both resolved. Falls back to a random shuffle - marking
// everyone _tied - when there's no head-to-head data, or when the group has
// 3+ players left with no other way to separate them (head-to-head is
// inherently pairwise), so pool seeding doesn't get a fake alphabetical or
// sign-up-order bias for a tie the data can't actually settle.
function orderByHeadToHead(group, weeks) {
  if (group.length === 2) {
    var result = mostRecentHeadToHead(group[0].name, group[1].name, weeks);
    if (result) {
      group.sort(function (a, b) {
        if (a.name === result.winner) return -1;
        if (b.name === result.winner) return 1;
        return 0;
      });
      group.forEach(function (p) { p._tied = false; });
      return;
    }
  }
  shuffle(group);
  group.forEach(function (p) { p._tied = true; });
}

// Scans finalized weeks (most-recent-first) for the most recent match
// between exactly nameA and nameB, stopping at the first one found. Cheaper
// than getHeadToHead() when only the latest result matters (tie-breaking),
// since that function scans every week to build a full season record.
function mostRecentHeadToHead(nameA, nameB, weeks) {
  var keyA = (nameA || '').toString().trim().toLowerCase();
  var keyB = (nameB || '').toString().trim().toLowerCase();
  for (var w = 0; w < weeks.length; w++) {
    var sheet = getWeekSheet(weeks[w]);
    if (!sheet) continue;
    var pools = parsePools(sheet.getDataRange().getValues());
    for (var p = 0; p < pools.length; p++) {
      var pool = pools[p];
      if (!pool.drawn) continue;
      var idxA = -1, idxB = -1;
      for (var i = 0; i < pool.players.length; i++) {
        var n = pool.players[i].name.trim().toLowerCase();
        if (n === keyA) idxA = i;
        if (n === keyB) idxB = i;
      }
      if (idxA === -1 || idxB === -1) continue;
      var scoreA = pool.grid[idxA][idxB], scoreB = pool.grid[idxB][idxA];
      if (typeof scoreA !== 'number' || typeof scoreB !== 'number') continue; // unplayed pair
      return { winner: scoreA > scoreB ? nameA : nameB, date: weeks[w] };
    }
  }
  return null;
}

// Scans every finalized week's pool grid for games between `name` and each
// opponent they shared a pool with, tallying a head-to-head record over the
// last 6 completed weeks. Weeks come from the Rankings sheet's RP headers
// (same list getRankings() exposes as `weeks`, most-recent-first), so this
// only ever looks at completed weeks - same source of truth, no separate
// bookkeeping to keep in sync.
var H2H_WEEK_WINDOW = 6;

function getHeadToHead(name) {
  var key = (name || '').toString().trim().toLowerCase();
  if (!key) return { opponents: [] };
  return cached('h2h_' + key, 60, function () { return computeHeadToHead(key); });
}

function computeHeadToHead(key) {
  var rankSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  var weeks = [];
  if (rankSheet) {
    var header = rankSheet.getDataRange().getValues()[1] || [];
    for (var c = 0; c < header.length; c++) {
      var h = (header[c] || '').toString();
      if (/ RP$/.test(h)) {
        var iso = headerToISODate(h);
        if (iso) weeks.push(iso);
      }
    }
  }
  weeks = weeks.slice(0, H2H_WEEK_WINDOW); // header order is most-recent-first

  var totals = {}; // lowercased opponent name -> {name, wins, losses, matches: [{date, scoreFor, scoreAgainst, won}]}
  weeks.forEach(function (dateISO) {
    var sheet = getWeekSheet(dateISO);
    if (!sheet) return;
    var pools = parsePools(sheet.getDataRange().getValues());
    pools.forEach(function (p) {
      if (!p.drawn) return;
      var idx = -1;
      for (var i = 0; i < p.players.length; i++) {
        if (p.players[i].name.trim().toLowerCase() === key) { idx = i; break; }
      }
      if (idx === -1) return;
      for (var j = 0; j < p.players.length; j++) {
        if (j === idx) continue;
        var opp = p.players[j];
        if (isGuestLabel(opp.name)) continue;
        var a = p.grid[idx][j], b = p.grid[j][idx];
        if (typeof a !== 'number' || typeof b !== 'number') continue; // unplayed pair
        var oppName = opp.name.trim(), oppKey = oppName.toLowerCase();
        if (!totals[oppKey]) totals[oppKey] = { name: oppName, wins: 0, losses: 0, matches: [] };
        var won = a > b;
        if (won) totals[oppKey].wins++; else totals[oppKey].losses++;
        totals[oppKey].matches.push({ date: dateISO, scoreFor: a, scoreAgainst: b, won: won });
      }
    });
  });

  var opponents = Object.keys(totals).map(function (k) {
    var o = totals[k];
    o.matches.sort(function (m1, m2) { return m2.date < m1.date ? -1 : (m2.date > m1.date ? 1 : 0); }); // most-recent-first
    return o;
  });
  opponents.sort(function (a, b) {
    return (b.wins + b.losses) - (a.wins + a.losses) || a.name.localeCompare(b.name);
  });
  return { opponents: opponents };
}

function addJoin(dateISO, name, contact) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();

  // Position is the count of real signups already parsed (labels skipped),
  // not derived from the raw row number - inline labels like "Max limit
  // (24ppl)" would otherwise inflate it.
  var existing = parseSignups(data);
  var position = existing.length + 1;

  var lastRow = sheet.getLastRow();
  var colA = sheet.getRange(1, 1, lastRow, 1).getValues();
  var targetRow = -1;
  for (var i = 1; i < colA.length; i++) {
    if ((colA[i][0] || '').toString().trim() === '') { targetRow = i + 1; break; }
  }
  if (targetRow === -1) targetRow = lastRow + 1;

  sheet.getRange(targetRow, 1).setValue(name);
  if (contact) {
    sheet.getRange(1, CONTACT_COL).setValue('Contact');
    sheet.getRange(targetRow, CONTACT_COL).setValue(contact);
    if (isEmail(contact)) emailWelcomeLink(contact, name);
  }
  return { ok: true, row: targetRow, position: position };
}

function isEmail(contact) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((contact || '').trim());
}

// New players who sign up with an email get a welcome email pointing them
// at the league site, so they can find Standings/This week/Join again.
function emailWelcomeLink(email, name) {
  MailApp.sendEmail(email.trim(),
    'Welcome to Smash Wed!',
    'Hi ' + name + ',\n\n' +
    'Thanks for signing up for Smash Wed. You can check standings, this week\'s pools, ' +
    'and manage your signups any time here:\n' + SITE_URL);
}

// Deletes the signup's row outright (rather than blanking it) so every row
// below shifts up - this is what promotes the first waitlisted signup into
// the newly-opened confirmed slot, since confirmed/waitlist is just a
// position-based slice of the parsed signup order.
function removeJoin(dateISO, name) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();
  var signups = parseSignups(data);
  var target = null;
  for (var i = 0; i < signups.length; i++) {
    if (signups[i].name.toLowerCase() === (name || '').trim().toLowerCase()) { target = signups[i]; break; }
  }
  if (!target) return { ok: false, error: 'Signup not found for ' + name };
  sheet.deleteRow(target.row);
  return { ok: true };
}

function findSignup(signups, name) {
  var key = (name || '').trim().toLowerCase();
  for (var i = 0; i < signups.length; i++) {
    if (signups[i].name.toLowerCase() === key) return signups[i];
  }
  return null;
}

function slotDefaultLabel(letter, index) {
  return letter + (index + 1);
}

function slotValue(data, letter, index) {
  var row = data[POOL_LAYOUT[letter].firstSlotRow - 1 + index] || [];
  return (row[SLOT_COL - 1] || '').toString().trim();
}

// Drawn = some E seed slot holds something other than its template label ("A1"...).
function poolsAreDrawn(data) {
  for (var i = 0; i < POOL_LETTERS.length; i++) {
    var letter = POOL_LETTERS[i];
    for (var s = 0; s < POOL_LAYOUT[letter].size; s++) {
      var v = slotValue(data, letter, s);
      if (v && v.toLowerCase() !== slotDefaultLabel(letter, s).toLowerCase()) return true;
    }
  }
  return false;
}

function findSlotByValue(data, value) {
  var key = (value || '').trim().toLowerCase();
  for (var i = 0; i < POOL_LETTERS.length; i++) {
    var letter = POOL_LETTERS[i];
    for (var s = 0; s < POOL_LAYOUT[letter].size; s++) {
      if (slotValue(data, letter, s).toLowerCase() === key) {
        return { letter: letter, index: s, row: POOL_LAYOUT[letter].firstSlotRow + s };
      }
    }
  }
  return null;
}

// A slot has been played if any score sits in its grid row (their scores) or
// its mirrored grid column (opponents' scores against them).
function slotHasScores(data, letter, index) {
  var lay = POOL_LAYOUT[letter];
  var rowVals = data[lay.firstSlotRow - 1 + index] || [];
  for (var c = 0; c < lay.size; c++) {
    var v = rowVals[GRID_FIRST_COL - 1 + c];
    if (v !== '' && v !== null && v !== undefined) return true;
  }
  for (var r = 0; r < lay.size; r++) {
    var row = data[lay.firstSlotRow - 1 + r] || [];
    var v2 = row[GRID_FIRST_COL - 1 + index];
    if (v2 !== '' && v2 !== null && v2 !== undefined) return true;
  }
  return false;
}

// ---- Event PIN (protects pool generation only) ----

function ensurePin(dateISO) {
  var props = PropertiesService.getScriptProperties();
  var key = 'PIN_' + dateISO;
  var pin = props.getProperty(key);
  if (!pin) {
    pin = String(Math.floor(100000 + Math.random() * 900000));
    props.setProperty(key, pin);
  }
  return pin;
}

function checkPin(dateISO, pin) {
  var stored = PropertiesService.getScriptProperties().getProperty('PIN_' + dateISO);
  if (!stored) return { ok: false, error: 'No PIN issued for ' + dateISO + ' yet — retrieve it from the organizer panel first.' };
  if (String(pin || '').trim() !== stored) return { ok: false, error: 'Wrong PIN.' };
  return { ok: true };
}

function checkAdminSecret(secret) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  if (!expected) return { ok: false, error: 'ADMIN_SECRET script property is not set — set it in Apps Script project settings.' };
  if (String(secret || '') !== expected) return { ok: false, error: 'Wrong passphrase.' };
  return { ok: true };
}

// Run-night actions accept either the admin passphrase or tonight's event PIN,
// so helpers who only have the PIN can check players in, run matches, and
// manage pools without needing the organizer passphrase.
function checkRunAuth(dateISO, secret, pin) {
  if (secret) {
    var s = checkAdminSecret(secret);
    if (s.ok || !pin) return s;
  }
  if (pin) return checkPin(dateISO, pin);
  return { ok: false, error: 'Sign in required.' };
}

function getPin(dateISO, secret) {
  var auth = checkAdminSecret(secret);
  if (!auth.ok) return auth;
  if (!dateISO) return { ok: false, error: 'Missing date.' };
  return { ok: true, pin: ensurePin(dateISO) };
}

function upcomingWednesdayISO() {
  var tz = 'America/Los_Angeles';
  var now = new Date();
  for (var i = 0; i < 7; i++) {
    var d = new Date(now.getTime() + i * 86400000);
    if (Utilities.formatDate(d, tz, 'u') === '3') return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  }
}

// Run weekly by trigger (see setupTriggers), or manually to (re)send this week's PIN.
function sendWeeklyPin() {
  var dateISO = upcomingWednesdayISO();
  var pin = ensurePin(dateISO);
  var emails = PropertiesService.getScriptProperties().getProperty('ADMIN_EMAILS');
  if (!emails) {
    Logger.log('ADMIN_EMAILS not set; PIN for ' + dateISO + ' is ' + pin);
    return;
  }
  MailApp.sendEmail(emails,
    'Smash Wed pool PIN for ' + dateISO,
    'Tonight\'s pool-generation PIN is: ' + pin + '\n\n' +
    'Use it on the This week page to generate (or redraw) pools.\n' +
    'It can also be retrieved any time from the organizer panel with the admin passphrase.');
}

// Run once from the editor: installs the Wednesday-noon PIN email trigger and
// the nightly auto-finalize check (for scores typed straight into the sheet).
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'sendWeeklyPin' || fn === 'autoFinalizeDaily') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyPin')
    .timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(12)
    .inTimezone('America/Los_Angeles')
    .create();
  ScriptApp.newTrigger('autoFinalizeDaily')
    .timeBased().everyDays(1).atHour(23)
    .inTimezone('America/Los_Angeles')
    .create();
}

// ---- Pool generation ----

// Signups are often typed as short names ("Ellyn") while Rankings holds full
// names ("Ellyn Park"): exact match first, then fall back to a unique-prefix
// match. `keys` are lowercased, trimmed full names; returns an index or -1.
function matchNameIndex(keys, name) {
  var key = (name || '').trim().toLowerCase();
  var prefixHit = -1, prefixHits = 0;
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] === key) return i;
    if (keys[i].indexOf(key + ' ') === 0) { prefixHit = i; prefixHits++; }
  }
  return prefixHits === 1 ? prefixHit : -1;
}

// A player's seeding order: their position in rankedPlayers (getRankings()'s
// already tie-broken array, in the exact order persisted at last finalize -
// see getRankings()), or 9999 (= seeded last, in signup order) when they
// can't be matched in Rankings. Position rather than the raw rank number,
// so two players sharing one rank number (an unresolved tie) still seed in
// the stable order that was randomly decided once at finalize time, instead
// of falling back to this week's sign-up order.
function rankFor(rankedPlayers, name) {
  var keys = rankedPlayers.map(function (p) { return p.name.toLowerCase(); });
  var idx = matchNameIndex(keys, name);
  return idx === -1 ? 9999 : idx;
}

// Always >= 2 pools: <=16 -> 2, <=21 -> 3, else 4. Even sizes, extras to earlier pools.
function poolSplitSizes(n) {
  var k = n <= 16 ? 2 : (n <= 21 ? 3 : 4);
  var base = Math.floor(n / k), extra = n % k;
  var sizes = [];
  for (var i = 0; i < k; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

function generatePools(dateISO, pin, padGuests, redraw, secret) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;

  var data = sheet.getDataRange().getValues();
  // Confirmed slice only, minus no-shows. The waitlist is never promoted here -
  // by pool time it's too late; missing spots are filled by guests instead.
  var eligible = parseSignups(data).slice(0, CAP).filter(function (s) { return !s.noShow; });
  if (eligible.length < 12) {
    return { ok: false, error: 'Only ' + eligible.length + ' eligible players — the session is cancelled below 12.' };
  }
  if (poolsAreDrawn(data)) {
    if (!redraw) return { ok: false, error: 'Pools are already drawn.' };
    if (anyScoresEntered(data)) return { ok: false, error: 'Games have started — pools can no longer be redrawn.' };
  }

  // Tiered by standings: best-ranked chunk -> Pool A, next -> B, etc.
  // Unranked (new) players sort last, keeping their signup order.
  var rankedPlayers = getRankings().players;
  var sorted = eligible.map(function (s, i) {
    return { name: s.name, rank: rankFor(rankedPlayers, s.name), idx: i };
  }).sort(function (a, b) { return a.rank - b.rank || a.idx - b.idx; });

  var sizes = poolSplitSizes(sorted.length);
  var pad = {};
  (padGuests || []).forEach(function (L) { pad[String(L).toUpperCase()] = true; });

  var pools = [], pos = 0;
  for (var i = 0; i < sizes.length; i++) {
    var letter = POOL_LETTERS[i];
    var members = sorted.slice(pos, pos + sizes[i]).map(function (p) { return p.name; });
    pos += sizes[i];
    if (pad[letter] && members.length < POOL_LAYOUT[letter].size) members.push('Guest' + letter);
    pools.push({ label: letter, players: members });
  }

  // Write every pool's E slots. In-use pools get names with trailing slots
  // blank (a label there would read as a phantom player); unused pool blocks
  // get their template labels back, which marks them undrawn. Clear all score
  // grids and stale no-show guest mappings.
  for (var pi = 0; pi < POOL_LETTERS.length; pi++) {
    var L2 = POOL_LETTERS[pi];
    var lay = POOL_LAYOUT[L2];
    var inUse = pi < pools.length;
    var members2 = inUse ? pools[pi].players : [];
    var values = [];
    for (var s = 0; s < lay.size; s++) values.push([members2[s] || (inUse ? '' : slotDefaultLabel(L2, s))]);
    sheet.getRange(lay.firstSlotRow, SLOT_COL, lay.size, 1).setValues(values);
    sheet.getRange(lay.firstSlotRow, GRID_FIRST_COL, lay.size, lay.size).clearContent();
  }
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, NOSHOW_GUEST_COL, lastRow - 1, 1).clearContent();

  // Any matches from before the (re)draw refer to cleared grids; drop them
  // but keep check-in times as the waiting baseline.
  updateLiveState(dateISO, function (state) {
    state.matches = [];
    return { ok: true };
  });

  return { ok: true, pools: pools };
}

// Wipes a week tab's pool draw and every score back to the undrawn template
// state - all four pool blocks, regardless of which were in use, plus the
// no-show guest-swap column. Shared by resetWeek() (keeps signups, for
// testing an existing week) and createWeek() (wipes signups too, since it's
// starting a brand new one).
function clearDrawAndScores(sheet) {
  for (var pi = 0; pi < POOL_LETTERS.length; pi++) {
    var letter = POOL_LETTERS[pi];
    var lay = POOL_LAYOUT[letter];
    var values = [];
    for (var s = 0; s < lay.size; s++) values.push([slotDefaultLabel(letter, s)]);
    sheet.getRange(lay.firstSlotRow, SLOT_COL, lay.size, 1).setValues(values);
    sheet.getRange(lay.firstSlotRow, GRID_FIRST_COL, lay.size, lay.size).clearContent();
  }
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, NOSHOW_GUEST_COL, lastRow - 1, 1).clearContent();
}

// Wipes a week's pool draw, every score, and every signup's check-in/no-show
// status back to the undrawn template state - for testing pool
// generation/scoring against a real week's tab without waiting for real
// players; never called during a real session.
function resetWeek(dateISO, secret) {
  var auth = checkAdminSecret(secret);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };

  clearDrawAndScores(sheet);

  // Column B ("y" / "ns") covers every signup row, confirmed and waitlisted
  // alike - same contiguous-until-first-blank scan parseSignups() uses,
  // without its inline-label skip since those rows' column B is blank anyway.
  var data = sheet.getDataRange().getValues();
  var lastSignupRow = 1;
  for (var r = 1; r < data.length; r++) {
    if (!(data[r][0] || '').toString().trim()) break;
    lastSignupRow = r + 1;
  }
  if (lastSignupRow > 1) sheet.getRange(2, 2, lastSignupRow - 1, 1).clearContent();

  // Any matches from before the reset refer to wiped grids; drop them along
  // with check-in timestamps and no-show guest swaps, same as the sheet
  // columns above.
  updateLiveState(dateISO, function (state) {
    state.matches = [];
    state.checkins = {};
    return { ok: true };
  });

  return { ok: true };
}

// '2026-07-15' -> '2026-07-22' (7 days later, tz-safe via UTC).
function addDaysISO(dateISO, days) {
  var parts = dateISO.split('-').map(Number);
  var d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  d.setUTCDate(d.getUTCDate() + days);
  var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, da = d.getUTCDate();
  return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (da < 10 ? '0' : '') + da;
}

// Wipes every real signup name, status, and contact from a freshly
// duplicated week tab, leaving the organizer's inline template labels
// ("Max limit (24ppl)", "Wait List Below") in place - same skip rule
// parseSignups() uses to tell labels from real signups.
function clearSignupsForNewWeek(sheet) {
  var lastRow = sheet.getLastRow();
  for (var r = 2; r <= lastRow; r++) {
    var name = (sheet.getRange(r, 1).getValue() || '').toString().trim();
    if (!name) break; // first truly blank row ends the signup section
    if (/max limit/i.test(name) || /wait list/i.test(name)) continue;
    sheet.getRange(r, 1).clearContent();
    sheet.getRange(r, 2).clearContent();
    sheet.getRange(r, CONTACT_COL).clearContent();
  }
}

// Finds the most recently dated weekly tab (by parsing every sheet name as
// "M/D/YY") and the date one week after it - the default suggestion for the
// next week to create.
function computeNextWeek() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var latest = null; // { sheet, dateISO }
  ss.getSheets().forEach(function (sh) {
    var iso = headerToISODate(sh.getName());
    if (!iso) return;
    if (!latest || iso > latest.dateISO) latest = { sheet: sh, dateISO: iso };
  });
  if (!latest) return null;
  return { latestSheet: latest.sheet, newDateISO: addDaysISO(latest.dateISO, 7) };
}

// Read-only preview so the site can show/confirm the suggested date before
// createWeek() actually duplicates a tab.
function peekNextWeekDate(secret) {
  var auth = checkAdminSecret(secret);
  if (!auth.ok) return auth;
  var next = computeNextWeek();
  if (!next) return { ok: false, error: 'No existing week tabs found to use as a template.' };
  return { ok: true, date: next.newDateISO };
}

// Duplicates the most recently dated weekly tab as the new week's blank tab,
// keeping its pool-grid formulas and formatting, with every signup, draw,
// and score wiped so it's ready for a new session. Saves the organizer from
// copy-pasting the template tab and clearing it out by hand each week.
// dateISO is normally the site's confirmed suggestion from peekNextWeekDate,
// but an organizer may override it (e.g. a skipped or moved week).
function createWeek(dateISO, secret) {
  var auth = checkAdminSecret(secret);
  if (!auth.ok) return auth;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var next = computeNextWeek();
  if (!next) return { ok: false, error: 'No existing week tabs found to use as a template.' };
  var newDateISO = dateISO || next.newDateISO;
  var newTabName = tabNameForDate(newDateISO);
  if (ss.getSheetByName(newTabName)) return { ok: false, error: 'A tab for ' + newTabName + ' already exists.' };

  var newSheet = next.latestSheet.copyTo(ss);
  newSheet.setName(newTabName);
  ss.setActiveSheet(newSheet);
  ss.moveActiveSheet(1); // move to the first tab for easier viewing

  clearDrawAndScores(newSheet);
  clearSignupsForNewWeek(newSheet);
  writeWeekDateCell(newSheet, newDateISO);
  protectWeekSheet(newSheet);

  // So the Join page's date list (driven by weekDates) picks up the new tab
  // right away instead of waiting out the 60s cache.
  CacheService.getScriptCache().remove('weekDates');

  return { ok: true, date: newDateISO };
}

// Stamps cell A1 with the week's session start (date + 5:30pm, matching the
// league's start time) so the tab is self-labeled even without looking at
// the tab name. Parsed in the league's own timezone (same constant
// upcomingWednesdayISO() uses) rather than built with `new Date(y, m, d)`,
// which resolves in the Apps Script runtime's default timezone (often UTC)
// and can land a day off once Sheets displays it.
function writeWeekDateCell(sheet, dateISO) {
  var parts = dateISO.split('-');
  var mdY = parts[1] + '/' + parts[2] + '/' + parts[0] + ' 17:30';
  var date = Utilities.parseDate(mdY, 'America/Los_Angeles', 'MM/dd/yyyy HH:mm');
  var cell = sheet.getRange(1, 1);
  cell.setValue(date);
  cell.setNumberFormat('M/d/yy H:mm');
}

// Locks the tab so only the spreadsheet owner (and the deployed web app,
// which executes as the owner) can edit it - manual edits by other editors
// on the sheet are blocked in the Sheets UI. Apps Script always lets the
// spreadsheet owner edit a protected sheet regardless of the editor list, so
// removing every default editor is enough to lock it to "owner only."
function protectWeekSheet(sheet) {
  var protection = sheet.protect().setDescription('Week tab - edit via site admin tools only');
  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

// ---- Check-in / no-show (admin only) ----

function setCheckin(dateISO, name, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();
  var target = findSignup(parseSignups(data), name);
  if (!target) return { ok: false, error: 'Signup not found for ' + name };

  // seated:false tells the frontend this player has no pool spot and a
  // redraw is needed to place them - e.g. their guest mapping was wiped by
  // an intervening redraw (which excludes no-shows and clears NOSHOW_GUEST_COL).
  var seated = true;
  if (target.noShow && poolsAreDrawn(data)) {
    // Late arrival: give their pool spot back only if the replacement guest
    // hasn't played yet - once a guest game is in, they sit out tonight.
    var guestLabel = ((data[target.row - 1] || [])[NOSHOW_GUEST_COL - 1] || '').toString().trim();
    if (guestLabel) {
      var slot = findSlotByValue(data, guestLabel);
      if (slot) {
        if (slotHasScores(data, slot.letter, slot.index)) {
          return { ok: false, error: guestLabel + ' has already played — ' + target.name + ' cannot rejoin tonight.' };
        }
        sheet.getRange(slot.row, SLOT_COL).setValue(target.name);
      } else {
        seated = false;
      }
      sheet.getRange(target.row, NOSHOW_GUEST_COL).clearContent();
    } else {
      seated = false;
    }
  }
  sheet.getRange(target.row, 2).setValue('y');
  // Waiting-time baseline for the match desk, until their first game finishes.
  updateLiveState(dateISO, function (state) {
    state.checkins[target.name.toLowerCase()] = Date.now();
    return { ok: true };
  });
  return { ok: true, seated: seated };
}

function setNoShow(dateISO, name, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();
  var target = findSignup(parseSignups(data), name);
  if (!target) return { ok: false, error: 'Signup not found for ' + name };
  if (target.noShow) return { ok: true };

  // If they hold a pool spot, hand it to the next guest for that pool
  // (GuestA1, GuestA2, ...) and remember the label for a possible swap-back.
  var slot = findSlotByValue(data, target.name);
  if (slot) {
    var guestNum = 1;
    var re = new RegExp('^Guest' + slot.letter + '(\\d+)$', 'i');
    for (var s = 0; s < POOL_LAYOUT[slot.letter].size; s++) {
      var m = slotValue(data, slot.letter, s).match(re);
      if (m && Number(m[1]) >= guestNum) guestNum = Number(m[1]) + 1;
    }
    var guestLabel = 'Guest' + slot.letter + guestNum;
    sheet.getRange(slot.row, SLOT_COL).setValue(guestLabel);
    sheet.getRange(target.row, NOSHOW_GUEST_COL).setValue(guestLabel);
  }
  sheet.getRange(target.row, 2).setValue('ns');
  updateLiveState(dateISO, function (state) {
    delete state.checkins[target.name.toLowerCase()];
    return { ok: true };
  });
  return { ok: true };
}

function clearStatus(dateISO, name, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();
  var target = findSignup(parseSignups(data), name);
  if (!target) return { ok: false, error: 'Signup not found for ' + name };

  if (target.noShow) {
    var guestLabel = ((data[target.row - 1] || [])[NOSHOW_GUEST_COL - 1] || '').toString().trim();
    if (guestLabel) {
      var slot = findSlotByValue(data, guestLabel);
      if (slot) {
        if (slotHasScores(data, slot.letter, slot.index)) {
          return { ok: false, error: guestLabel + ' has already played — the no-show cannot be undone.' };
        }
        sheet.getRange(slot.row, SLOT_COL).setValue(target.name);
      }
      sheet.getRange(target.row, NOSHOW_GUEST_COL).clearContent();
    }
  }
  sheet.getRange(target.row, 2).clearContent();
  updateLiveState(dateISO, function (state) {
    delete state.checkins[target.name.toLowerCase()];
    return { ok: true };
  });
  return { ok: true };
}

// ---- Live match desk (admin only) ----
//
// The score grid stays the source of truth for results; what the grid can't
// hold - who's on court right now, when each game started/finished (feeds the
// waiting timers), who played as a guest, and a guest game's real score - is
// kept as JSON in a per-date script property.

function getLiveState(dateISO) {
  var raw = PropertiesService.getScriptProperties().getProperty('LIVE_' + dateISO);
  var state = {};
  if (raw) { try { state = JSON.parse(raw) || {}; } catch (err) { state = {}; } }
  if (!state.matches) state.matches = [];
  if (!state.checkins) state.checkins = {};
  return state;
}

// Serializes read-modify-write of the live state across concurrent devices.
// The state is saved unless the mutator reports failure.
function updateLiveState(dateISO, mutate) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var state = getLiveState(dateISO);
    var result = mutate(state);
    if (!result || result.ok !== false) {
      PropertiesService.getScriptProperties().setProperty('LIVE_' + dateISO, JSON.stringify(state));
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function isGuestLabel(name) {
  return /^Guest[A-D]\d*$/i.test((name || '').toString().trim());
}

function findUnfinishedFor(state, name) {
  var key = (name || '').trim().toLowerCase();
  for (var i = 0; i < state.matches.length; i++) {
    var m = state.matches[i];
    if (!m.finishedAt && (m.a.toLowerCase() === key || m.b.toLowerCase() === key)) return m;
  }
  return null;
}

function gridCellFilled(data, slotA, slotB) {
  var v = (data[slotA.row - 1] || [])[GRID_FIRST_COL - 1 + slotB.index];
  // A leftover in-progress marker is not a score - it must never block a
  // (re)start the way a real result does.
  return v !== '' && v !== null && v !== undefined && !isInProgressMarker(v);
}

// The single grid cell that carries a pair's in-progress marker: the
// top-right-triangle cell (row of the lower-indexed slot, column of the other).
function markerRange(sheet, slotA, slotB) {
  var top = slotA.index < slotB.index ? slotA : slotB;
  var other = top === slotA ? slotB : slotA;
  return sheet.getRange(top.row, GRID_FIRST_COL + other.index);
}

// Clears the pair's marker cell iff it still holds the marker (never a score).
// Best-effort: cleanup must never break the action that triggered it.
function clearMarkerIfPresent(sheet, data, nameA, nameB) {
  try {
    var slotA = findSlotByValue(data, nameA);
    var slotB = findSlotByValue(data, nameB);
    if (!slotA || !slotB || slotA.letter !== slotB.letter) return;
    var range = markerRange(sheet, slotA, slotB);
    if (isInProgressMarker(range.getValue())) range.setValue('');
  } catch (err) {
    Logger.log('clearMarkerIfPresent failed: ' + err);
  }
}

function validateScores(scoreA, scoreB) {
  var a = Number(scoreA), b = Number(scoreB);
  if (!isFinite(a) || !isFinite(b) || a % 1 !== 0 || b % 1 !== 0 || a < 0 || b < 0) {
    return { ok: false, error: 'Scores must be whole numbers, 0 or more.' };
  }
  if (a === b) return { ok: false, error: 'A game cannot end in a tie.' };
  return { ok: true, a: a, b: b };
}

function startMatch(dateISO, a, b, guestNames, clientId, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var data = sheet.getDataRange().getValues();
  var slotA = findSlotByValue(data, a);
  var slotB = findSlotByValue(data, b);
  if (!slotA) return { ok: false, error: (a || '?') + ' does not hold a pool seat.' };
  if (!slotB) return { ok: false, error: (b || '?') + ' does not hold a pool seat.' };
  if (slotA.letter !== slotB.letter) return { ok: false, error: 'Those players are in different pools.' };
  if (slotA.index === slotB.index) return { ok: false, error: 'Pick two different players.' };
  if (gridCellFilled(data, slotA, slotB) || gridCellFilled(data, slotB, slotA)) {
    return { ok: false, error: 'That game already has a score.' };
  }

  var nameA = slotValue(data, slotA.letter, slotA.index);
  var nameB = slotValue(data, slotB.letter, slotB.index);
  var gn = {};
  [nameA, nameB].forEach(function (n) {
    if (isGuestLabel(n) && guestNames && guestNames[n]) {
      gn[n] = String(guestNames[n]).trim().slice(0, 40);
    }
  });

  // The site generates the id so it can show the match (with working
  // Record/Cancel buttons) before this call returns.
  var id = (typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64)
    ? clientId : Utilities.getUuid();

  var result = updateLiveState(dateISO, function (state) {
    var busy = findUnfinishedFor(state, nameA) || findUnfinishedFor(state, nameB);
    if (busy) return { ok: false, error: busy.a + ' vs ' + busy.b + ' is still on court — record or cancel it first.' };
    var match = {
      id: id,
      pool: slotA.letter,
      a: nameA,
      b: nameB,
      startedAt: Date.now()
    };
    for (var k in gn) { if (!match.guestNames) match.guestNames = {}; match.guestNames[k] = gn[k]; }
    state.matches.push(match);
    return { ok: true, match: match };
  });

  // Mark the game as in progress on the sheet itself, so the tab's
  // conditional formatting can highlight it. recordScore/editScore overwrite
  // the marker with a score; cancelMatch and guest-vs-guest records clear it.
  if (result && result.ok) {
    try { markerRange(sheet, slotA, slotB).setValue('p'); }
    catch (err) { Logger.log('startMatch marker write failed: ' + err); }
  }
  return result;
}

// Writes a finished game into the grid. Guest games are recorded as a minimal
// 1-0 win for the real player (the actual score is kept on the match as info
// only); guest-vs-guest games never touch the grid.
function writePairScore(sheet, data, nameA, nameB, scoreA, scoreB) {
  var slotA = findSlotByValue(data, nameA);
  var slotB = findSlotByValue(data, nameB);
  if (!slotA) return { ok: false, error: nameA + ' no longer holds a pool seat.' };
  if (!slotB) return { ok: false, error: nameB + ' no longer holds a pool seat.' };
  if (slotA.letter !== slotB.letter) return { ok: false, error: 'Those players are in different pools.' };
  var guestA = isGuestLabel(nameA), guestB = isGuestLabel(nameB);
  if (guestA && guestB) {
    // No score lands in the grid, so the start marker must go explicitly.
    var mr = markerRange(sheet, slotA, slotB);
    if (isInProgressMarker(mr.getValue())) mr.setValue('');
    return { ok: true, infoOnly: true };
  }
  var recA = scoreA, recB = scoreB;
  if (guestA) { recA = 0; recB = 1; }
  if (guestB) { recA = 1; recB = 0; }
  sheet.getRange(slotA.row, GRID_FIRST_COL + slotB.index).setValue(recA);
  sheet.getRange(slotB.row, GRID_FIRST_COL + slotA.index).setValue(recB);
  // Mirror the write into the caller's in-memory snapshot so it can check
  // week completeness without a second full-sheet read.
  if (data[slotA.row - 1]) data[slotA.row - 1][GRID_FIRST_COL - 1 + slotB.index] = recA;
  if (data[slotB.row - 1]) data[slotB.row - 1][GRID_FIRST_COL - 1 + slotA.index] = recB;
  return { ok: true, infoOnly: guestA || guestB };
}

function recordScore(dateISO, matchId, scoreA, scoreB, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var v = validateScores(scoreA, scoreB);
  if (!v.ok) return v;

  var result = updateLiveState(dateISO, function (state) {
    var match = null;
    for (var i = 0; i < state.matches.length; i++) {
      if (state.matches[i].id === matchId) { match = state.matches[i]; break; }
    }
    if (!match) return { ok: false, error: 'Match not found — refresh and try again.' };
    if (match.finishedAt) return { ok: false, error: 'This match was already recorded.' };

    var data = sheet.getDataRange().getValues();
    var w = writePairScore(sheet, data, match.a, match.b, v.a, v.b);
    if (!w.ok) return w;
    match.finishedAt = Date.now(); // starts both players' waiting timers
    if (w.infoOnly) match.infoScore = [v.a, v.b];
    // writePairScore patched `data` with the new scores, so completeness can
    // be judged here without the flush + full re-read finalizeWeek does.
    var complete = weekIsComplete({ pools: parsePools(data) });
    return { ok: true, complete: complete };
  });
  // Only the week's last game pays the finalize cost (flush + re-read);
  // the nightly trigger still catches anything this check misses.
  if (result && result.ok && result.complete) maybeFinalizeWeek(dateISO);
  return result;
}

function editScore(dateISO, a, b, scoreA, scoreB, matchId, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var v = validateScores(scoreA, scoreB);
  if (!v.ok) return v;

  if (!isGuestLabel(a) && !isGuestLabel(b)) {
    // Real game: rewrite the two mirrored grid cells (also fixes games that
    // were typed straight into the sheet).
    var data = sheet.getDataRange().getValues();
    var slotA = findSlotByValue(data, a);
    var slotB = findSlotByValue(data, b);
    if (!slotA) return { ok: false, error: (a || '?') + ' does not hold a pool seat.' };
    if (!slotB) return { ok: false, error: (b || '?') + ' does not hold a pool seat.' };
    if (slotA.letter !== slotB.letter) return { ok: false, error: 'Those players are in different pools.' };
    sheet.getRange(slotA.row, GRID_FIRST_COL + slotB.index).setValue(v.a);
    sheet.getRange(slotB.row, GRID_FIRST_COL + slotA.index).setValue(v.b);
    // An edit can complete the week (or change already-finalized results) -
    // refresh Rankings either way.
    maybeFinalizeWeek(dateISO);
    return { ok: true };
  }

  // Guest game: the grid keeps its 1-0 default; only the info score changes.
  return updateLiveState(dateISO, function (state) {
    var keyA = (a || '').trim().toLowerCase(), keyB = (b || '').trim().toLowerCase();
    var match = null;
    for (var i = 0; i < state.matches.length; i++) {
      var m = state.matches[i];
      if (!m.finishedAt) continue;
      if (matchId ? m.id === matchId
                  : ((m.a.toLowerCase() === keyA && m.b.toLowerCase() === keyB) ||
                     (m.a.toLowerCase() === keyB && m.b.toLowerCase() === keyA))) {
        if (!match || m.finishedAt > match.finishedAt) match = m;
      }
    }
    if (!match) return { ok: false, error: 'No recorded match found for that guest game.' };
    // scoreA belongs to `a`; flip if the stored match has the pair reversed
    match.infoScore = match.a.toLowerCase() === keyA ? [v.a, v.b] : [v.b, v.a];
    return { ok: true };
  });
}

function cancelMatch(dateISO, matchId, secret, pin) {
  var auth = checkRunAuth(dateISO, secret, pin);
  if (!auth.ok) return auth;
  var cancelled = null;
  var result = updateLiveState(dateISO, function (state) {
    for (var i = 0; i < state.matches.length; i++) {
      var m = state.matches[i];
      if (m.id !== matchId) continue;
      if (m.finishedAt) return { ok: false, error: 'That match already finished — use Edit instead.' };
      cancelled = m;
      state.matches.splice(i, 1);
      return { ok: true };
    }
    return { ok: false, error: 'Match not found — it may already be cancelled.' };
  });
  // Remove the game's in-progress marker from the grid (never a real score).
  if (result && result.ok && cancelled) {
    var sheet = getWeekSheet(dateISO);
    if (sheet) clearMarkerIfPresent(sheet, sheet.getDataRange().getValues(), cancelled.a, cancelled.b);
  }
  return result;
}

// ---- Weekly finalization: completed pool results -> Rankings sheet ----
//
// Once a week's round-robin is fully scored (no games left), the week's rank
// points are written into the Rankings sheet as a new "M/D/YY R" + "M/D/YY RP"
// column pair inserted at H (newest week first - same shape the organizer used
// to maintain by hand). Standings then recalc through the sheet's own
// Rank/Avg formulas. Runs after every recorded/edited score and from a
// nightly trigger (for scores typed straight into the sheet).

var RANKINGS_FIRST_WEEK_COL = 8;   // column H - the newest week pair lives here
var RANKINGS_SORTED_NAME_COL = 1;  // column A ("Sorted Name" header) - tie-broken snapshot, written by writeSortedRankings()
var RANKINGS_SORTED_RANK_COL = 2;  // column B ("Sorted Rank" header) - tie-broken snapshot, written by writeSortedRankings()
var RANKINGS_NAME_COL = 4;         // column D
var RANKINGS_RANK_COL = 5;         // column E (formula)
var RANKINGS_AVG_COL = 6;          // column F (formula)
var RANKINGS_FIRST_DATA_ROW = 3;   // rows 1-2 are the label + header rows
var RANKINGS_LAST_DATA_ROW = 150;  // the sheet's own formulas stop at row 150
var ABSENCE_LABEL = '1mo absence';

// Rank points use the site's rule: games won, +1 in the top pool(s) -
// 2 pools -> no bonus, 3 pools -> Pool A, 4 pools -> Pools A & B. (The weekly
// tab's own "Rank Pts" formula column follows an older rule - +1 for every
// pool except the last - and is deliberately ignored.)
function rankPtsBonus(poolIdx, drawnPoolCount) {
  return poolIdx < drawnPoolCount - 2 ? 1 : 0;
}

// Complete = every pair in every drawn pool has both mirrored grid cells
// filled. Guest-vs-guest games never touch the grid and are excluded;
// real-vs-guest games do land there (as 1-0).
function weekIsComplete(week) {
  var drawn = week.pools.filter(function (p) { return p.drawn; });
  if (!drawn.length) return false;
  for (var pi = 0; pi < drawn.length; pi++) {
    var p = drawn[pi];
    for (var i = 0; i < p.players.length; i++) {
      for (var j = i + 1; j < p.players.length; j++) {
        if (isGuestLabel(p.players[i].name) && isGuestLabel(p.players[j].name)) continue;
        var a = (p.grid[i] || [])[j], b = (p.grid[j] || [])[i];
        if (typeof a !== 'number' || typeof b !== 'number') return false;
      }
    }
  }
  return true;
}

// Per real player: the "A1"-style label from the tab's Rank formula column,
// and rank points from its GW column plus the site-rule bonus.
function computeWeekResults(week) {
  var drawn = week.pools.filter(function (p) { return p.drawn; });
  var results = [];
  drawn.forEach(function (p, pi) {
    var bonus = rankPtsBonus(pi, drawn.length);
    p.players.forEach(function (pl) {
      if (isGuestLabel(pl.name)) return;
      results.push({
        name: pl.name,
        r: p.label + pl.rank,
        rp: Number(pl.gw) + bonus
      });
    });
  });
  return results;
}

// Read-only sanity check: logs exactly what finalizeWeek would compute and
// write for a date, without touching the Rankings sheet at all. Run this
// from the editor and inspect the log before trusting a real finalize run,
// especially right after changing parsePools - a parsing bug here writes
// silently-wrong data straight into the season's standings.
function dryRunFinalize(dateISO) {
  var week = computeWeek(dateISO);
  if (!week.exists) { Logger.log('No tab exists for ' + dateISO); return; }
  Logger.log('hasScores=' + week.hasScores + ' complete=' + weekIsComplete(week));
  var results = computeWeekResults(week);
  Logger.log(JSON.stringify(results, null, 2));
  return results;
}

// Edit this, then run dryRunFinalizeDate() / runFinalizeDate() from the
// Apps Script editor to fix a single date's Rankings columns by hand - the
// Run button can't take a text-box argument, so a constant + a pair of
// zero-arg wrappers is the friction-free way to point dryRunFinalize /
// finalizeWeek at whatever date needs it.
var MANUAL_FINALIZE_DATE = '2026-07-15';

function dryRunFinalizeDate() {
  return dryRunFinalize(MANUAL_FINALIZE_DATE);
}

function runFinalizeDate() {
  var result = finalizeWeek(MANUAL_FINALIZE_DATE);
  Logger.log(JSON.stringify(result));
  return result;
}

// Called after every recorded/edited score and by the nightly trigger; a
// finalize failure must never break the score write that triggered it.
function maybeFinalizeWeek(dateISO) {
  try {
    return finalizeWeek(dateISO);
  } catch (err) {
    Logger.log('maybeFinalizeWeek(' + dateISO + ') failed: ' + err);
    return { ok: false, error: String(err) };
  }
}

// Admin-triggered re-finalize from the site (Past weeks page), for when a
// week's Rankings columns need overwriting - e.g. after a finalize-logic
// bug is fixed. Same finalizeWeek every other caller uses, just gated on
// the admin passphrase instead of running automatically off a score write.
function forceFinalizeWeek(dateISO, secret) {
  var auth = checkAdminSecret(secret);
  if (!auth.ok) return auth;
  if (!dateISO) return { ok: false, error: 'Missing date.' };
  var result = maybeFinalizeWeek(dateISO);
  if (result && result.pending) {
    return { ok: false, error: "This week isn't fully scored yet — every pool game needs a result before it can finalize." };
  }
  return result;
}

function finalizeWeek(dateISO) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return doFinalizeWeek(dateISO);
  } finally {
    lock.releaseLock();
  }
}

// Extends whatever conditional-format rules are anchored on a single
// existing column (e.g. a week's RP color scale) onto another column, over
// the same data-row range every other Rankings column helper uses. Rules
// that span multiple columns are left alone - only rules scoped to exactly
// fromCol are cloned, since those are the "this one week's column" rules a
// newly inserted week should inherit.
function copyConditionalFormatting(sheet, fromCol, toCol) {
  var rules = sheet.getConditionalFormatRules();
  var toRange = sheet.getRange(RANKINGS_FIRST_DATA_ROW, toCol, RANKINGS_LAST_DATA_ROW - RANKINGS_FIRST_DATA_ROW + 1, 1);
  var cloned = [];
  rules.forEach(function (rule) {
    var appliesToFromCol = rule.getRanges().some(function (r) {
      return r.getColumn() === fromCol && r.getLastColumn() === fromCol;
    });
    if (!appliesToFromCol) return;
    cloned.push(rule.copy().setRanges([toRange]).build());
  });
  if (cloned.length) sheet.setConditionalFormatRules(rules.concat(cloned));
}

function doFinalizeWeek(dateISO) {
  SpreadsheetApp.flush(); // a score was possibly just written; recalc GW/Rank before reading
  var week = computeWeek(dateISO);
  if (!week.exists) return { ok: false, error: 'No tab exists for ' + dateISO };
  if (!week.hasScores || !weekIsComplete(week)) return { ok: false, pending: true };

  var results = computeWeekResults(week);
  if (!results.length) return { ok: false, error: 'No pool players found for ' + dateISO };

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  if (!sheet) return { ok: false, error: 'Rankings sheet not found' };

  // Locate this week's column pair; first finalize inserts it at H.
  // Re-finalizes (after a score edit) reuse it and just overwrite values.
  var rHeaderWanted = tabNameForDate(dateISO) + ' R';
  var header = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
  var rCol = -1; // 1-based
  for (var c = 0; c < header.length; c++) {
    if ((header[c] || '').toString().trim() === rHeaderWanted) { rCol = c + 1; break; }
  }
  var inserted = false;
  if (rCol === -1) {
    sheet.insertColumnsBefore(RANKINGS_FIRST_WEEK_COL, 2);
    rCol = RANKINGS_FIRST_WEEK_COL;
    sheet.getRange(2, rCol).setValue(rHeaderWanted);
    sheet.getRange(2, rCol + 1).setValue(tabNameForDate(dateISO) + ' RP');
    // The row-1 "Enter Player Results here" label shifted right with the insert.
    var shiftedLabel = sheet.getRange(1, rCol + 2).getValue();
    if (shiftedLabel) {
      sheet.getRange(1, rCol).setValue(shiftedLabel);
      sheet.getRange(1, rCol + 2).clearContent();
    }
    // The week that was newest before this insert shifted from rCol/rCol+1
    // to rCol+2/rCol+3 - carry its RP column's conditional formatting (e.g.
    // a color scale) onto the new RP column, so every week keeps it without
    // the organizer re-applying it by hand each time.
    copyConditionalFormatting(sheet, rCol + 3, rCol + 1);
    inserted = true;
  }

  var data = sheet.getDataRange().getValues();
  var names = []; // { row (1-based), key } for every named player row
  var lastNameRow = RANKINGS_FIRST_DATA_ROW - 1;
  for (var r = RANKINGS_FIRST_DATA_ROW - 1; r < data.length && r < RANKINGS_LAST_DATA_ROW; r++) {
    var nm = (data[r][RANKINGS_NAME_COL - 1] || '').toString().trim();
    if (!nm) continue;
    names.push({ row: r + 1, key: nm.toLowerCase() });
    lastNameRow = r + 1;
  }

  var keys = names.map(function (n) { return n.key; });
  var added = [], skipped = [];
  var playedRows = {}; // 1-based row -> true; feeds the absence passes
  results.forEach(function (res) {
    var idx = matchNameIndex(keys, res.name);
    var row;
    if (idx >= 0) {
      row = names[idx].row;
    } else {
      row = appendRankingsPlayer(sheet, res.name, lastNameRow);
      if (!row) { skipped.push(res.name); return; } // row-150 cap reached
      lastNameRow = row;
      names.push({ row: row, key: res.name.trim().toLowerCase() });
      keys.push(res.name.trim().toLowerCase());
      added.push(res.name);
    }
    sheet.getRange(row, rCol).setValue(res.r);
    sheet.getRange(row, rCol + 1).setValue(res.rp);
    playedRows[row] = true;
  });

  // Inserting the week pair shifted the hardcoded $I,$K,$M,$O,$Q,$S refs in
  // every existing Avg formula - rewrite the whole column to the canonical
  // best-4-of-the-6-newest-weeks form.
  if (inserted) {
    var namedRows = {};
    names.forEach(function (n) { namedRows[n.row] = true; });
    var formulas = [];
    for (var fr = RANKINGS_FIRST_DATA_ROW; fr <= lastNameRow; fr++) {
      formulas.push([namedRows[fr] ? avgFormulaForRow(fr) : '']);
    }
    if (formulas.length) {
      sheet.getRange(RANKINGS_FIRST_DATA_ROW, RANKINGS_AVG_COL, formulas.length, 1).setFormulas(formulas);
    }
  }

  applyAbsencePasses(sheet, rCol, playedRows, names);

  // Rank/Avg are formulas that depend on the R/RP values and absence-pass
  // edits just written above - flush so writeSortedRankings() reads this
  // week's recalculated numbers, not last week's.
  SpreadsheetApp.flush();
  writeSortedRankings(sheet);
  moveRankingsBeforeWeek(dateISO);

  return { ok: true, finalized: true, date: dateISO, updated: results.length - skipped.length, added: added, skipped: skipped };
}

// Keeps the Rankings tab pinned immediately to the left of whichever week
// was just finalized, so the two stay adjacent as the season's tabs grow.
function moveRankingsBeforeWeek(dateISO) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var weekSheet = getWeekSheet(dateISO);
  var rankingsSheet = ss.getSheetByName('Rankings');
  if (!weekSheet || !rankingsSheet || rankingsSheet === weekSheet) return;
  var weekIndex = weekSheet.getIndex();
  var rankingsIndex = rankingsSheet.getIndex();
  if (rankingsIndex === weekIndex - 1) return; // already positioned correctly
  var targetIndex = rankingsIndex < weekIndex ? weekIndex - 1 : weekIndex;
  ss.setActiveSheet(rankingsSheet);
  ss.moveActiveSheet(targetIndex);
}

// New players go on the row after the last named one, with the Rank/Avg
// formulas the sheet only prefills through existing player rows.
function appendRankingsPlayer(sheet, name, lastNameRow) {
  var row = Math.max(lastNameRow + 1, RANKINGS_FIRST_DATA_ROW);
  if (row > RANKINGS_LAST_DATA_ROW) return 0;
  sheet.getRange(row, RANKINGS_NAME_COL).setValue(name.trim());
  sheet.getRange(row, RANKINGS_RANK_COL).setFormula('=RANK.EQ(F' + row + ', $F$3:$F$150, FALSE)');
  sheet.getRange(row, RANKINGS_AVG_COL).setFormula(avgFormulaForRow(row));
  return row;
}

// The Avg column hardcodes the six newest RP columns; "best 4 of the last
// 6 weeks played" (blanks don't count, an absence 0 does).
function avgFormulaForRow(row) {
  var cells = ['$I', '$K', '$M', '$O', '$Q', '$S'].map(function (col) { return col + row; }).join(',');
  return '=IFERROR(AVERAGE(ARRAYFORMULA(LARGE({' + cells + '}, SEQUENCE(MIN(4, COUNT(' + cells + ')))))),0)';
}

// doFinalizeWeek only rewrites column F when it inserts a brand new week
// pair (the insert is what shifts $I,$K,... for every existing row); a
// re-finalize that reuses an existing column pair never touches F, so a
// week whose R/RP got fixed after the fact (e.g. 7/15) can be left with
// whatever formula - or lack of one - was there before. Run this manually
// from the editor any time column F looks wrong, to force every named row
// back to the canonical formula regardless of why it drifted.
function fixAvgFormulas() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  if (!sheet) { Logger.log('Rankings sheet not found'); return; }
  var data = sheet.getDataRange().getValues();
  var fixed = 0;
  for (var r = RANKINGS_FIRST_DATA_ROW - 1; r < data.length && r < RANKINGS_LAST_DATA_ROW; r++) {
    var nm = (data[r][RANKINGS_NAME_COL - 1] || '').toString().trim();
    if (!nm) continue;
    var row = r + 1;
    sheet.getRange(row, RANKINGS_AVG_COL).setFormula(avgFormulaForRow(row));
    fixed++;
  }
  Logger.log('Rewrote column F for ' + fixed + ' player rows.');
}

// Long-term absence: a player's 4th consecutive missed week is marked
// "1mo absence" with 0 rank points, so the 0 enters their best-4-of-6 average
// and consistent attendees move past them. Once they've attended 2 weeks
// again, the artificial 0 is erased (the text stays, as the organizer always
// kept it). No matter how many more weeks they stay away - even once that 0
// ages out of the 6-week average window - no second marker is ever added on
// top; a player is either freshly flagged or already flagged, never
// re-flagged while still absent. Both passes are idempotent, so re-finalizing
// after an edit is safe.
function applyAbsencePasses(sheet, rCol, playedRows, names) {
  SpreadsheetApp.flush();
  var data = sheet.getDataRange().getValues();
  var header = data[1] || [];
  var weekCols = []; // every week's R column, 0-based, sheet order = newest first
  for (var c = 0; c < header.length; c++) {
    if (/ R$/.test((header[c] || '').toString()) && headerToISODate((header[c] || '').toString())) {
      weekCols.push(c);
    }
  }
  var cur = weekCols.indexOf(rCol - 1);
  if (cur === -1) return;

  function attended(rowVals, wc) {
    return /^[A-D]\d+$/.test((rowVals[wc] || '').toString().trim());
  }
  // An absence marker whose 0 is still dragging the average.
  function absenceZero(rowVals, wc) {
    var label = (rowVals[wc] || '').toString().trim();
    var rp = rowVals[wc + 1];
    return !!label && !attended(rowVals, wc) && rp !== '' && Number(rp) === 0;
  }

  names.forEach(function (n) {
    var rowVals = data[n.row - 1] || [];

    if (playedRows[n.row]) {
      // Comeback: 2 attended weeks since a marker erase that marker's 0.
      // Columns before index k are newer than the marker (this week included,
      // since its R value is already written and re-read above).
      for (var k = cur + 1; k < weekCols.length; k++) {
        if (!absenceZero(rowVals, weekCols[k])) continue;
        var backWeeks = 0;
        for (var a = 0; a < k; a++) {
          if (attended(rowVals, weekCols[a])) backWeeks++;
        }
        if (backWeeks >= 2) sheet.getRange(n.row, weekCols[k] + 2).clearContent();
      }
      return;
    }

    // Absent this week: mark the 4th consecutive miss.
    if ((rowVals[weekCols[cur]] || '').toString().trim()) return; // organizer already labelled it
    if (cur + 3 >= weekCols.length) return; // not enough history yet
    for (var p = 1; p <= 3; p++) {
      if (attended(rowVals, weekCols[cur + p])) return; // streak broken
    }
    var playedEver = weekCols.some(function (wc) { return attended(rowVals, wc); });
    if (!playedEver) return; // never mark a row that never played
    // Don't stack a new marker on an already-open one: walk back past the
    // blank weeks a still-absent player leaves behind (see the comeback pass
    // above) to the nearest week with anything written in it at all. If
    // that's the absence label, this player is already flagged - however
    // long ago - and stays that way until they return, so skip marking.
    for (var b = cur + 1; b < weekCols.length; b++) {
      var priorLabel = (rowVals[weekCols[b]] || '').toString().trim();
      if (!priorLabel) continue;
      if (priorLabel === ABSENCE_LABEL) return;
      break; // most recent entry was a real played week - clear to mark
    }
    sheet.getRange(n.row, weekCols[cur] + 1).setValue(ABSENCE_LABEL);
    sheet.getRange(n.row, weekCols[cur] + 2).setValue(0);
  });
}

// Nightly-trigger fallback so weeks whose last scores were typed straight
// into the sheet still finalize. Only the most recent Wednesday, and only
// within 3 days of it - never back-fills older weeks.
function autoFinalizeDaily() {
  var tz = 'America/Los_Angeles';
  var now = new Date();
  for (var i = 0; i <= 3; i++) {
    var d = new Date(now.getTime() - i * 86400000);
    if (Utilities.formatDate(d, tz, 'u') === '3') {
      maybeFinalizeWeek(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
      return;
    }
  }
}
