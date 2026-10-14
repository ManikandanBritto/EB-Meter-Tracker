import React, { useEffect, useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Switch,
  Alert,
  ScrollView,
  Modal,
  Image,
  Dimensions,
  LogBox,
} from "react-native";
import { Picker } from "@react-native-picker/picker";

LogBox.ignoreLogs(["[expo-image-picker]"]);
import DateTimePicker from "@react-native-community/datetimepicker";
import { StatusBar } from "expo-status-bar";
import { File as ExpoFile } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as Print from "expo-print";
import ViewShot from "react-native-view-shot";
import { BarChart, LineChart } from "react-native-chart-kit";
import { loadReadings, saveReadings, clearAllReadings } from "./src/storage";
import { loadMeters, saveMeters, addMeter, deleteMeter } from "./src/meters";
import { pickAndSaveAttachment, deleteAttachment, clearAllAttachments } from "./src/attachments";
import { calculateCost } from "./src/tariff";
import { validateReading, computeUnits, detectAnomaly } from "./src/analysis";
import { importReadingCsv, parseReadingWorkbook } from "./src/csvImport";
import {
  loadCycles,
  saveCycles,
  getOrCreateOpenCycle,
  closeCurrentCycle,
  computeCurrentCycleEstimate,
  clearAllCycles,
  deleteCycle,
  baselineFor,
  backfillOpeningReadings,
} from "./src/cycles";

const getTodayDate = () => new Date();

const formatDateForInput = (date) => {
  const value = new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const formatTimeForInput = (date) => {
  const value = new Date(date);
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

// Local ISO-style date-time ("2026-04-03T10:30:00"): parses the same on every device,
// so an exported CSV can be imported back.
const formatDateTimeForExport = (date) => `${formatDateForInput(date)}T${formatTimeForInput(date)}:00`;

// The reading a new reading is measured from: the previous reading, or the cycle's opening
// reading when the previous one is missing/older (see baselineFor in src/cycles.js). If
// src/cycles.js is an old copy, fall back to the plain previous reading.
const baselineOf = (previous, cycle, entryDate) =>
  typeof baselineFor === "function" ? baselineFor(previous, cycle, entryDate) : previous || null;

// Re-derives units, units/day, cost and anomaly flags for ONE meter's readings after an
// edit or delete, so later readings never go stale. Readings dated before `fromDate`
// are kept as stored. (Built into App.js so it can't be broken by a missing file.)
const recalculateMeterReadings = (allReadings, meterId, fromDate = null, allCycles = []) => {
  const DAY_MS = 1000 * 60 * 60 * 24;
  const roundTo2 = (value) => Math.round(value * 100) / 100;
  const cutoff = fromDate ? new Date(fromDate).getTime() : -Infinity;
  const cycleById = new Map(allCycles.map((cycle) => [cycle.id, cycle]));

  const others = allReadings.filter((entry) => entry.meterId !== meterId);
  const chain = allReadings
    .filter((entry) => entry.meterId === meterId)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const cycleUnits = new Map(); // cycleId -> units accumulated so far
  const result = [];

  chain.forEach((entry, index) => {
    const previous = index > 0 ? result[index - 1] : null;
    let next = entry;

    if (new Date(entry.date).getTime() >= cutoff) {
      let units = 0;
      let unitsPerDay = null;

      // previous reading, or the cycle's opening reading if the old readings are gone
      const baseline = baselineOf(previous, cycleById.get(entry.cycleId), entry.date);

      if (!entry.isMeterReset && baseline) {
        units = Math.max(0, roundTo2(entry.value - baseline.value));
        const days = Math.max(1, Math.round((new Date(entry.date) - new Date(baseline.date)) / DAY_MS));
        unitsPerDay = roundTo2(units / days);
      }

      const priorUnits = cycleUnits.get(entry.cycleId) || 0;
      const cost = entry.isMeterReset ? 0 : roundTo2(calculateCost(priorUnits + units) - calculateCost(priorUnits));
      const anomaly = unitsPerDay == null ? { isAnomaly: false, average: null } : detectAnomaly(unitsPerDay, result);

      next = { ...entry, units, unitsPerDay, cost, isAnomaly: anomaly.isAnomaly, rollingAverage: anomaly.average };
    }

    cycleUnits.set(next.cycleId, (cycleUnits.get(next.cycleId) || 0) + (next.units || 0));
    result.push(next);
  });

  return [...others, ...result];
};

// Warning text for delete dialogs ("" when nothing is lost): which remaining readings would
// lose their starting point and drop to +0 units if these readings were deleted.
const lostBaselineWarning = (allReadings, idsToDelete, allCycles) => {
  const doomed = new Set(idsToDelete);
  const removed = allReadings.filter((entry) => doomed.has(entry.id));
  if (removed.length === 0) return "";

  const earliestByMeter = new Map();
  removed.forEach((entry) => {
    const time = new Date(entry.date).getTime();
    const current = earliestByMeter.get(entry.meterId);
    if (current === undefined || time < current) earliestByMeter.set(entry.meterId, time);
  });

  let after = allReadings.filter((entry) => !doomed.has(entry.id));
  earliestByMeter.forEach((time, meterId) => {
    after = recalculateMeterReadings(after, meterId, new Date(time), allCycles);
  });

  const before = new Map(allReadings.map((entry) => [entry.id, entry]));
  let count = 0;
  let lostUnits = 0;
  after.forEach((entry) => {
    const old = before.get(entry.id);
    if (!old || entry.isMeterReset) return;
    if ((old.units || 0) > 0 && (entry.units || 0) === 0) {
      count += 1;
      lostUnits += old.units;
    }
  });
  if (count === 0) return "";

  return (
    `⚠ ${count} remaining reading${count === 1 ? "" : "s"} will lose ${count === 1 ? "its" : "their"} starting point ` +
    `and show +0 units (${Math.round(lostUnits * 100) / 100} units of usage would no longer be counted). ` +
    `To keep it, first set the cycle's opening reading on the Status tab.`
  );
};

// Visual only: callers wrap it in a touchable.
const CheckboxBox = ({ checked }) => (
  <View style={[styles.checkboxBox, checked && styles.checkboxBoxChecked]}>
    {checked ? <Text style={styles.checkboxTick}>✓</Text> : null}
  </View>
);

// Shows which step failed instead of the generic red "undefined is not a function" screen.
const showFailure = (title, step, e) => {
  const message = e?.message || String(e);
  const hint = /not a function/i.test(message)
    ? "\n\nA function from a src/ file is missing. Check that the src/ files are the latest versions, then restart with: npx expo start -c"
    : "";
  Alert.alert(title, `Failed at: ${step}\n${message}${hint}`);
};

// Reads the file chosen in the document picker.
// Expo Go (and some phones) reject the old FileSystem.copyAsync on picker files with
// "Location ... isn't readable", so we read the file directly and fall back through
// three different readers until one works.
const readPickedFile = async (uri, asBase64) => {
  const readers = [
    async () => {
      const file = new ExpoFile(uri);
      return asBase64 ? await file.base64() : await file.text();
    },
    async () =>
      FileSystem.readAsStringAsync(uri, {
        encoding: asBase64 ? FileSystem.EncodingType.Base64 : FileSystem.EncodingType.UTF8,
      }),
    async () => {
      const response = await fetch(uri);
      if (!asBase64) return await response.text();
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error || new Error("Could not read file"));
        reader.onloadend = () => resolve(String(reader.result).split(",")[1] || "");
        reader.readAsDataURL(blob);
      });
    },
  ];

  let lastError = null;
  for (const read of readers) {
    try {
      return await read();
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(`Couldn't read the selected file. ${lastError?.message || ""}`.trim());
};

const toSelectedDateWithCurrentTime = (selectedDateValue) => {
  const baseDate = selectedDateValue || getTodayDate();
  return new Date(
    baseDate.getFullYear(),
    baseDate.getMonth(),
    baseDate.getDate(),
    baseDate.getHours(),
    baseDate.getMinutes(),
    baseDate.getSeconds(),
    baseDate.getMilliseconds()
  );
};

const computeMarginalCost = (priorUnits, units) => {
  if (units <= 0) return 0;
  const before = calculateCost(priorUnits);
  const after = calculateCost(priorUnits + units);
  return Math.round((after - before) * 100) / 100;
};

const chartConfig = {
  backgroundGradientFrom: "#1e293b",
  backgroundGradientTo: "#1e293b",
  decimalPlaces: 0,
  color: (opacity = 1) => `rgba(34, 197, 94, ${opacity})`,
  labelColor: (opacity = 1) => `rgba(203, 213, 225, ${opacity})`,
  barPercentage: 0.6,
};

const sharePngFromViewShot = async (captureRef, filename = "eb-tracker-report.png") => {
  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Sharing is not available on this device.");
  }

  if (!captureRef || !captureRef.current) {
    throw new Error("Report view is not ready to export.");
  }

  const uri = await captureRef.current.capture();
  const fileUri = `${FileSystem.documentDirectory}${filename}`;

  await FileSystem.copyAsync({ from: uri, to: fileUri });
  await Sharing.shareAsync(fileUri, {
    mimeType: "image/png",
    dialogTitle: "EB Tracker Report",
  });
};

