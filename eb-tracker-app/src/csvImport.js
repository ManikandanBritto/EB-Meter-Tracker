import { calculateCost } from "./tariff";
import { getOrCreateOpenCycle, baselineFor } from "./cycles";
import { detectAnomaly } from "./analysis";
import * as XLSX from "xlsx";

const REQUIRED_HEADERS = ["Date", "Meter", "Reading"];

// ---------------------------------------------------------------------------
// Date parsing (deterministic: never depends on the phone's locale)
// ---------------------------------------------------------------------------

// India writes dates day-first, so 03/04/2026 means 3 April 2026.
// Set to false if your files use US-style month-first dates.
// Only used when the file itself gives no clue (see detectDayFirst below).
const DAY_FIRST_WHEN_AMBIGUOUS = true;

const DATE_HELP = 'Use "YYYY-MM-DD HH:mm" (recommended) or "DD/MM/YYYY HH:mm".';

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// optional time part: " 10:30", "T10:30:15", ", 10:30 PM"
const TIME_PART = "(?:[,\\sT]+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?(?:\\.\\d+)?\\s*([AaPp][Mm])?)?";

// 2026-04-03 | 2026-04-03 10:30 | 2026-04-03T10:30:00 | ...Z | ...+05:30
const ISO_RE = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME_PART}\\s*(Z|[+-]\\d{2}:?\\d{2})?$`, "i");
// 03/04/2026 | 03-04-2026 | 3.4.26 (+ optional time)
const NUM_RE = new RegExp(`^(\\d{1,2})[/\\-.](\\d{1,2})[/\\-.](\\d{4}|\\d{2})${TIME_PART}$`, "i");
// 3 Apr 2026 | 03-Apr-2026
const DMY_NAME_RE = new RegExp(`^(\\d{1,2})[\\s\\-/.]+([A-Za-z]{3,9})\\.?,?[\\s\\-/.]+(\\d{4}|\\d{2})${TIME_PART}$`, "i");
// Apr 3, 2026
const MDY_NAME_RE = new RegExp(`^([A-Za-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME_PART}$`, "i");

const pad = (value) => String(value).padStart(2, "0");

// Dates are plain ASCII. Excel often garbles the narrow no-break space that phones put
// before AM/PM into junk characters (or the text "_x0080_" when the file is a .xlsx), so
// any run of non-ASCII characters / OOXML escapes is simply treated as a space.
const cleanDateText = (value) =>
  String(value)
    .replace(/_x[0-9a-fA-F]{4}_/g, " ")
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function to24(hour, ampm) {
  if (!ampm) return hour;
  if (hour < 1 || hour > 12) return null;
  return (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
}

// Builds a LOCAL date and rejects impossible ones (31/02, 25:00, ...).
function buildLocalDate(year, month0, day, hour, minute, second, ampm) {
  const h = to24(hour, ampm);
  if (h === null || h > 23 || minute > 59 || second > 59) return null;
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(fullYear, month0, day, h, minute, second);
  const same = date.getFullYear() === fullYear && date.getMonth() === month0 && date.getDate() === day;
  return same ? date : null;
}

function monthFromName(name) {
  return MONTHS[name.slice(0, 3).toLowerCase()];
}

// Looks at every dd/mm or mm/dd date in the file. One date like 18/09/2026 (day > 12) or
// 9/18/2026 (second number > 12) proves the order for the whole file, so ambiguous rows
// like 8/10/2026 are read the same way. Falls back to DAY_FIRST_WHEN_AMBIGUOUS.
function detectDayFirst(dateTexts) {
  let dayFirstSeen = false;
  let monthFirstSeen = false;
  dateTexts.forEach((raw) => {
    const m = cleanDateText(raw).match(NUM_RE);
    if (!m) return;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirstSeen = true;
    if (b > 12 && a <= 12) monthFirstSeen = true;
  });
  if (dayFirstSeen && !monthFirstSeen) return true;
  if (monthFirstSeen && !dayFirstSeen) return false;
  return DAY_FIRST_WHEN_AMBIGUOUS;
}

function parseDate(value, rowNumber, dayFirstWhenAmbiguous = DAY_FIRST_WHEN_AMBIGUOUS) {
  const text = cleanDateText(value);
  if (!text) throw new Error(`Row ${rowNumber}: Date is required. ${DATE_HELP}`);

  const num = (v) => (v === undefined ? 0 : Number(v));
  let date = null;
  let m;

  if ((m = text.match(ISO_RE))) {
    const [, y, mo, d, hh, mi, ss, ampm, tz] = m;
    if (tz) {
      // explicit timezone -> an exact instant
      const h = to24(num(hh), ampm);
      if (h !== null && h <= 23) {
        const offset = tz.toUpperCase() === "Z" ? "Z" : tz.replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
        const parsed = new Date(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(num(mi))}:${pad(num(ss))}${offset}`);
        date = Number.isNaN(parsed.getTime()) ? null : parsed;
      }
    } else {
      date = buildLocalDate(Number(y), Number(mo) - 1, Number(d), num(hh), num(mi), num(ss), ampm);
    }
  } else if ((m = text.match(NUM_RE))) {
    const [, a, b, y, hh, mi, ss, ampm] = m;
    let day = Number(a);
    let month = Number(b);
    if (day <= 12 && month > 12) {
      [day, month] = [month, day]; // second number can't be a month -> it is month-first
    } else if (day <= 12 && month <= 12 && !dayFirstWhenAmbiguous) {
      [day, month] = [month, day];
    }
    date = buildLocalDate(Number(y), month - 1, day, num(hh), num(mi), num(ss), ampm);
  } else if ((m = text.match(DMY_NAME_RE))) {
    const [, d, name, y, hh, mi, ss, ampm] = m;
    const month0 = monthFromName(name);
    if (month0 !== undefined) date = buildLocalDate(Number(y), month0, Number(d), num(hh), num(mi), num(ss), ampm);
  } else if ((m = text.match(MDY_NAME_RE))) {
    const [, name, d, y, hh, mi, ss, ampm] = m;
    const month0 = monthFromName(name);
    if (month0 !== undefined) date = buildLocalDate(Number(y), month0, Number(d), num(hh), num(mi), num(ss), ampm);
  }

  if (!date) throw new Error(`Row ${rowNumber}: Date "${text}" isn't valid. ${DATE_HELP}`);
  return date;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsvRecords(csvText) {
  const records = [];
  let record = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];

    if (character === '"') {
      if (inQuotes && csvText[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === "," && !inQuotes) {
      record.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && csvText[index + 1] === "\n") index += 1;
      record.push(cell);
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  if (cell || record.length) {
    record.push(cell);
    if (record.some((value) => value.trim())) records.push(record);
  }

  if (inQuotes) throw new Error("The CSV file has an unfinished quoted value.");
  return records;
}

function parseReading(value, rowNumber) {
  const reading = Number(value.trim());
  if (!value.trim() || !Number.isFinite(reading) || reading < 0) {
    throw new Error(`Row ${rowNumber}: Reading must be a non-negative number.`);
  }
  return reading;
}

function parseUnits(value, rowNumber) {
  const units = Number(value.trim());
  if (!value.trim() || !Number.isFinite(units) || units < 0) {
    throw new Error(`Row ${rowNumber}: Units must be a non-negative number.`);
  }
  return units;
}

export function parseReadingCsv(csvText) {
  const records = parseCsvRecords(csvText.replace(/^\uFEFF/, ""));
  if (records.length < 2) throw new Error("The CSV file does not contain any readings.");

  const headers = records[0].map((header) => header.trim());
  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`Missing required CSV column${missingHeaders.length > 1 ? "s" : ""}: ${missingHeaders.join(", ")}.`);
  }

  const dateIndex = headers.indexOf("Date");
  const meterIndex = headers.indexOf("Meter");
  const readingIndex = headers.indexOf("Reading");
  const unitsIndex = headers.indexOf("Units");
  const remarksIndex = headers.indexOf("Remarks");
  const dayFirst = detectDayFirst(records.slice(1).map((record) => record[dateIndex] || ""));

  return records.slice(1).map((record, index) => {
    const rowNumber = index + 2;
    const meterName = (record[meterIndex] || "").trim();
    if (!meterName) throw new Error(`Row ${rowNumber}: Meter is required.`);

    return {
      date: parseDate(record[dateIndex] || "", rowNumber, dayFirst),
      meterName,
      value: parseReading(record[readingIndex] || "", rowNumber),
      // Units is optional: no column, or a blank cell, means "work it out from the readings".
      units: unitsIndex === -1 || !(record[unitsIndex] || "").trim() ? null : parseUnits(record[unitsIndex], rowNumber),
      remarks: remarksIndex === -1 ? null : (record[remarksIndex] || "").trim() || null,
    };
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const round2 = (value) => Math.round(value * 100) / 100;

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function createMeterId(name, meters) {
  const base = `meter_${Date.now()}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  let id = base;
  let suffix = 2;
  while (meters.some((meter) => meter.id === id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

// Same meter + same minute + same reading = the same reading.
// (Exports only keep the date to the minute, so we compare by minute.)
const duplicateKey = (meterId, dateValue, reading) =>
  `${meterId}|${Math.floor(new Date(dateValue).getTime() / 60000)}|${reading}`;

export function importReadingCsv(csvText, existingReadings, existingMeters, existingCycles) {
  const rows = parseReadingCsv(csvText).sort((a, b) => a.date - b.date);
  const meters = [...existingMeters];
  const cycles = [...existingCycles];
  const readings = [...existingReadings];
  const meterIds = new Map(meters.map((meter) => [meter.name.trim().toLowerCase(), meter.id]));
  const cycleByMeterId = new Map();
  const seen = new Set(readings.map((entry) => duplicateKey(entry.meterId, entry.date, entry.value)));
  let importedCount = 0;
  let skippedCount = 0;

  rows.forEach((row) => {
    const meterKey = row.meterName.toLowerCase();
    let meterId = meterIds.get(meterKey);
    if (!meterId) {
      meterId = createMeterId(row.meterName, meters);
      meters.push({ id: meterId, name: row.meterName });
      meterIds.set(meterKey, meterId);
    }

    // Skip rows that are already in the history (or repeated inside the file).
    const key = duplicateKey(meterId, row.date, row.value);
    if (seen.has(key)) {
      skippedCount += 1;
      return;
    }
    seen.add(key);

    if (!cycleByMeterId.has(meterId)) {
      const result = getOrCreateOpenCycle(cycles, meterId);
      cycles.splice(0, cycles.length, ...result.cycles);
      cycleByMeterId.set(meterId, result.openCycle);
    }

    // A cycle with no readings yet starts "now" when it is created. If the file
    // has older readings, start the cycle at the first imported reading instead.
    let cycle = cycleByMeterId.get(meterId);
    if (row.date < new Date(cycle.startDate) && !readings.some((entry) => entry.cycleId === cycle.id)) {
      const backdated = { ...cycle, startDate: row.date.toISOString() };
      const cycleIndex = cycles.findIndex((item) => item.id === cycle.id);
      if (cycleIndex !== -1) cycles[cycleIndex] = backdated;
      cycleByMeterId.set(meterId, backdated);
      cycle = backdated;
    }

    // This meter's earlier readings, oldest first.
    const history = readings
      .filter((entry) => entry.meterId === meterId && new Date(entry.date) < row.date)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const previous = history.length ? history[history.length - 1] : null;

    // Measure from the previous reading, or from the cycle's opening reading when the
    // previous reading is missing/older (see baselineFor in cycles.js).
    const baseline = baselineFor(previous, cycle, row.date);
    const isMeterReset = Boolean(baseline && row.value < baseline.value);
    const derivedUnits = baseline && !isMeterReset ? round2(row.value - baseline.value) : 0;
    const units = row.units == null ? derivedUnits : round2(row.units);
    const daysSinceLast = baseline
      ? Math.max(1, Math.round((row.date - new Date(baseline.date)) / (1000 * 60 * 60 * 24)))
      : 1;
    const unitsPerDay = baseline && !isMeterReset ? Math.round((units / daysSinceLast) * 100) / 100 : null;

    const priorCycleUnits = readings
      .filter((entry) => entry.cycleId === cycle.id && entry.meterId === meterId)
      .reduce((sum, entry) => sum + (entry.units || 0), 0);
    const cost = isMeterReset ? 0 : roundCurrency(calculateCost(priorCycleUnits + units) - calculateCost(priorCycleUnits));

    // Same anomaly rule as "Save Reading".
    const anomaly = unitsPerDay == null ? { isAnomaly: false, average: null } : detectAnomaly(unitsPerDay, history);

    readings.push({
      id: `import_${Date.now()}_${readings.length}`,
      meterId,
      date: row.date.toISOString(),
      value: row.value,
      units,
      cycleId: cycle.id,
      unitsPerDay,
      isMeterReset,
      cost,
      isAnomaly: anomaly.isAnomaly,
      rollingAverage: anomaly.average,
      remarks: row.remarks,
      attachmentUri: null,
    });
    importedCount += 1;
  });

  return { readings, meters, cycles, importedCount, skippedCount };
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

// Excel stores a date as a serial number. Convert it ourselves (to the minute)
// instead of trusting the cell's display format, which is locale dependent.
function excelSerialToLocalIso(serial) {
  const totalMinutes = Math.round(serial * 1440);
  const day = Math.floor(totalMinutes / 1440);
  const minuteOfDay = totalMinutes - day * 1440;
  const parts = XLSX.SSF.parse_date_code(day);
  if (!parts) return String(serial);
  return `${parts.y}-${pad(parts.m)}-${pad(parts.d)}T${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}:00`;
}

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

export function parseReadingWorkbook(base64Text) {
  const workbook = XLSX.read(base64Text, { type: "base64" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new Error("The Excel file does not contain a worksheet.");

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    header: 1,
    raw: true,
    defval: "",
    blankrows: false,
  });

  const dateColumn = (rows[0] || []).findIndex((header) => String(header).trim() === "Date");

  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, columnIndex) =>
          rowIndex > 0 && columnIndex === dateColumn && typeof cell === "number"
            ? csvCell(excelSerialToLocalIso(cell))
            : csvCell(cell)
        )
        .join(",")
    )
    .join("\n");
}