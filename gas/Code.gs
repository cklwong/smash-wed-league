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
 *   GET  ?action=rankings              -> { players: [{name, rank, avg, trend: [{date, score}]}], weeks: ['YYYY-MM-DD', ...] }
 *   GET  ?action=week&date=YYYY-MM-DD  -> { date, exists, hasScores, signups, pools }
 *   POST { action:'join', date, name, contact } -> { ok, row } or { ok:false, error }
 *   POST { action:'leave', date, name }         -> { ok:true } or { ok:false, error }
 *   POST { action:'getpin', date, secret }      -> { ok, pin }
 *   POST { action:'generatePools', date, pin, padGuests:['A',...], redraw } -> { ok, pools }
 *   POST { action:'checkin', date, name }       -> { ok, seated } (restores a no-show's pool spot if their guest hasn't played; seated:false means a redraw is needed to seat them)
 *   POST { action:'noshow', date, name }        -> { ok } (marks 'ns' and swaps their pool spot for GuestX1, GuestX2, ...)
 *   POST { action:'clearstatus', date, name }   -> { ok } (undo a mis-tapped check-in / no-show)
 *   POST { action:'startMatch', date, a, b, guestNames } -> { ok, match } (puts a same-pool unplayed pair on court; guestNames maps a guest seat label to who's playing as it tonight)
 *   POST { action:'recordScore', date, matchId, scoreA, scoreB } -> { ok } (writes the score grid and stops the match; guest games count 1-0 for the real player, actual score kept as info)
 *   POST { action:'editScore', date, a, b, scoreA, scoreB, matchId } -> { ok } (fixes a finished game's score; guest games only update the info score)
 *   POST { action:'cancelMatch', date, matchId }-> { ok } (removes a mis-started, unfinished match)
 *   POST { action:'finalizeRankings', date, secret } -> { ok, finalized, updated, added, skipped } (admin passphrase; re-runs finalize for a fully-scored week, overwriting its Rankings column pair)
 */

var CONTACT_COL = 30; // column AD - far past the template's used columns, to avoid clobbering formulas
var NOSHOW_GUEST_COL = 31; // column AE - remembers which Guest label replaced a no-show, for swap-back
var CAP = 24;

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
    else if (body.action === 'generatePools') result = generatePools(body.date, body.pin, body.padGuests, body.redraw);
    else if (body.action === 'checkin') result = setCheckin(body.date, body.name);
    else if (body.action === 'noshow') result = setNoShow(body.date, body.name);
    else if (body.action === 'clearstatus') result = clearStatus(body.date, body.name);
    else if (body.action === 'startMatch') result = startMatch(body.date, body.a, body.b, body.guestNames, body.id);
    else if (body.action === 'recordScore') result = recordScore(body.date, body.matchId, body.scoreA, body.scoreB);
    else if (body.action === 'editScore') result = editScore(body.date, body.a, body.b, body.scoreA, body.scoreB, body.matchId);
    else if (body.action === 'cancelMatch') result = cancelMatch(body.date, body.matchId);
    else if (body.action === 'finalizeRankings') result = forceFinalizeWeek(body.date, body.secret);
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

      // The header block is always exactly lay.size slot columns, even when
      // a drawn pool seats fewer than its max (unused trailing slots are
      // blank) - so the summary block (GW...) must be located by fixed
      // geometry, not by scanning for the first blank header cell, which
      // lands short whenever the pool isn't filled to capacity.
      var lay = POOL_LAYOUT[m[1]];
      var members = [];
      for (var s = 0; s < lay.size; s++) {
        var h = (headerRow[c + 1 + s] || '').toString().trim();
        if (h) members.push(h);
      }
      var summaryCol = c + 1 + lay.size; // GW column index
      var drawn = members.length > 0 && !/^[A-D]\d+$/.test(members[0]);

      // Raw score grid (numbers or ''), so the site can compute live standings
      // and per-game results without depending on the sheet's formula columns.
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

      // Summary block is 5 columns: GW, GL, Pts W-L, Rank, Rank Pts.
      var players = members.map(function (memberName, i) {
        var prow = data[r2 + 1 + i] || [];
        return {
          name: drawn ? memberName : ((prow[4] || '').toString().trim() || memberName),
          gw: prow[summaryCol] || 0,
          gl: prow[summaryCol + 1] || 0,
          ptsWL: prow[summaryCol + 2] || '',
          rank: prow[summaryCol + 3] || '',
          rankPts: prow[summaryCol + 4] || ''
        };
      });
      pools.push({ label: m[1], drawn: drawn, players: players, grid: grid });
    }
  }
  return pools;
}

