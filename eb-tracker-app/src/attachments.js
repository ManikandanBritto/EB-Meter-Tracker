import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";

const ATTACHMENTS_DIR = FileSystem.documentDirectory + "eb_attachments/";

async function ensureDirExists() {
  const dirInfo = await FileSystem.getInfoAsync(ATTACHMENTS_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(ATTACHMENTS_DIR, { intermediates: true });
  }
}

export async function pickAndSaveAttachment() {
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Photo library permission was not granted.");
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    quality: 0.6,
  });

  if (result.canceled || !result.assets || result.assets.length === 0) {
    return null;
  }

  await ensureDirExists();
  const sourceUri = result.assets[0].uri;
  const fileName = `attachment_${Date.now()}.jpg`;
  const destUri = ATTACHMENTS_DIR + fileName;

  await FileSystem.copyAsync({ from: sourceUri, to: destUri });
  return destUri;
}

export async function deleteAttachment(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists) {
      await FileSystem.deleteAsync(uri);
    }
  } catch (e) {
    console.error("Failed to delete attachment:", e);
  }
}

// Removes every saved photo (used by "Clear all data").
export async function clearAllAttachments() {
  try {
    await FileSystem.deleteAsync(ATTACHMENTS_DIR, { idempotent: true });
  } catch (e) {
    console.error("Failed to clear attachments:", e);
  }
}