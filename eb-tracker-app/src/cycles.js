import AsyncStorage from "@react-native-async-storage/async-storage";
import { calculateCost } from "./tariff";

const CYCLES_KEY = "eb_tracker_cycles_v1";

export async function loadCycles() {
  try {
    const raw = await AsyncStorage.getItem(CYCLES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("Failed to load cycles:", e);
    return [];
  }
}

export async function saveCycles(cycles) {
  try {
    await AsyncStorage.setItem(CYCLES_KEY, JSON.stringify(cycles));
    return true;
  } catch (e) {
    console.error("Failed to save cycles:", e);
    return false;
  }
}

export async function clearAllCycles() {
  try {
    await AsyncStorage.removeItem(CYCLES_KEY);
    return true;
  } catch (e) {
    console.error("Failed to clear cycles:", e);
    return false;
  }
}

// The most recent reading (by date) in a list, or null.
function latestReading(list) {
  return list.reduce((best, reading) => (!best || new Date(reading.date) > new Date(best.date) ? reading : best), null);
}

// A cycle remembers its OPENING READING: the meter value at the moment the previous bill was
// closed. The first reading of a cycle is measured from it, so deleting the old readings can
// never turn the first reading's units into 0.
export function getOrCreateOpenCycle(cycles, meterId = null) {
  const open = cycles.find((cycle) => !cycle.isClosed && (!meterId || cycle.meterId === meterId));
  if (open) return { cycles, openCycle: open };

  const newCycle = {
    id: `${Date.now()}_${meterId || "default"}`,
    meterId: meterId || "default",
    startDate: new Date().toISOString(),
    endDate: null,
    isClosed: false,
    totalUnits: 0,
    totalCost: 0,
    closeReason: null,
    openingReading: null,
    openingDate: null,
  };

  return { cycles: [...cycles, newCycle], openCycle: newCycle };
}

export function closeCurrentCycle(cycles, readings, meterId = null, reason = "bill_generated") {
  const openIndex = cycles.findIndex(
    (cycle) => !cycle.isClosed && (!meterId || cycle.meterId === meterId)
  );
  if (openIndex === -1) return cycles;

  const openCycle = cycles[openIndex];
  const cycleReadings = readings.filter((reading) => reading.cycleId === openCycle.id);
  const totalUnits = cycleReadings.reduce((sum, reading) => sum + (reading.units || 0), 0);
  const totalCost = calculateCost(totalUnits);

  // The bill reading = the latest reading in this cycle. If the cycle has no readings at all,
  // carry its own opening reading forward so the chain is never broken.
  const lastInCycle = latestReading(cycleReadings);
  const closing = lastInCycle
    ? { value: lastInCycle.value, date: lastInCycle.date }
    : openCycle.openingReading != null
      ? { value: openCycle.openingReading, date: openCycle.openingDate || openCycle.startDate }
      : null;

  const now = new Date().toISOString();
  const closedCycle = {
    ...openCycle,
    endDate: now,
    isClosed: true,
    totalUnits,
    totalCost,
    closeReason: reason,
    closingReading: closing ? closing.value : null,
  };

  const newCycle = {
    id: `${Date.now() + 1}_${meterId || "default"}`,
    meterId: meterId || "default",
    startDate: now,
    endDate: null,
    isClosed: false,
    totalUnits: 0,
    totalCost: 0,
    closeReason: null,
    openingReading: closing ? closing.value : null,
    openingDate: closing ? closing.date : null,
  };

  const updated = [...cycles];
  updated[openIndex] = closedCycle;
  return [...updated, newCycle];
}

/**
 * The reading a new reading should be measured from.
 * - normally the previous reading of the meter;
 * - but if the cycle has an opening reading and the previous reading is older than it (or was
 *   deleted), the opening reading is used instead.
 * Returns { value, date } or null.
 */
export function baselineFor(previousReading, cycle, entryDate) {
  if (!cycle || cycle.openingReading == null) return previousReading || null;

  const openingDate = new Date(cycle.openingDate || cycle.startDate);
  if (new Date(entryDate) < openingDate) return previousReading || null;
  if (previousReading && new Date(previousReading.date) >= openingDate) return previousReading;

  return { value: cycle.openingReading, date: openingDate.toISOString() };
}

/**
 * One-time upgrade for cycles saved before opening readings existed (openingReading is
 * undefined). The opening reading is the latest reading of the cycle that was closed at the
 * moment this one started; null when that cannot be found (e.g. its readings were deleted).
 */
export function backfillOpeningReadings(cycles, readings) {
  let changed = false;

  const updated = cycles.map((cycle) => {
    if (cycle.openingReading !== undefined) return cycle;
    changed = true;

    const previousCycle = cycles.find(
      (other) =>
        other.isClosed && other.meterId === cycle.meterId && other.endDate && other.endDate === cycle.startDate
    );
    const closing = previousCycle
      ? latestReading(readings.filter((reading) => reading.cycleId === previousCycle.id))
      : null;

    return {
      ...cycle,
      openingReading: closing ? closing.value : null,
      openingDate: closing ? closing.date : null,
    };
  });

  return { cycles: updated, changed };
}

export function computeCurrentCycleEstimate(openCycle, readings) {
  if (!openCycle) {
    return { totalUnits: 0, totalCost: 0 };
  }

  const cycleReadings = readings.filter((reading) => reading.cycleId === openCycle.id);
  const totalUnits = cycleReadings.reduce((sum, reading) => sum + (reading.units || 0), 0);
  const totalCost = calculateCost(totalUnits);
  return { totalUnits, totalCost };
}

export async function deleteCycle(cycles, cycleIdToDelete) {
  const updated = cycles.filter((cycle) => cycle.id !== cycleIdToDelete);
  await saveCycles(updated);
  return updated;
}