function getWeek(dateISO) {
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
    live: { matches: live.matches, checkins: live.checkins },
    now: Date.now()
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

function getRankings() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Rankings');
  if (!sheet) return { players: [] };
  var data = sheet.getDataRange().getValues();
  var header = data[1] || []; // row 1 is a "DO NOT TOUCH" label row; row 2 has real headers

  var nameCol = header.indexOf('Name');
  var rankCol = header.indexOf('Rank');
  var avgCol = header.indexOf('Avg (4 of 6wk)');
  var dateCols = [];
  var dateLabels = [];
  for (var c = 0; c < header.length; c++) {
    var h = (header[c] || '').toString();
    if (/ RP$/.test(h)) { // most-recent-first
      dateCols.push(c);
      dateLabels.push(headerToISODate(h));
    }
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
      trend.push({ date: dateLabels[i], score: Number(v) });
    }
    players.push({
      name: name,
      rank: Number(row[rankCol]) || 9999,
      avg: Number(row[avgCol]) || 0,
      trend: trend
    });
  }
  players.sort(function (a, b) { return a.rank - b.rank; });
  // The RP headers are exactly the finalized weeks - the site's Past weeks
  // list. Header order = most recent first.
  var weeks = [];
  for (var w = 0; w < dateLabels.length; w++) {
    if (dateLabels[w]) weeks.push(dateLabels[w]);
  }
  return { players: players, weeks: weeks };
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
  }
  return { ok: true, row: targetRow, position: position };
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

// A player's standings rank, or 9999 (= seeded last, in signup order) when
// they can't be matched in Rankings.
function rankFor(rankedPlayers, name) {
  var keys = rankedPlayers.map(function (p) { return p.name.toLowerCase(); });
  var idx = matchNameIndex(keys, name);
  return idx === -1 ? 9999 : rankedPlayers[idx].rank;
}

// Always >= 2 pools: <=16 -> 2, <=21 -> 3, else 4. Even sizes, extras to earlier pools.
function poolSplitSizes(n) {
  var k = n <= 16 ? 2 : (n <= 21 ? 3 : 4);
  var base = Math.floor(n / k), extra = n % k;
  var sizes = [];
  for (var i = 0; i < k; i++) sizes.push(base + (i < extra ? 1 : 0));
  return sizes;
}

function generatePools(dateISO, pin, padGuests, redraw) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { ok: false, error: 'No tab exists for ' + dateISO };
  var pinCheck = checkPin(dateISO, pin);
  if (!pinCheck.ok) return pinCheck;

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

// ---- Check-in / no-show (open to everyone) ----

function setCheckin(dateISO, name) {
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

function setNoShow(dateISO, name) {
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

function clearStatus(dateISO, name) {
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

// ---- Live match desk (open to everyone, like check-in) ----
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

function startMatch(dateISO, a, b, guestNames, clientId) {
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

function recordScore(dateISO, matchId, scoreA, scoreB) {
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

function editScore(dateISO, a, b, scoreA, scoreB, matchId) {
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

function cancelMatch(dateISO, matchId) {
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

function doFinalizeWeek(dateISO) {
  SpreadsheetApp.flush(); // a score was possibly just written; recalc GW/Rank before reading
  var week = getWeek(dateISO);
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

  return { ok: true, finalized: true, date: dateISO, updated: results.length - skipped.length, added: added, skipped: skipped };
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
  return '=IFERROR(AVERAGE(LARGE({' + cells + '}, SEQUENCE(MIN(4, COUNT(' + cells + ')),1))),0)';
}

// Long-term absence: a player's 4th consecutive missed week is marked
// "1mo absence" with 0 rank points, so the 0 enters their best-4-of-6 average
// and consistent attendees move past them. Once they've attended 2 weeks
// again, the artificial 0 is erased (the text stays, as the organizer always
// kept it). While an absence 0 still sits inside the 6-week average window no
// new one is added - reproducing the organizer's manual cadence for very long
// absences. Both passes are idempotent, so re-finalizing after an edit is safe.
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
    // The most recent week already carries the label - don't stack another
    // one on top, just leave this week blank until they return.
    if (cur + 1 < weekCols.length && (rowVals[weekCols[cur + 1]] || '').toString().trim() === ABSENCE_LABEL) return;
    for (var p = 1; p <= 3; p++) {
      if (attended(rowVals, weekCols[cur + p])) return; // streak broken
    }
    var playedEver = weekCols.some(function (wc) { return attended(rowVals, wc); });
    if (!playedEver) return; // never mark a row that never played
    for (var w = 0; w < 6 && w < weekCols.length; w++) {
      if (absenceZero(rowVals, weekCols[w])) return; // a 0 already drags this average
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
