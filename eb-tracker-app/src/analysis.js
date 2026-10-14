// Validation + anomaly detection for meter readings, all local computation.

/**
 * Validate a new reading against the last one.
 * Returns { valid: boolean, error?: string }
 */
export function validateReading(newValue, lastReading, isMeterReset) {
  if (isNaN(newValue) || newValue < 0) {
    return { valid: false, error: "Enter a valid non-negative number." };
  }
  if (lastReading && !isMeterReset && newValue < lastReading.value) {
    return {
      valid: false,
      error:
        "New reading is lower than the last one. If the meter was replaced/reset, mark it as a reset.",
    };
  }
  return { valid: true };
}

/**
 * Compute units consumed between the new reading and the last one.
 * Returns 0 if this is a reset (can't compute a real delta).
 */
export function computeUnits(newValue, lastReading, isMeterReset) {
  if (!lastReading || isMeterReset) return 0;
  return Math.max(0, Math.round((newValue - lastReading.value) * 100) / 100);
}

/**
 * Flag a reading as anomalous if its daily-equivalent consumption is
 * significantly above the recent historical average.
 * Uses a simple rolling average of the last N non-reset entries.
 */
export function detectAnomaly(unitsPerDay, history, thresholdMultiplier = 1.75) {
  const recent = history
    .filter((r) => !r.isMeterReset && r.unitsPerDay != null)
    .slice(-14); // last ~2 weeks of entries

  if (recent.length < 3) {
    // Not enough history to judge — never flag on sparse data.
    return { isAnomaly: false, average: null };
  }

  const avg =
    recent.reduce((sum, r) => sum + r.unitsPerDay, 0) / recent.length;

  const isAnomaly = avg > 0 && unitsPerDay > avg * thresholdMultiplier;
  return { isAnomaly, average: Math.round(avg * 100) / 100 };
}