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
 *      noon trigger that emails the event PIN). sendWeeklyPin() can also be run
 *      manually to (re)send the current week's PIN.
 *
 * Endpoints (after deploying as a Web App):
 *   GET  ?action=rankings              -> { players: [{name, rank, avg, trend: [{date, score}]}] }
 *   GET  ?action=week&date=YYYY-MM-DD  -> { date, exists, hasScores, signups, pools }
 *   POST { action:'join', date, name, contact } -> { ok, row } or { ok:false, error }
 *   POST { action:'leave', date, name }         -> { ok:true } or { ok:false, error }
 *   POST { action:'getpin', date, secret }      -> { ok, pin }
 *   POST { action:'generatePools', date, pin, padGuests:['A',...], redraw } -> { ok, pools }
 *   POST { action:'checkin', date, name }       -> { ok, seated } (restores a no-show's pool spot if their guest hasn't played; seated:false means a redraw is needed to seat them)
 *   POST { action:'noshow', date, name }        -> { ok } (marks 'ns' and swaps their pool spot for GuestX1, GuestX2, ...)
 *   POST { action:'clearstatus', date, name }   -> { ok } (undo a mis-tapped check-in / no-show)
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

function getWeek(dateISO) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { date: dateISO, exists: false, hasScores: false, signups: [], pools: [] };
  var data = sheet.getDataRange().getValues();
  var signups = parseSignups(data).map(function (s) {
    return { name: s.name, checkedIn: s.checkedIn, noShow: s.noShow };
  });

  // Each pool's header ("Pool A", "Pool B", ...) sits on whatever row follows the
  // previous pool's block, not all on row 1 - so we scan every row for it. Each row
  // also repeats "Pool X" later as the heading for a trailing Rank/Rank Pts summary
  // block; only the first occurrence per letter (per row scanned) is the real one.
  var seenLabels = {};
  var pools = [];
  for (var r2 = 0; r2 < data.length; r2++) {
    var headerRow = data[r2];
    for (var c = 0; c < headerRow.length; c++) {
      var label = (headerRow[c] || '').toString().trim();
      var m = label.match(/^Pool ([A-D])$/);
      if (!m || seenLabels[m[1]]) continue;
      seenLabels[m[1]] = true;

      var members = [];
      var cc = c + 1;
      while (cc < headerRow.length) {
        var h = (headerRow[cc] || '').toString().trim();
        if (h === 'GW' || h === '') break;
        members.push(h);
        cc++;
      }
      var summaryCol = cc; // GW column index
      var drawn = members.length > 0 && !/^[A-D]\d+$/.test(members[0]);

      var players = members.map(function (memberName, i) {
        var prow = data[r2 + 1 + i] || [];
        return {
          name: drawn ? memberName : ((prow[4] || '').toString().trim() || memberName),
          gw: prow[summaryCol] || 0,
          gl: prow[summaryCol + 1] || 0,
          ptsWL: prow[summaryCol + 2] || '',
          score: prow[summaryCol + 3] || '',
          rank: prow[summaryCol + 4] || '',
          rankPts: prow[summaryCol + 5] || ''
        };
      });
      pools.push({ label: m[1], drawn: drawn, players: players });
    }
  }

  return { date: dateISO, exists: true, hasScores: anyScoresEntered(data), signups: signups, pools: pools };
}

// True once any score has been typed into any pool's H..H+size grid block.
function anyScoresEntered(data) {
  for (var i = 0; i < POOL_LETTERS.length; i++) {
    var lay = POOL_LAYOUT[POOL_LETTERS[i]];
    for (var r = 0; r < lay.size; r++) {
      var row = data[lay.firstSlotRow - 1 + r] || [];
      for (var c = 0; c < lay.size; c++) {
        var v = row[GRID_FIRST_COL - 1 + c];
        if (v !== '' && v !== null && v !== undefined) return true;
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
  return { players: players };
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

function getPin(dateISO, secret) {
  var expected = PropertiesService.getScriptProperties().getProperty('ADMIN_SECRET');
  if (!expected) return { ok: false, error: 'ADMIN_SECRET script property is not set — set it in Apps Script project settings.' };
  if (String(secret || '') !== expected) return { ok: false, error: 'Wrong passphrase.' };
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

// Run once from the editor: installs the Wednesday-noon PIN email trigger.
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendWeeklyPin') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendWeeklyPin')
    .timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(12)
    .inTimezone('America/Los_Angeles')
    .create();
}

// ---- Pool generation ----

// Signups are often typed as short names ("Ellyn") while Rankings holds full
// names ("Ellyn Park"): fall back to a unique-prefix match before treating a
// player as unranked (9999 = seeded last, in signup order).
function rankFor(rankedPlayers, name) {
  var key = (name || '').trim().toLowerCase();
  var prefixHit = null, prefixHits = 0;
  for (var i = 0; i < rankedPlayers.length; i++) {
    var rname = rankedPlayers[i].name.toLowerCase();
    if (rname === key) return rankedPlayers[i].rank;
    if (rname.indexOf(key + ' ') === 0) { prefixHit = rankedPlayers[i]; prefixHits++; }
  }
  return prefixHits === 1 ? prefixHit.rank : 9999;
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
  return { ok: true };
}