const exportCsvFromReadings = async (readingsToExport, meters, rangeLabel) => {
  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    throw new Error("Sharing is not available on this device.");
  }

  const exportDir = `${FileSystem.documentDirectory}eb-tracker-export/`;
  await FileSystem.makeDirectoryAsync(exportDir, { intermediates: true });

  const csvRows = [
    ["Date", "Meter", "Reading", "Units", "Cost", "Remarks", "Attachment"],
  ];

  for (let index = 0; index < readingsToExport.length; index += 1) {
    const entry = readingsToExport[index];
    const entryMeter = meters.find((meter) => meter.id === entry.meterId)?.name || entry.meterId;
    let attachmentName = "No attachment";

    if (entry.attachmentUri) {
      const safeName = (entry.attachmentUri.split("/").pop() || `attachment_${index + 1}.jpg`).split("?")[0];
      const extension = safeName.includes(".") ? safeName.slice(safeName.lastIndexOf(".")) : ".jpg";
      const finalName = `attachment_${index + 1}${extension}`;
      const targetUri = `${exportDir}${finalName}`;

      try {
        await FileSystem.copyAsync({ from: entry.attachmentUri, to: targetUri });
        attachmentName = finalName;
      } catch (e) {
        attachmentName = entry.attachmentUri;
      }
    }

    csvRows.push([
      formatDateTimeForExport(entry.date),
      entryMeter,
      String(entry.value ?? ""),
      String(entry.units ?? ""),
      String((entry.cost || 0).toFixed(2)),
      entry.remarks || "",
      attachmentName,
    ]);
  }

  const csvContent = csvRows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  const fileUri = `${FileSystem.documentDirectory}eb-tracker-report.csv`;
  // The leading \uFEFF (UTF-8 marker) makes Excel open the file as UTF-8 instead of garbling
  // non-English characters; our importer strips it again.
  await FileSystem.writeAsStringAsync(fileUri, "\uFEFF" + csvContent, { encoding: FileSystem.EncodingType.UTF8 });
  await Sharing.shareAsync(fileUri, {
    mimeType: "text/csv",
    dialogTitle: `EB Tracker Report - ${rangeLabel}`,
  });
};

const normalizeDateValue = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const matchesDateRange = (value, fromDate, toDate) => {
  const current = normalizeDateValue(value);
  if (!current) return false;

  if (fromDate) {
    const from = new Date(fromDate);
    from.setHours(0, 0, 0, 0);
    if (current < from) return false;
  }

  if (toDate) {
    const to = new Date(toDate);
    to.setHours(23, 59, 59, 999);
    if (current > to) return false;
  }

  return true;
};

