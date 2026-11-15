/**
 * Quest Deck addition for the expense logger (Trip_Expense_Tracker).
 * Lets the Quest Deck Money tab READ your logged payments and set a category with one tap.
 * It does not change how the Shortcut logs bank SMS or cash.
 *
 * Install (about 5 minutes, on a computer):
 *  1. Open the sheet > Extensions > Apps Script.
 *  2. Click + next to Files > Script. Name it QuestDeck. Paste this whole file. Save.
 *  3. Open Code.gs. Find the line that starts  function doPost(e) {
 *     and add this as the FIRST line inside it:
 *         var qd = questDeckHandle_(e); if (qd) return qd;
 *     Save.
 *  4. Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy.
 *     The Web app URL stays the same.
 *
 * Updating later: replace the whole QuestDeck file with the new version, save, then do step 4 again.
 * Code.gs does not need to change.
 *
 * It uses the same SECRET as Code.gs. Requests without the right secret get nothing.
 */

var QD_EXPENSES = 'Expenses';
var QD_SETTINGS = 'Settings';
var QD_FALLBACK_CATEGORIES = ['Food', 'Transport', 'Stay', 'Shopping', 'Activities', 'Fees & Forex', 'Other', 'Uncategorized', 'Cash Withdrawal'];
var QD_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Returns a response for Quest Deck requests, or null so the normal logger carries on. */
function questDeckHandle_(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return null; }
  if (!body || !body.qd) return null;
  if (String(body.token || '') !== String(SECRET)) return qdOut_({ ok: false, error: 'bad_token' });
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(QD_EXPENSES);
  if (!sh) return qdOut_({ ok: false, error: 'no_expenses_tab' });
  try {
    if (body.qd === 'list') return qdOut_(qdList_(ss, sh, body));
    if (body.qd === 'categorize') return qdOut_(qdCategorize_(ss, sh, body));
    if (body.qd === 'update') return qdOut_(qdUpdate_(ss, sh, body));
    if (body.qd === 'addCategory') return qdOut_(qdCategoryAdd_(ss, body));
    if (body.qd === 'removeCategory') return qdOut_(qdCategoryRemove_(ss, body));
  } catch (err) {
    return qdOut_({ ok: false, error: 'failed', detail: String(err) });
  }
  return qdOut_({ ok: false, error: 'unknown_action' });
}

function qdOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Row number of the header (the row whose first cell says Date). */
function qdHeaderRow_(sh) {
  var top = sh.getRange(1, 1, Math.min(10, sh.getMaxRows()), 1).getDisplayValues();
  for (var i = 0; i < top.length; i++) if (String(top[i][0]).trim().toLowerCase() === 'date') return i + 1;
  return 1;
}

/** A sheet date (Date object or text like 16-Oct-26) as yyyy-MM-dd, or '' if it is not a date. */
function qdDate_(v, tz) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  var m = String(v || '').trim().match(/^(\d{1,2})[-\/ ]([A-Za-z]{3})[A-Za-z]*[-\/ ](\d{2,4})$/);
  if (!m) return '';
  var mo = QD_MONTHS[m[2].toLowerCase()];
  if (!mo) return '';
  var y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + m[1]).slice(-2);
}

function qdCategories_(ss) {
  var st = ss.getSheetByName(QD_SETTINGS);
  if (!st) return QD_FALLBACK_CATEGORIES;
  var vals = st.getRange(1, 4, Math.min(60, st.getMaxRows()), 1).getDisplayValues();
  var out = [], started = false;
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0]).trim();
    if (!started) { if (v.toLowerCase() === 'category') started = true; continue; }
    if (!v) break;
    out.push(v);
  }
  return out.length ? out : QD_FALLBACK_CATEGORIES;
}

/** Reads the Expenses rows as plain objects. Columns: A Date, B Time, C Amount, D Currency, E INR, F Merchant, G Category, H Method, I Source. */
function qdRows_(ss, sh) {
  var tz = ss.getSpreadsheetTimeZone();
  var hr = qdHeaderRow_(sh), last = sh.getLastRow(), rows = [];
  if (last <= hr) return rows;
  var n = last - hr;
  var vals = sh.getRange(hr + 1, 1, n, 9).getValues();
  var disp = sh.getRange(hr + 1, 1, n, 3).getDisplayValues();
  for (var i = 0; i < n; i++) {
    var date = qdDate_(vals[i][0], tz) || qdDate_(disp[i][0], tz);
    if (!date) continue;
    var inr = Number(vals[i][4]);
    if (isNaN(inr) || vals[i][4] === '') inr = Number(String(disp[i][2]).replace(/,/g, '')) || 0;
    rows.push({
      row: hr + 1 + i, date: date, time: String(disp[i][1] || ''), inr: inr,
      merchant: String(vals[i][5] || ''), category: String(vals[i][6] || 'Uncategorized'),
      method: String(vals[i][7] || ''), source: String(vals[i][8] || '')
    });
  }
  return rows;
}

function qdList_(ss, sh, body) {
  var since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since || '')) ? body.since : '';
  var rows = qdRows_(ss, sh).filter(function (r) { return !since || r.date >= since; });
  return { ok: true, rows: rows, categories: qdCategories_(ss) };
}

