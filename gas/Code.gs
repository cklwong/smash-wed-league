/**
 * Web App backend for the Smash Wed league site.
 * Bind this script to the "2026 Smash Wed League" spreadsheet:
 * Extensions > Apps Script, paste this in as Code.gs, then Deploy.
 *
 * Endpoints (after deploying as a Web App):
 *   GET  ?action=rankings              -> { players: [{name, rank, avg, trend}] }
 *   GET  ?action=week&date=YYYY-MM-DD  -> { date, exists, signups, pools }
 *   POST { action:'join', date, name, contact } -> { ok, row } or { ok:false, error }
 */

var CONTACT_COL = 30; // column AD - far past the template's used columns, to avoid clobbering formulas

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
    signups.push({
      row: r + 1, // 1-based sheet row
      name: name,
      checkedIn: (data[r][1] || '').toString().trim().toLowerCase() === 'y'
    });
  }
  return signups;
}

function getWeek(dateISO) {
  var sheet = getWeekSheet(dateISO);
  if (!sheet) return { date: dateISO, exists: false, signups: [], pools: [] };
  var data = sheet.getDataRange().getValues();
  var signups = parseSignups(data).map(function (s) {
    return { name: s.name, checkedIn: s.checkedIn };
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

  return { date: dateISO, exists: true, signups: signups, pools: pools };
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
  for (var c = 0; c < header.length; c++) {
    if (/ RP$/.test((header[c] || '').toString())) dateCols.push(c); // most-recent-first
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
      trend.push(Number(v));
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