export default function App() {
  const [tab, setTab] = useState("add");
  const [cycles, setCycles] = useState([]);
  const [readings, setReadings] = useState([]);
  const [meters, setMeters] = useState([]);
  const [selectedMeterId, setSelectedMeterId] = useState(null);
  const [showAddMeter, setShowAddMeter] = useState(false);
  const [newMeterName, setNewMeterName] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [selectedDate, setSelectedDate] = useState(getTodayDate());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [editDate, setEditDate] = useState(getTodayDate());
  const [editRemarks, setEditRemarks] = useState("");
  const [editAttachmentUri, setEditAttachmentUri] = useState(null);
  const [editIsReset, setEditIsReset] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]); // History: ids of ticked readings
  const [openingModalVisible, setOpeningModalVisible] = useState(false);
  const [openingInput, setOpeningInput] = useState("");
  const [showEditDatePicker, setShowEditDatePicker] = useState(false);
  const [showEditTimePicker, setShowEditTimePicker] = useState(false);
  const [isReset, setIsReset] = useState(false);
  const [remarks, setRemarks] = useState("");
  const [attachmentUri, setAttachmentUri] = useState(null);
  const [filterMeterId, setFilterMeterId] = useState("all");
  const [filterFromDate, setFilterFromDate] = useState(null);
  const [filterToDate, setFilterToDate] = useState(null);
  const [showFilterFromPicker, setShowFilterFromPicker] = useState(false);
  const [showFilterToPicker, setShowFilterToPicker] = useState(false);
  const [viewingImageUri, setViewingImageUri] = useState(null);
  const [loading, setLoading] = useState(true);
  const chartRef = React.useRef(null);

  useEffect(() => {
    (async () => {
      const loadedReadings = await loadReadings();
      const loadedCycles = await loadCycles();
      const loadedMetersList = await loadMeters();
      const resolvedSelectedMeterId = loadedMetersList[0]?.id || null;

      const { cycles: ensuredCycles, openCycle } = getOrCreateOpenCycle(loadedCycles, resolvedSelectedMeterId);

      const migratedReadings = loadedReadings.map((reading) =>
        reading.cycleId ? reading : { ...reading, cycleId: openCycle?.id || "default_cycle" }
      );

      if (JSON.stringify(migratedReadings) !== JSON.stringify(loadedReadings)) {
        await saveReadings(migratedReadings);
      }

      // Cycles saved by older versions have no opening reading yet: work it out once.
      let readyCycles = ensuredCycles;
      let cyclesChanged = ensuredCycles.length !== loadedCycles.length;
      if (typeof backfillOpeningReadings === "function") {
        const backfilled = backfillOpeningReadings(ensuredCycles, migratedReadings);
        readyCycles = backfilled.cycles;
        cyclesChanged = cyclesChanged || backfilled.changed;
      } else {
        Alert.alert(
          "Update needed",
          "src/cycles.js is an old copy. Copy the new src/cycles.js into your project, then restart with: npx expo start -c"
        );
      }
      if (cyclesChanged) {
        await saveCycles(readyCycles);
      }

      setMeters(loadedMetersList);
      setSelectedMeterId(resolvedSelectedMeterId);
      setReadings(migratedReadings);
      setCycles(readyCycles);
      setLoading(false);
    })();
  }, []);

  const currentMeterReadings = selectedMeterId
    ? readings.filter((entry) => entry.meterId === selectedMeterId)
    : [];

  const openCycle = selectedMeterId
    ? cycles.find((cycle) => !cycle.isClosed && cycle.meterId === selectedMeterId) || null
    : null;

  const cycleEstimate = openCycle
    ? computeCurrentCycleEstimate(openCycle, readings)
    : { totalUnits: 0, totalCost: 0 };

  const closedCycles = [...cycles]
    .filter((cycle) => cycle.isClosed)
    .sort((a, b) => new Date(b.endDate || b.startDate) - new Date(a.endDate || a.startDate));

  const getMeterName = (meterId) =>
    meters.find((meter) => meter.id === meterId)?.name || (meterId === "default" ? "Default meter" : meterId);

  const lastReading =
    currentMeterReadings.length > 0
      ? [...currentMeterReadings].sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-1)[0]
      : null;

  const meterFilteredReadings =
    filterMeterId === "all"
      ? readings
      : readings.filter((entry) => entry.meterId === filterMeterId);

  const filteredReadings = meterFilteredReadings.filter((entry) => {
    return matchesDateRange(entry.date, filterFromDate, filterToDate);
  });

  // History selection. Only readings that are BOTH ticked and currently visible count, so a
  // reading hidden by a filter can never be deleted by accident.
  const visibleHistory = [...filteredReadings].sort((a, b) => new Date(b.date) - new Date(a.date));
  const selectedSet = new Set(selectedIds);
  const selectedVisibleIds = visibleHistory.filter((entry) => selectedSet.has(entry.id)).map((entry) => entry.id);
  const allVisibleSelected = visibleHistory.length > 0 && selectedVisibleIds.length === visibleHistory.length;

  const analysisData = (() => {
    const sorted = [...filteredReadings]
      .filter((entry) => !entry.isMeterReset)
      .sort((a, b) => normalizeDateValue(a.date) - normalizeDateValue(b.date));

    const totalUnits = sorted.reduce((sum, entry) => sum + (entry.units || 0), 0);
    const totalCost = sorted.reduce((sum, entry) => sum + (entry.cost || 0), 0);

    return {
      totalUnits,
      totalCost,
      chartLabels: sorted.map((entry) =>
        normalizeDateValue(entry.date)?.toLocaleDateString(undefined, { day: "2-digit", month: "short" }) || ""
      ),
      chartUnits: sorted.map((entry) => Number(entry.units || 0)),
      chartCosts: sorted.map((entry) => Number(entry.cost || 0)),
    };
  })();

  const handleAddReading = useCallback(async () => {
    if (!selectedMeterId) {
      Alert.alert("Select a meter", "Please select a meter before logging a reading.");
      return;
    }

    const value = parseFloat(inputValue);
    const selectedDateTime = toSelectedDateWithCurrentTime(selectedDate);
    // Measure from the last reading - or from the cycle's opening reading if the old readings are gone.
    const baseline = baselineOf(lastReading, openCycle, selectedDateTime);
    const { valid, error } = validateReading(value, baseline, isReset);
    if (!valid) {
      Alert.alert("Invalid reading", error);
      return;
    }

    // Only create a billing cycle once we know the reading will really be saved.
    let activeCycle = openCycle;
    if (!activeCycle) {
      const { cycles: nextCycles, openCycle: nextOpenCycle } = getOrCreateOpenCycle(cycles, selectedMeterId);
      setCycles(nextCycles);
      await saveCycles(nextCycles);
      activeCycle = nextOpenCycle;
    }

    const units = computeUnits(value, baseline, isReset);
    const daysSinceLast = baseline
      ? Math.max(1, Math.round((selectedDateTime - new Date(baseline.date)) / (1000 * 60 * 60 * 24)))
      : 1;
    const unitsPerDay = isReset ? null : units / daysSinceLast;

    const anomaly = isReset
      ? { isAnomaly: false, average: null }
      : detectAnomaly(unitsPerDay, currentMeterReadings);

    const priorCycleUnits = readings
      .filter((entry) => entry.cycleId === activeCycle.id && entry.meterId === selectedMeterId)
      .reduce((sum, entry) => sum + (entry.units || 0), 0);
    const marginalCost = isReset ? 0 : computeMarginalCost(priorCycleUnits, units);

    const entry = {
      id: Date.now().toString(),
      meterId: selectedMeterId,
      date: selectedDateTime.toISOString(),
      value,
      units,
      cycleId: activeCycle.id,
      unitsPerDay: unitsPerDay != null ? Math.round(unitsPerDay * 100) / 100 : null,
      isMeterReset: isReset,
      cost: marginalCost,
      isAnomaly: anomaly.isAnomaly,
      rollingAverage: anomaly.average,
      remarks: remarks.trim() || null,
      attachmentUri: attachmentUri || null,
    };

    const updated = [...readings, entry];
    setReadings(updated);
    await saveReadings(updated);
    setInputValue("");
    setSelectedDate(getTodayDate());
    setShowDatePicker(false);
    setRemarks("");
    setAttachmentUri(null);
    setIsReset(false);

    if (anomaly.isAnomaly) {
      Alert.alert(
        "High usage detected",
        `This reading implies ~${entry.unitsPerDay} units/day, well above your recent average of ~${anomaly.average} units/day.`
      );
    }
  }, [cycles, currentMeterReadings, inputValue, isReset, lastReading, openCycle, readings, remarks, selectedDate, selectedMeterId, attachmentUri]);

  const handleAddMeter = useCallback(async () => {
    const trimmed = newMeterName.trim();
    if (!trimmed) {
      Alert.alert("Meter name required", "Please type a meter name first.");
      return;
    }

    const updated = await addMeter(meters, trimmed);
    const lastAdded = updated[updated.length - 1];
    setMeters(updated);
    setSelectedMeterId(lastAdded.id);
    setNewMeterName("");
    await saveMeters(updated);
  }, [meters, newMeterName]);

  const handleImportCsv = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          "text/csv",
          "text/comma-separated-values",
          "text/plain",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ],
        copyToCacheDirectory: true,
        multiple: false,
      });

      if (result.canceled || !result.assets?.[0]?.uri) return;

      const selectedFile = result.assets[0];
      const isXlsx =
        selectedFile.name?.toLowerCase().endsWith(".xlsx") ||
        selectedFile.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      // The picker already copied the file into the app's cache (copyToCacheDirectory: true),
      // so read it straight from there - no second copy step.
      const imported = isXlsx
        ? importReadingCsv(parseReadingWorkbook(await readPickedFile(selectedFile.uri, true)), readings, meters, cycles)
        : importReadingCsv(await readPickedFile(selectedFile.uri, false), readings, meters, cycles);

      if (imported.importedCount === 0) {
        Alert.alert(
          "Nothing new to import",
          `All ${imported.skippedCount} reading${imported.skippedCount === 1 ? " is" : "s are"} already in your history.`
        );
        return;
      }

      setReadings(imported.readings);
      setMeters(imported.meters);
      setCycles(imported.cycles);
      await saveReadings(imported.readings);
      await saveMeters(imported.meters);
      await saveCycles(imported.cycles);

      const skippedNote = imported.skippedCount
        ? ` ${imported.skippedCount} duplicate${imported.skippedCount === 1 ? "" : "s"} skipped.`
        : "";
      Alert.alert(
        "File imported",
        `${imported.importedCount} reading${imported.importedCount === 1 ? "" : "s"} added to your history.${skippedNote}`
      );
    } catch (e) {
      Alert.alert("Couldn't import file", e.message || "Please select a valid EB Tracker CSV or XLSX file.");
    }
  }, [cycles, meters, readings]);

  const handleDeleteMeter = useCallback(
    async (meterId) => {
      if (!meterId) return;

      const hasSavedData = readings.some((entry) => entry.meterId === meterId);
      if (hasSavedData) {
        Alert.alert(
          "Meter in use",
          "This meter already has saved readings. Delete the readings first before removing the meter."
        );
        return;
      }

      const selectedMeter = meters.find((meter) => meter.id === meterId);
      Alert.alert(
        "Remove meter?",
        `Do you want to remove "${selectedMeter?.name || "this meter"}"?`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: async () => {
              const updatedMeters = await deleteMeter(meters, meterId);
              setMeters(updatedMeters);

              if (selectedMeterId === meterId) {
                setSelectedMeterId(updatedMeters[0]?.id || null);
              }

              await saveMeters(updatedMeters);
            },
          },
        ]
      );
    },
    [meters, readings, selectedMeterId]
  );

  const handleDateChange = (event, date) => {
    setShowDatePicker(false);
    if (date) {
      setSelectedDate(date);
      setShowTimePicker(true);
    }
  };

  const handleTimeChange = (event, time) => {
    setShowTimePicker(false);
    if (time) {
      setSelectedDate((current) => {
        const updated = new Date(current);
        updated.setHours(time.getHours(), time.getMinutes(), 0, 0);
        return updated;
      });
    }
  };

  const openEditModal = useCallback((item) => {
    setEditingItem(item);
    setEditValue(String(item.value));
    setEditDate(new Date(item.date));
    setEditRemarks(item.remarks || "");
    setEditAttachmentUri(item.attachmentUri || null);
    setEditIsReset(Boolean(item.isMeterReset));
    setShowEditDatePicker(false);
    setShowEditTimePicker(false);
  }, []);

  const closeEditModal = useCallback(() => {
    setEditingItem(null);
    setEditValue("");
    setEditDate(getTodayDate());
    setEditRemarks("");
    setEditAttachmentUri(null);
    setEditIsReset(false);
    setShowEditDatePicker(false);
    setShowEditTimePicker(false);
  }, []);

  const handleSaveEditedReading = useCallback(async () => {
    if (!editingItem) return;

    // `step` records what we were doing, so a failure can say exactly where it happened.
    let step = "reading the form";
    try {
    const newValue = parseFloat(editValue);
    const updatedDate = new Date(editDate);

    // Neighbours of the edited reading on the same meter, by date (across cycles,
    // the same way "Save Reading" compares against the last reading).
    const siblings = readings
      .filter((entry) => entry.meterId === editingItem.meterId && entry.id !== editingItem.id)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const previous = [...siblings].reverse().find((entry) => new Date(entry.date) <= updatedDate) || null;
    const next = siblings.find((entry) => new Date(entry.date) > updatedDate) || null;

    // Same rules as adding a reading (including the meter-reset override).
    step = "validateReading (src/analysis.js)";
    const editedCycle = cycles.find((cycle) => cycle.id === editingItem.cycleId);
    const { valid, error } = validateReading(newValue, baselineOf(previous, editedCycle, updatedDate), editIsReset);
    if (!valid) {
      Alert.alert("Invalid reading", error);
      return;
    }

    // The edited value must not overtake the next reading unless that one is a reset.
    if (next && !next.isMeterReset && newValue > next.value) {
      Alert.alert(
        "Invalid reading",
        `This value is higher than the next reading (${next.value}). Fix the later reading first, or mark that one as a meter reset.`
      );
      return;
    }

    const updatedEntry = {
      ...editingItem,
      value: newValue,
      date: updatedDate.toISOString(),
      isMeterReset: editIsReset,
      remarks: editRemarks.trim() || null,
      attachmentUri: editAttachmentUri || null,
    };

    const replaced = readings.map((entry) => (entry.id === editingItem.id ? updatedEntry : entry));

    // Recompute this reading AND every later reading on the meter.
    const fromDate = new Date(Math.min(new Date(editingItem.date).getTime(), updatedDate.getTime()));
    step = "recalculateMeterReadings";
    const updated = recalculateMeterReadings(replaced, editingItem.meterId, fromDate, cycles);

    step = "saveReadings (src/storage.js)";
    setReadings(updated);
    await saveReadings(updated);

    // The photo was replaced: remove the old file so it doesn't pile up on the phone.
    if (editingItem.attachmentUri && editingItem.attachmentUri !== (editAttachmentUri || null)) {
      step = "deleteAttachment (src/attachments.js)";
      await deleteAttachment(editingItem.attachmentUri);
    }

    step = "closing the edit window";
    closeEditModal();
    } catch (e) {
      showFailure("Couldn't save changes", step, e);
    }
  }, [cycles, editAttachmentUri, editDate, editIsReset, editRemarks, editValue, editingItem, readings, closeEditModal]);

  const handleDeleteReading = useCallback(
    (idToDelete) => {
      const warning = lostBaselineWarning(readings, [idToDelete], cycles);
      Alert.alert(
        "Delete reading?",
        "This removes only this selected reading. Later readings for the meter are recalculated." +
          (warning ? `\n\n${warning}` : ""),
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: async () => {
              let step = "finding the reading";
              try {
                const target = readings.find((entry) => entry.id === idToDelete);
                if (!target) return;

                step = "recalculateMeterReadings";
                const remaining = readings.filter((entry) => entry.id !== idToDelete);
                const updated = recalculateMeterReadings(remaining, target.meterId, new Date(target.date), cycles);

                step = "saveReadings (src/storage.js)";
                setReadings(updated);
                await saveReadings(updated);

                // Also remove the photo file that belonged to this reading.
                if (target.attachmentUri) {
                  step = "deleteAttachment (src/attachments.js)";
                  await deleteAttachment(target.attachmentUri);
                }
              } catch (e) {
                showFailure("Couldn't delete reading", step, e);
              }
            },
          },
        ]
      );
    },
    [readings, cycles]
  );

  const handleCloseCycle = useCallback(
    async (reason) => {
      if (!openCycle || !selectedMeterId) return;
      const updatedCycles = closeCurrentCycle(cycles, readings, selectedMeterId, reason);
      setCycles(updatedCycles);
      await saveCycles(updatedCycles);
    },
    [cycles, openCycle, readings, selectedMeterId]
  );

  const handleDownloadPngReport = useCallback(async () => {
    try {
      if (!analysisData.chartLabels.length) {
        Alert.alert("No data", "There are no readings in the selected range.");
        return;
      }

      await sharePngFromViewShot(chartRef, "eb-tracker-report.png");
    } catch (e) {
      Alert.alert("Couldn't export PNG report", e.message || "Unknown error");
    }
  }, [analysisData.chartLabels.length]);

  const handleDownloadCsvReport = useCallback(async () => {
    try {
      if (!filteredReadings.length) {
        Alert.alert("No data", "There are no readings in the selected range.");
        return;
      }

      const rangeLabel =
        (filterFromDate ? formatDateForInput(filterFromDate) : "Start") +
        " to " +
        (filterToDate ? formatDateForInput(filterToDate) : "Today");
      await exportCsvFromReadings(filteredReadings, meters, rangeLabel);
    } catch (e) {
      Alert.alert("Couldn't export CSV report", e.message || "Unknown error");
    }
  }, [filteredReadings, filterFromDate, filterToDate, meters]);

  const handleDownloadImage = useCallback(async (uri) => {
    try {
      const isAvailable = await Sharing.isAvailableAsync();
      if (!isAvailable) {
        Alert.alert("Not available", "Sharing isn't available on this device.");
        return;
      }
      await Sharing.shareAsync(uri);
    } catch (e) {
      Alert.alert("Couldn't share image", e.message);
    }
  }, []);

  const handleDeleteCycle = useCallback(
    (cycleId) => {
      const cycleReadings = readings.filter((entry) => entry.cycleId === cycleId);
      const warning = lostBaselineWarning(readings, cycleReadings.map((entry) => entry.id), cycles);

      const removeCycleOnly = async () => {
        const updatedCycles = await deleteCycle(cycles, cycleId);
        setCycles(updatedCycles);
      };

      const removeCycleAndReadings = async () => {
        let step = "recalculateMeterReadings";
        try {
        // earliest removed reading per meter -> recompute from there
        const earliestByMeter = new Map();
        cycleReadings.forEach((entry) => {
          const time = new Date(entry.date).getTime();
          const current = earliestByMeter.get(entry.meterId);
          if (current === undefined || time < current) earliestByMeter.set(entry.meterId, time);
        });

        let updatedReadings = readings.filter((entry) => entry.cycleId !== cycleId);
        earliestByMeter.forEach((time, meterId) => {
          updatedReadings = recalculateMeterReadings(updatedReadings, meterId, new Date(time), cycles);
        });

        const updatedCycles = await deleteCycle(cycles, cycleId);
        setCycles(updatedCycles);
        setReadings(updatedReadings);
        await saveReadings(updatedReadings);

        step = "deleteAttachment (src/attachments.js)";
        for (const entry of cycleReadings) {
          if (entry.attachmentUri) await deleteAttachment(entry.attachmentUri);
        }
        } catch (e) {
          showFailure("Couldn't delete cycle", step, e);
        }
      };

      if (cycleReadings.length === 0) {
        Alert.alert("Delete this billing cycle?", "This cycle has no readings.", [
          { text: "Cancel", style: "cancel" },
          { text: "Delete", style: "destructive", onPress: removeCycleOnly },
        ]);
        return;
      }

      Alert.alert(
        "Delete this billing cycle?",
        `${cycleReadings.length} reading${cycleReadings.length === 1 ? " was" : "s were"} logged in this cycle.\n\n"Cycle only" keeps them in History. "Cycle + readings" removes them too (and their photos).${warning ? `\n\nIf you choose "Cycle + readings": ${warning}` : ""}`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Cycle only", onPress: removeCycleOnly },
          { text: "Cycle + readings", style: "destructive", onPress: removeCycleAndReadings },
        ]
      );
    },
    [cycles, readings]
  );

  const toggleSelectReading = (id) => {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  // Select All ticks every reading the current filter shows; tapping again un-ticks them.
  const toggleSelectAll = () => {
    const visibleIds = visibleHistory.map((entry) => entry.id);
    if (allVisibleSelected) {
      const visible = new Set(visibleIds);
      setSelectedIds((current) => current.filter((id) => !visible.has(id)));
    } else {
      setSelectedIds((current) => [...new Set([...current, ...visibleIds])]);
    }
  };

  // Deletes ONLY the ticked (and visible) readings, with their photos, and recalculates
  // the later readings of every meter that was touched.
  const handleClearSelected = () => {
    const idsToDelete = selectedVisibleIds;
    if (idsToDelete.length === 0) return;
    const count = idsToDelete.length;
    const warning = lostBaselineWarning(readings, idsToDelete, cycles);

    Alert.alert(
      `Delete ${count} selected reading${count === 1 ? "" : "s"}?`,
      "Only the ticked readings are removed (with their photos). Later readings on the same meter are recalculated. Billing cycles are not changed." +
        (warning ? `\n\n${warning}` : ""),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            let step = "finding the selected readings";
            try {
              const doomed = new Set(idsToDelete);
              const removed = readings.filter((entry) => doomed.has(entry.id));

              // earliest removed reading per meter -> recompute from there
              const earliestByMeter = new Map();
              removed.forEach((entry) => {
                const time = new Date(entry.date).getTime();
                const current = earliestByMeter.get(entry.meterId);
                if (current === undefined || time < current) earliestByMeter.set(entry.meterId, time);
              });

              step = "recalculateMeterReadings";
              let updated = readings.filter((entry) => !doomed.has(entry.id));
              earliestByMeter.forEach((time, meterId) => {
                updated = recalculateMeterReadings(updated, meterId, new Date(time), cycles);
              });

              step = "saveReadings (src/storage.js)";
              setReadings(updated);
              await saveReadings(updated);
              setSelectedIds((current) => current.filter((id) => !doomed.has(id)));

              step = "deleteAttachment (src/attachments.js)";
              for (const entry of removed) {
                if (entry.attachmentUri) await deleteAttachment(entry.attachmentUri);
              }
            } catch (e) {
              showFailure("Couldn't delete selected readings", step, e);
            }
          },
        },
      ]
    );
  };

  const openOpeningModal = () => {
    setOpeningInput(openCycle && openCycle.openingReading != null ? String(openCycle.openingReading) : "");
    setOpeningModalVisible(true);
  };

  // Saves the opening reading (the meter value on your last bill) for the current cycle, then
  // recalculates the cycle's readings so the first one counts its units again.
  const handleSaveOpeningReading = async () => {
    if (!openCycle) return;
    let step = "reading the value";
    try {
      const trimmed = openingInput.trim();
      let value = null;
      if (trimmed !== "") {
        value = parseFloat(trimmed);
        if (!Number.isFinite(value) || value < 0) {
          Alert.alert("Invalid reading", "Enter a valid non-negative number, or leave it empty to remove the opening reading.");
          return;
        }
      }

      const cycleReadings = readings
        .filter((entry) => entry.cycleId === openCycle.id)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const first = cycleReadings[0] || null;

      if (value != null && first && !first.isMeterReset && value > first.value) {
        Alert.alert("Invalid reading", `The opening reading can't be higher than the first reading in this cycle (${first.value}).`);
        return;
      }

      // earliest of "cycle start" and "first reading", so every reading of the cycle is after it
      const openingDate =
        value == null
          ? null
          : new Date(
              Math.min(new Date(openCycle.startDate).getTime(), first ? new Date(first.date).getTime() : Infinity)
            ).toISOString();
      const updatedCycles = cycles.map((cycle) =>
        cycle.id === openCycle.id ? { ...cycle, openingReading: value, openingDate } : cycle
      );

      step = "recalculateMeterReadings";
      const updatedReadings = first
        ? recalculateMeterReadings(readings, first.meterId, new Date(first.date), updatedCycles)
        : readings;

      step = "saving";
      setCycles(updatedCycles);
      await saveCycles(updatedCycles);
      if (first) {
        setReadings(updatedReadings);
        await saveReadings(updatedReadings);
      }
      setOpeningModalVisible(false);
    } catch (e) {
      showFailure("Couldn't save opening reading", step, e);
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.loadingText}>Loading…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <View style={styles.topBar}>
        <View style={styles.brandRow}>
          <View style={styles.brandBadge}>
            <Text style={styles.brandBadgeText}>EBT</Text>
          </View>
          <View style={styles.brandTextWrap}>
            <Text style={styles.header}>EB Tracker</Text>
            <Text style={styles.subheader}>Billing cycle based · local-only tracking</Text>
          </View>
        </View>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity style={[styles.tabButton, tab === "add" && styles.tabButtonActive]} onPress={() => setTab("add")}>
          <Text style={[styles.tabText, tab === "add" && styles.tabTextActive]}>Add Reading</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, tab === "history" && styles.tabButtonActive]} onPress={() => setTab("history")}>
          <Text style={[styles.tabText, tab === "history" && styles.tabTextActive]}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, tab === "status" && styles.tabButtonActive]} onPress={() => setTab("status")}>
          <Text style={[styles.tabText, tab === "status" && styles.tabTextActive]}>Status</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tabButton, tab === "analysis" && styles.tabButtonActive]} onPress={() => setTab("analysis")}>
          <Text style={[styles.tabText, tab === "analysis" && styles.tabTextActive]}>Analysis</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={!!editingItem} transparent animationType="slide" onRequestClose={closeEditModal}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Update Reading</Text>
            <Text style={styles.inputLabel}>Reading date & time</Text>
            <TouchableOpacity
              style={styles.dateButton}
              onPress={() => {
                setShowEditDatePicker(true);
                setShowEditTimePicker(false);
              }}
            >
              <Text style={styles.dateButtonText}>{`${formatDateForInput(editDate)} ${formatTimeForInput(editDate)}`}</Text>
            </TouchableOpacity>
            {showEditDatePicker && (
              <DateTimePicker
                value={editDate}
                mode="date"
                display="calendar"
                onChange={(event, date) => {
                  setShowEditDatePicker(false);
                  if (date) {
                    setEditDate(date);
                    setShowEditTimePicker(true);
                  }
                }}
              />
            )}
            {showEditTimePicker && (
              <DateTimePicker
                value={editDate}
                mode="time"
                display="default"
                onChange={(event, time) => {
                  setShowEditTimePicker(false);
                  if (time) {
                    setEditDate((current) => {
                      const updated = new Date(current);
                      updated.setHours(time.getHours(), time.getMinutes(), 0, 0);
                      return updated;
                    });
                  }
                }}
              />
            )}
            <Text style={styles.inputLabel}>Meter reading</Text>
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              value={editValue}
              onChangeText={setEditValue}
              placeholder="e.g. 4521"
              placeholderTextColor="#64748b"
            />
            <Text style={styles.inputLabel}>Remarks (optional)</Text>
            <TextInput
              style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
              value={editRemarks}
              onChangeText={setEditRemarks}
              placeholder="e.g. AC running extra this week"
              placeholderTextColor="#64748b"
              multiline
            />
            <Text style={styles.inputLabel}>Attachment (optional)</Text>
            <TouchableOpacity
              style={styles.dateButton}
              onPress={async () => {
                try {
                  const uri = await pickAndSaveAttachment();
                  if (uri) setEditAttachmentUri(uri);
                } catch (e) {
                  Alert.alert("Couldn't attach photo", e.message);
                }
              }}
            >
              <Text style={styles.dateButtonText}>{editAttachmentUri ? "Photo attached ✓ (tap to replace)" : "Attach a photo"}</Text>
            </TouchableOpacity>
            {editAttachmentUri && (
              <Image source={{ uri: editAttachmentUri }} style={{ width: 50, height: 50, borderRadius: 6, marginBottom: 16 }} />
            )}
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Meter reset (new meter started here)</Text>
              <Switch value={editIsReset} onValueChange={setEditIsReset} />
            </View>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelButton} onPress={closeEditModal}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryButton} onPress={handleSaveEditedReading}>
                <Text style={styles.primaryButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={openingModalVisible} transparent animationType="slide" onRequestClose={() => setOpeningModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Opening reading</Text>
            <Text style={styles.inputLabel}>
              Meter reading at the start of this billing cycle (the reading on your last bill). The first reading you log
              is measured from it. Leave empty to remove.
            </Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              value={openingInput}
              onChangeText={setOpeningInput}
              placeholder="e.g. 1500"
              placeholderTextColor="#64748b"
            />
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelButton} onPress={() => setOpeningModalVisible(false)}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.primaryButton} onPress={handleSaveOpeningReading}>
                <Text style={styles.primaryButtonText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!viewingImageUri} transparent animationType="fade" onRequestClose={() => setViewingImageUri(null)}>
        <View style={styles.imageViewerOverlay}>
          <View style={styles.imageViewerTopBar}>
            <TouchableOpacity style={styles.imageViewerIconButton} onPress={() => handleDownloadImage(viewingImageUri)}>
              <Text style={styles.imageViewerIconText}>⬇</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.imageViewerIconButton} onPress={() => setViewingImageUri(null)}>
              <Text style={styles.imageViewerIconText}>✕</Text>
            </TouchableOpacity>
          </View>
          {viewingImageUri && (
            <Image source={{ uri: viewingImageUri }} style={styles.imageViewerFullImage} resizeMode="contain" />
          )}
        </View>
      </Modal>

      {tab === "add" ? (
        <>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
            <View style={styles.card}>
              <Text style={styles.cardLabel}>Last reading</Text>
              <Text style={styles.cardValue}>
                {lastReading ? `${lastReading.value} units` : "No readings yet"}
              </Text>
              <Text style={styles.cardSubtext}>
                {lastReading
                  ? new Date(lastReading.date).toLocaleString()
                  : openCycle && openCycle.openingReading != null
                    ? `Opening reading ${openCycle.openingReading} - your first reading is measured from it`
                    : "Enter your first meter reading below"}
              </Text>
            </View>

          <Text style={styles.inputLabel}>Meter</Text>
          <View style={styles.pickerWrapper}>
            <Picker
              selectedValue={selectedMeterId}
              onValueChange={(value) => setSelectedMeterId(value)}
              style={{ color: "#fff" }}
              dropdownIconColor="#fff"
            >
              {meters.map((meter) => (
                <Picker.Item key={meter.id} label={meter.name} value={meter.id} />
              ))}
            </Picker>
          </View>

          <View style={styles.filterRow}>
            <TouchableOpacity onPress={() => setShowAddMeter((current) => !current)} style={[styles.secondaryActionButton, { flex: 1, marginRight: 8 }]}>
              <Text style={styles.secondaryActionButtonText}>
                {showAddMeter ? "− Cancel" : "+ Add Meter"}
              </Text>
            </TouchableOpacity>

            {selectedMeterId && (
              <TouchableOpacity
                onPress={() => handleDeleteMeter(selectedMeterId)}
                style={[styles.removeMeterButton, { flex: 1, marginLeft: 8 }]}
              >
                <Text style={styles.removeMeterButtonText}>− Remove Meter</Text>
              </TouchableOpacity>
            )}
          </View>

          <TouchableOpacity style={styles.secondaryActionButton} onPress={handleImportCsv}>
            <Text style={styles.secondaryActionButtonText}>Import readings from CSV or XLSX</Text>
          </TouchableOpacity>

          {showAddMeter && (
            <View style={{ marginBottom: 16 }}>
              <TextInput
                style={styles.input}
                value={newMeterName}
                onChangeText={setNewMeterName}
                placeholder="Enter a new meter name"
                placeholderTextColor="#64748b"
              />
              <TouchableOpacity
                style={styles.secondaryActionButton}
                onPress={async () => {
                  const trimmed = newMeterName.trim();
                  if (!trimmed) {
                    Alert.alert("Meter name required", "Please type a meter name first.");
                    return;
                  }

                  const updated = await addMeter(meters, trimmed);
                  const lastAdded = updated[updated.length - 1];
                  setMeters(updated);
                  setSelectedMeterId(lastAdded.id);
                  setNewMeterName("");
                  setShowAddMeter(false);
                  await saveMeters(updated);
                }}
              >
                <Text style={styles.secondaryActionButtonText}>Add Meter</Text>
              </TouchableOpacity>
            </View>
          )}

          <Text style={styles.inputLabel}>Reading date & time</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={() => {
              setShowDatePicker(true);
              setShowTimePicker(false);
            }}
          >
            <Text style={styles.dateButtonText}>{`${formatDateForInput(selectedDate)} ${formatTimeForInput(selectedDate)}`}</Text>
          </TouchableOpacity>

          {showDatePicker && (
            <DateTimePicker value={selectedDate} mode="date" display="calendar" onChange={handleDateChange} />
          )}
          {showTimePicker && (
            <DateTimePicker value={selectedDate} mode="time" display="default" onChange={handleTimeChange} />
          )}

          <Text style={styles.inputLabel}>Current meter reading</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            value={inputValue}
            onChangeText={setInputValue}
            placeholder="e.g. 4521"
            placeholderTextColor="#64748b"
          />

          <Text style={styles.inputLabel}>Remarks (optional)</Text>
          <TextInput
            style={[styles.input, { minHeight: 90, textAlignVertical: "top" }]}
            value={remarks}
            onChangeText={setRemarks}
            placeholder="e.g. AC running extra this week"
            placeholderTextColor="#64748b"
            multiline
          />

          <Text style={styles.inputLabel}>Attachment (optional)</Text>
          <TouchableOpacity
            style={styles.dateButton}
            onPress={async () => {
              try {
                const uri = await pickAndSaveAttachment();
                if (uri) setAttachmentUri(uri);
              } catch (e) {
                Alert.alert("Couldn't attach photo", e.message);
              }
            }}
          >
            <Text style={styles.dateButtonText}>
              {attachmentUri ? "Photo attached ✓ (tap to replace)" : "Attach a photo"}
            </Text>
          </TouchableOpacity>
          {attachmentUri && (
            <Image source={{ uri: attachmentUri }} style={{ width: 50, height: 50, borderRadius: 6, marginBottom: 16 }} />
          )}

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Meter was replaced / reset (this reading starts from a new meter)</Text>
            <Switch value={isReset} onValueChange={setIsReset} />
          </View>

          </ScrollView>

          <View style={styles.fixedFooter}>
            <TouchableOpacity style={styles.primaryButton} onPress={handleAddReading}>
              <Text style={styles.primaryButtonText}>Save Reading</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : tab === "history" ? (
        <View style={styles.content}>
          <View style={styles.filterRow}>
            <View style={[styles.pickerWrapper, { flex: 1 }]}>
              <Picker
                selectedValue={filterMeterId}
                onValueChange={setFilterMeterId}
                style={{ color: "#fff" }}
                dropdownIconColor="#fff"
              >
                <Picker.Item label="All meters" value="all" />
                {meters.map((meter) => (
                  <Picker.Item key={meter.id} label={meter.name} value={meter.id} />
                ))}
              </Picker>
            </View>
          </View>

          <View style={styles.filterRow}>
            <TouchableOpacity style={[styles.dateButton, { flex: 1, marginRight: 8 }]} onPress={() => setShowFilterFromPicker(true)}>
              <Text style={styles.dateButtonText}>From: {filterFromDate ? formatDateForInput(filterFromDate) : "Any"}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.dateButton, { flex: 1 }]} onPress={() => setShowFilterToPicker(true)}>
              <Text style={styles.dateButtonText}>To: {filterToDate ? formatDateForInput(filterToDate) : "Any"}</Text>
            </TouchableOpacity>
          </View>

          {showFilterFromPicker && (
            <DateTimePicker
              value={filterFromDate || getTodayDate()}
              mode="date"
              display="calendar"
              onChange={(event, date) => {
                setShowFilterFromPicker(false);
                if (date) setFilterFromDate(date);
              }}
            />
          )}
          {showFilterToPicker && (
            <DateTimePicker
              value={filterToDate || getTodayDate()}
              mode="date"
              display="calendar"
              onChange={(event, date) => {
                setShowFilterToPicker(false);
                if (date) setFilterToDate(date);
              }}
            />
          )}

          {(filterFromDate || filterToDate || filterMeterId !== "all") && (
            <TouchableOpacity
              onPress={() => {
                setFilterMeterId("all");
                setFilterFromDate(null);
                setFilterToDate(null);
              }}
              style={{ marginBottom: 12 }}
            >
              <Text style={{ color: "#f59e0b", fontSize: 13 }}>Clear filters</Text>
            </TouchableOpacity>
          )}

          <FlatList
            data={visibleHistory}
            extraData={selectedIds}
            keyExtractor={(item) => item.id}
            ListEmptyComponent={<Text style={styles.emptyText}>No readings logged yet.</Text>}
            renderItem={({ item }) => (
              <View
                style={[
                  styles.historyRow,
                  item.isAnomaly && styles.historyRowAnomaly,
                  selectedSet.has(item.id) && styles.historyRowSelected,
                ]}
              >
                <TouchableOpacity
                  onPress={() => toggleSelectReading(item.id)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={{ marginRight: 12 }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selectedSet.has(item.id) }}
                  accessibilityLabel="Select reading"
                >
                  <CheckboxBox checked={selectedSet.has(item.id)} />
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyValue}>
                    {item.value} units {item.isMeterReset ? "(meter reset)" : `· ${meters.find((meter) => meter.id === item.meterId)?.name || item.meterId}`}
                  </Text>
                  <Text style={styles.historyDate}>{new Date(item.date).toLocaleString()}</Text>
                  {!item.isMeterReset && (
                    <Text style={styles.historyMeta}>
                      +{item.units} units · {item.cost.toFixed(2)} · {item.unitsPerDay != null ? item.unitsPerDay : "—"}/day
                    </Text>
                  )}
                  {item.remarks && <Text style={styles.historyMeta}>📝 {item.remarks}</Text>}
                  {item.attachmentUri && (
                    <TouchableOpacity onPress={() => setViewingImageUri(item.attachmentUri)}>
                      <Image source={{ uri: item.attachmentUri }} style={styles.historyThumb} />
                    </TouchableOpacity>
                  )}
                  {item.isAnomaly && <Text style={styles.anomalyBadge}>⚠ High usage</Text>}
                </View>

                <View style={styles.actionButtons}>
                  <TouchableOpacity style={styles.editButton} onPress={() => openEditModal(item)}>
                    <Text style={styles.editButtonText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.deleteButton} onPress={() => handleDeleteReading(item.id)}>
                    <Text style={styles.deleteButtonText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          />
          {readings.length > 0 && (
            <View style={styles.selectionBar}>
              <TouchableOpacity
                style={styles.selectAllRow}
                onPress={toggleSelectAll}
                disabled={visibleHistory.length === 0}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: allVisibleSelected }}
              >
                <CheckboxBox checked={allVisibleSelected} />
                <Text style={styles.selectAllText}>
                  Select All{visibleHistory.length ? ` (${visibleHistory.length})` : ""}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.clearSelectedButton, selectedVisibleIds.length === 0 && styles.clearSelectedDisabled]}
                onPress={handleClearSelected}
                disabled={selectedVisibleIds.length === 0}
              >
                <Text style={styles.clearSelectedText}>Clear selected data ({selectedVisibleIds.length})</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      ) : tab === "analysis" ? (
        <ScrollView style={styles.content}>
          <View style={styles.summaryCard}>
            <Text style={styles.cardLabel}>Total units</Text>
            <Text style={styles.summaryValue}>{analysisData.totalUnits}</Text>
            <Text style={styles.cardLabel}>Total cost</Text>
            <Text style={styles.summaryValue}>{analysisData.totalCost.toFixed(2)}</Text>
          </View>

          {analysisData.chartLabels.length > 0 ? (
            <ViewShot ref={chartRef} options={{ format: "png", quality: 0.9 }}>
              <View style={styles.analysisChartCard}>
                <Text style={styles.sectionHeading}>Units consumed</Text>
                <BarChart
                  data={{ labels: analysisData.chartLabels, datasets: [{ data: analysisData.chartUnits }] }}
                  width={Dimensions.get("window").width - 64}
                  height={220}
                  yAxisSuffix=" u"
                  chartConfig={chartConfig}
                  style={{ borderRadius: 8 }}
                />
                <Text style={[styles.sectionHeading, { marginTop: 20 }]}>Cost trend</Text>
                <LineChart
                  data={{ labels: analysisData.chartLabels, datasets: [{ data: analysisData.chartCosts }] }}
                  width={Dimensions.get("window").width - 64}
                  height={220}
                  yAxisPrefix=""
                  chartConfig={chartConfig}
                  style={{ borderRadius: 8 }}
                />
              </View>
            </ViewShot>
          ) : (
            <Text style={styles.emptyText}>No readings available for analysis yet.</Text>
          )}

          {analysisData.chartLabels.length > 0 && (
            <View style={{ gap: 10 }}>
              <TouchableOpacity style={styles.primaryButton} onPress={handleDownloadPngReport}>
                <Text style={styles.primaryButtonText}>Download PNG</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.primaryButton, { backgroundColor: "#0f766e" }]} onPress={handleDownloadCsvReport}>
                <Text style={styles.primaryButtonText}>Download CSV</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      ) : (
        <View style={styles.content}>
          <FlatList
            data={closedCycles}
            keyExtractor={(cycle) => cycle.id}
            ListHeaderComponent={
              <>
              <Text style={styles.inputLabel}>Meter</Text>
              <View style={styles.pickerWrapper}>
                <Picker
                  selectedValue={selectedMeterId}
                  onValueChange={(value) => setSelectedMeterId(value)}
                  style={{ color: "#fff" }}
                  dropdownIconColor="#fff"
                >
                  {meters.map((meter) => (
                    <Picker.Item key={meter.id} label={meter.name} value={meter.id} />
                  ))}
                </Picker>
              </View>
              <View style={styles.summaryCard}>
                <Text style={styles.cardLabel}>{`Current cycle estimate · ${getMeterName(selectedMeterId)}`}</Text>
                <Text style={styles.summaryValue}>{cycleEstimate.totalCost.toFixed(2)}</Text>
                <Text style={styles.cardSubtext}>
                  {openCycle
                    ? `Units in current cycle: ${cycleEstimate.totalUnits} • cycle started ${new Date(openCycle.startDate).toLocaleString()}`
                    : "No active cycle yet"}
                </Text>
                {openCycle && (
                  <View>
                    <View style={styles.openingRow}>
                      <Text style={styles.openingText}>
                        {openCycle.openingReading != null
                          ? `Opening reading: ${openCycle.openingReading}`
                          : "Opening reading: not set"}
                      </Text>
                      <TouchableOpacity style={styles.linkButton} onPress={openOpeningModal}>
                        <Text style={styles.linkButtonText}>{openCycle.openingReading != null ? "Change" : "Set"}</Text>
                      </TouchableOpacity>
                    </View>
                    {openCycle.openingReading == null && (
                      <Text style={styles.openingHint}>
                        Enter the meter reading from your last bill (e.g. 1500) so the first reading in this cycle counts
                        its units instead of showing +0.
                      </Text>
                    )}
                  </View>
                )}
                {openCycle && (
                  <View style={styles.cycleActionRow}>
                    <TouchableOpacity style={styles.secondaryActionButton} onPress={() => handleCloseCycle("bill_generated")}>
                      <Text style={styles.secondaryActionButtonText}>Mark Bill Generated</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.secondaryActionButton} onPress={() => handleCloseCycle("paid")}>
                      <Text style={styles.secondaryActionButtonText}>Mark Paid</Text>
                    </TouchableOpacity>
                  </View>
                )}
                {closedCycles.length > 0 && (
                  <Text style={[styles.sectionHeading, { marginTop: 24 }]}>Past billing cycles (all meters)</Text>
                )}
              </View>
              </>
            }
            ListEmptyComponent={!openCycle ? null : <Text style={styles.emptyText}>No closed billing cycles yet.</Text>}
            renderItem={({ item: cycle }) => (
              <View style={styles.cycleCard}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cycleMeterName}>{getMeterName(cycle.meterId)}</Text>
                  <Text style={styles.cycleTitle}>
                    {new Date(cycle.startDate).toLocaleDateString()} → {new Date(cycle.endDate).toLocaleDateString()}
                  </Text>
                  <Text style={styles.cycleMeta}>
                    {cycle.closeReason ? cycle.closeReason.replace("_", " ") : "Closed"} · {cycle.totalUnits} units · {cycle.totalCost.toFixed(2)}
                  </Text>
                </View>
                <TouchableOpacity style={styles.deleteButton} onPress={() => handleDeleteCycle(cycle.id)}>
                  <Text style={styles.deleteButtonText}>Delete</Text>
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  loadingText: { color: "#fff", textAlign: "center", marginTop: 40 },
  topBar: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 },
  brandRow: { flexDirection: "row", alignItems: "center", minHeight: 42 },
  brandBadge: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: "#1d9bbf",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
    shadowColor: "#5eead4",
    shadowOpacity: 0.45,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  brandBadgeText: { color: "#fff", fontWeight: "800", fontSize: 12 },
  brandTextWrap: { flex: 1, justifyContent: "center" },
  header: { fontSize: 20, fontWeight: "700", color: "#fff", flexShrink: 1 },
  subheader: { fontSize: 11, color: "#94a3b8", marginTop: 2, flexShrink: 1 },
  tabRow: {
    flexDirection: "row",
    marginHorizontal: 20,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 4,
    marginBottom: 12,
  },
  tabButton: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  tabButtonActive: { backgroundColor: "#334155" },
  tabText: { color: "#94a3b8", fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  content: { paddingHorizontal: 20, flex: 1 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(15, 23, 42, 0.7)", justifyContent: "center", padding: 20 },
  modalCard: { backgroundColor: "#111827", borderRadius: 14, padding: 20 },
  modalTitle: { color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 16 },
  modalActions: { flexDirection: "row", justifyContent: "space-between", marginTop: 20 },
  cancelButton: { backgroundColor: "#334155", borderRadius: 10, padding: 14, flex: 1, marginRight: 10, alignItems: "center" },
  cancelButtonText: { color: "#fff", fontWeight: "600" },
  card: { backgroundColor: "#1e293b", borderRadius: 12, padding: 16, marginBottom: 20 },
  cardLabel: { color: "#94a3b8", fontSize: 12, marginBottom: 4 },
  cardValue: { color: "#fff", fontSize: 22, fontWeight: "700" },
  cardSubtext: { color: "#64748b", fontSize: 12, marginTop: 4 },
  inputLabel: { color: "#cbd5e1", fontSize: 14, marginBottom: 6 },
  input: { backgroundColor: "#1e293b", color: "#fff", borderRadius: 10, padding: 14, fontSize: 18, marginBottom: 16 },
  dateButton: { backgroundColor: "#1e293b", borderRadius: 10, padding: 14, marginBottom: 16 },
  dateButtonText: { color: "#fff", fontSize: 18, fontWeight: "600" },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  switchLabel: { color: "#cbd5e1", flex: 1, marginRight: 12, fontSize: 13 },
  primaryButton: { backgroundColor: "#22c55e", borderRadius: 10, padding: 16, alignItems: "center", marginBottom: 20 },
  primaryButtonText: { color: "#0f172a", fontWeight: "700", fontSize: 16 },
  fixedFooter: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 8,
    backgroundColor: "#0f172a",
  },
  summaryCard: { backgroundColor: "#1e293b", borderRadius: 12, padding: 16, marginBottom: 20 },
  summaryValue: { color: "#22c55e", fontSize: 28, fontWeight: "700" },
  cycleActionRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 14, gap: 8 },
  secondaryActionButton: { backgroundColor: "#155e75", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center", marginBottom: 16 },
  secondaryActionButtonText: { color: "#fff", fontWeight: "700" },
  removeMeterButton: { backgroundColor: "#991b1b", borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center", marginBottom: 16 },
  removeMeterButtonText: { color: "#fff", fontWeight: "700" },
  emptyText: { color: "#64748b", textAlign: "center", marginTop: 40 },
  sectionHeading: { color: "#fff", fontSize: 16, fontWeight: "700", marginBottom: 10 },
  cycleCard: { backgroundColor: "#1e293b", borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cycleMeterName: { color: "#5eead4", fontSize: 12, fontWeight: "700", marginBottom: 2 },
  cycleTitle: { color: "#fff", fontSize: 14, fontWeight: "600" },
  cycleMeta: { color: "#94a3b8", fontSize: 12, marginTop: 4 },
  historyRow: { backgroundColor: "#1e293b", borderRadius: 10, padding: 14, marginBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyRowAnomaly: { borderWidth: 1, borderColor: "#f59e0b" },
  historyValue: { color: "#fff", fontSize: 16, fontWeight: "600" },
  historyDate: { color: "#64748b", fontSize: 12, marginTop: 2 },
  historyMeta: { color: "#94a3b8", fontSize: 13, marginTop: 4 },
  anomalyBadge: { color: "#f59e0b", fontSize: 12, marginTop: 4, fontWeight: "700" },
  actionButtons: { flexDirection: "row", alignItems: "center", marginLeft: 12, gap: 8 },
  editButton: { backgroundColor: "#1d4ed8", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  editButtonText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  deleteButton: { backgroundColor: "#7f1d1d", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 8 },
  deleteButtonText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  clearButton: { padding: 14, alignItems: "center", marginBottom: 10 },
  clearButtonText: { color: "#ef4444", fontSize: 13 },
  historyRowSelected: { backgroundColor: "#0f3a47" },
  checkboxBox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: "#64748b", alignItems: "center", justifyContent: "center" },
  checkboxBoxChecked: { backgroundColor: "#14b8a6", borderColor: "#14b8a6" },
  checkboxTick: { color: "#04201c", fontSize: 15, fontWeight: "900", lineHeight: 18 },
  selectionBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 10, paddingBottom: 6, borderTopWidth: 1, borderTopColor: "#1e293b" },
  selectAllRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingRight: 8 },
  selectAllText: { color: "#e2e8f0", fontSize: 14, fontWeight: "600", marginLeft: 10 },
  clearSelectedButton: { backgroundColor: "#b91c1c", paddingHorizontal: 14, paddingVertical: 11, borderRadius: 10 },
  clearSelectedDisabled: { backgroundColor: "#3b2230", opacity: 0.55 },
  clearSelectedText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  openingRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  openingText: { color: "#e2e8f0", fontSize: 14, fontWeight: "600", flex: 1, paddingRight: 12 },
  openingHint: { color: "#fbbf24", fontSize: 12, marginTop: 6, marginBottom: 4 },
  linkButton: { backgroundColor: "#0f766e", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  linkButtonText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  pickerWrapper: { backgroundColor: "#1e293b", borderRadius: 10, marginBottom: 16, overflow: "hidden" },
  filterRow: { flexDirection: "row", marginBottom: 12 },
  attachmentPreview: { width: 80, height: 80, borderRadius: 8, marginBottom: 16 },
  historyThumb: { width: 60, height: 60, borderRadius: 6, marginTop: 8 },
  analysisChartCard: { backgroundColor: "#1e293b", borderRadius: 12, padding: 12, marginBottom: 20 },
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.95)",
    justifyContent: "center",
    alignItems: "center",
  },
  imageViewerTopBar: {
    position: "absolute",
    top: 50,
    right: 20,
    flexDirection: "row",
    gap: 16,
    zIndex: 10,
  },
  imageViewerIconButton: {
    backgroundColor: "rgba(255,255,255,0.15)",
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
  },
  imageViewerIconText: {
    color: "#fff",
    fontSize: 20,
  },
  imageViewerFullImage: {
    width: "100%",
    height: "80%",
  },
});