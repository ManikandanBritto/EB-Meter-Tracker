import AsyncStorage from "@react-native-async-storage/async-storage";

const METERS_KEY = "eb_tracker_meters_v1";

const DEFAULT_METERS = [
  { id: "ground_floor", name: "Ground Floor" },
  { id: "first_floor", name: "First Floor" },
  { id: "third_floor", name: "Third Floor" },
];

export async function loadMeters() {
  try {
    const raw = await AsyncStorage.getItem(METERS_KEY);
    if (raw) return JSON.parse(raw);

    await AsyncStorage.setItem(METERS_KEY, JSON.stringify(DEFAULT_METERS));
    return DEFAULT_METERS;
  } catch (e) {
    console.error("Failed to load meters:", e);
    return DEFAULT_METERS;
  }
}

export async function saveMeters(meters) {
  try {
    await AsyncStorage.setItem(METERS_KEY, JSON.stringify(meters));
    return true;
  } catch (e) {
    console.error("Failed to save meters:", e);
    return false;
  }
}

export async function addMeter(meters, name) {
  const cleanedName = name.trim();
  if (!cleanedName) return meters;

  const id = `${cleanedName.toLowerCase().replace(/\s+/g, "_")}_${Date.now().toString().slice(-4)}`;
  const updated = [...meters, { id, name: cleanedName }];
  await saveMeters(updated);
  return updated;
}

export async function deleteMeter(meters, meterId) {
  const updated = meters.filter((meter) => meter.id !== meterId);
  await saveMeters(updated);
  return updated;
}