/** Sets the category on one row, on other recent Uncategorized rows from the same merchant, and remembers the merchant. */
function qdCategorize_(ss, sh, body) {
  var category = String(body.category || '').trim();
  var allowed = qdCategories_(ss).concat(['Ignored']);
  if (allowed.indexOf(category) < 0) return { ok: false, error: 'bad_category' };
  var rows = qdRows_(ss, sh), target = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].row === Number(body.row)) target = rows[i];
  if (!target) return { ok: false, error: 'no_row' };
  if (String(body.merchant || '') !== target.merchant) return { ok: false, error: 'row_changed' };

  var generic = /^(cash spend|unknown merchant)$/i.test(target.merchant);
  var since = /^\d{4}-\d{2}-\d{2}$/.test(String(body.since || '')) ? body.since : '';
  var updated = [];
  rows.forEach(function (r) {
    var same = r.row === target.row ||
      (category !== 'Ignored' && !generic && since && r.merchant === target.merchant && r.category === 'Uncategorized' && r.date >= since);
    if (same) { sh.getRange(r.row, 7).setValue(category); updated.push(r.row); }
  });

  if (body.remember && category !== 'Ignored' && !generic && target.merchant) qdRemember_(ss, target.merchant, category);
  return { ok: true, updated: updated };
}

/** Where the category list sits on the Settings tab: the row of its "Category" heading in column D. */
function qdCategoryHead_(st) {
  var vals = st.getRange(1, 4, Math.min(60, st.getMaxRows()), 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toLowerCase() === 'category') return i + 1;
  return 0;
}

/** Adds a category to the end of the list on the Settings tab (column D). */
function qdCategoryAdd_(ss, body) {
  var st = ss.getSheetByName(QD_SETTINGS);
  var head = st ? qdCategoryHead_(st) : 0;
  if (!head) return { ok: false, error: 'no_category_list' };
  var name = qdClean_(String(body.name || '').slice(0, 30));
  if (!name) return { ok: false, error: 'bad_name' };
  var names = qdCategories_(ss);
  for (var i = 0; i < names.length; i++) if (names[i].toLowerCase() === name.toLowerCase()) return { ok: false, error: 'exists' };
  st.getRange(head + 1 + names.length, 4).setValue(name);
  return { ok: true, categories: qdCategories_(ss) };
}

/**
 * Removes a category from the list (column D) and closes the gap, keeping each
 * category's budget in column E on the same row. Past payments are not touched.
 */
function qdCategoryRemove_(ss, body) {
  var st = ss.getSheetByName(QD_SETTINGS);
  var head = st ? qdCategoryHead_(st) : 0;
  if (!head) return { ok: false, error: 'no_category_list' };
  var name = String(body.name || '').trim();
  if (/^(uncategorized|cash withdrawal)$/i.test(name)) return { ok: false, error: 'protected' };
  var names = qdCategories_(ss);
  var idx = names.indexOf(name);
  if (idx < 0) return { ok: true, categories: names };
  var range = st.getRange(head + 1, 4, names.length, 2);
  var block = range.getValues();
  block.splice(idx, 1);
  block.push(['', '']);
  range.setValues(block);
  return { ok: true, categories: qdCategories_(ss) };
}

/** Text that begins with = + - or @ would be read as a formula, so it is made plain text. */
function qdClean_(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/**
 * Corrects one row: name, date, category, and the amount for cash rows only.
 * Amounts that came from a bank SMS are never changed.
 */
function qdUpdate_(ss, sh, body) {
  var set = body.set || {};
  var rows = qdRows_(ss, sh), target = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].row === Number(body.row)) target = rows[i];
  if (!target) return { ok: false, error: 'no_row' };
  if (String(body.merchant || '') !== target.merchant) return { ok: false, error: 'row_changed' };

  // check everything first, write only if all of it is valid
  var writes = [];
  if (set.category !== undefined) {
    var category = String(set.category).trim();
    if (qdCategories_(ss).concat(['Ignored']).indexOf(category) < 0) return { ok: false, error: 'bad_category' };
    writes.push(function () { sh.getRange(target.row, 7).setValue(category); });
  }
  if (set.merchant !== undefined) {
    var name = qdClean_(String(set.merchant).slice(0, 80));
    if (!name) return { ok: false, error: 'bad_name' };
    writes.push(function () { sh.getRange(target.row, 6).setValue(name); });
  }
  if (set.date !== undefined) {
    var m = String(set.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return { ok: false, error: 'bad_date' };
    var serial = Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
    writes.push(function () { sh.getRange(target.row, 1).setValue(serial).setNumberFormat('dd-mmm-yy'); });
  }
  if (set.amount !== undefined) {
    if (target.method.toLowerCase() !== 'cash') return { ok: false, error: 'amount_locked' };
    var amount = Number(set.amount);
    if (!(amount > 0) || amount > 10000000) return { ok: false, error: 'bad_amount' };
    writes.push(function () { sh.getRange(target.row, 3).setValue(amount); });
  }
  writes.forEach(function (w) { w(); });
  return { ok: true, updated: [target.row] };
}

/** Adds (or updates) a keyword rule on the Settings tab so the next payment to this merchant is categorised on arrival. */
function qdRemember_(ss, merchant, category) {
  var st = ss.getSheetByName(QD_SETTINGS);
  if (!st) return;
  var col = 9, head = 3;
  var grid = st.getRange(1, 1, Math.min(10, st.getMaxRows()), st.getLastColumn()).getDisplayValues();
  for (var r = 0; r < grid.length; r++) for (var c = 0; c < grid[r].length; c++) {
    if (String(grid[r][c]).trim().toLowerCase() === 'if merchant contains') { col = c + 1; head = r + 1; }
  }
  var key = merchant.toLowerCase().trim();
  var n = Math.max(1, st.getLastRow() - head);
  var vals = st.getRange(head + 1, col, n, 1).getDisplayValues();
  var lastFilled = 0;
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0]).trim().toLowerCase();
    if (v === key) { st.getRange(head + 1 + i, col + 1).setValue(category); return; }
    if (v) lastFilled = i + 1;
  }
  st.getRange(head + 1 + lastFilled, col, 1, 2).setValues([[key, category]]);
}
