import AsyncStorage from "@react-native-async-storage/async-storage";

const READINGS_KEY = "eb_tracker_readings_v1";

export async function loadReadings() {
  try {
    const raw = await AsyncStorage.getItem(READINGS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("Failed to load readings:", e);
    return [];
  }
}

export async function saveReadings(readings) {
  try {
    await AsyncStorage.setItem(READINGS_KEY, JSON.stringify(readings));
    return true;
  } catch (e) {
    console.error("Failed to save readings:", e);
    return false;
  }
}

export async function clearAllReadings() {
  try {
    await AsyncStorage.removeItem(READINGS_KEY);
    return true;
  } catch (e) {
    console.error("Failed to clear readings:", e);
    return false;
  }
}
