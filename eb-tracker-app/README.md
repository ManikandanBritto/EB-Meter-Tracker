# EB Tracker

EB Tracker is a local-first React Native application for recording electricity meter readings, monitoring consumption, estimating billing-cycle cost, and reviewing usage history.

All readings and settings are stored on the device. The app does not require a backend or an account.

## Features

- Track readings for one or more meters.
- Record the reading date, time, remarks, and an optional meter photo.
- Calculate consumed units between readings.
- Detect meter resets and unusually high usage.
- Manage open and closed billing cycles.
- View reading history with meter and date filters.
- Review unit and cost trends in the Analysis tab.
- Export filtered reports as CSV or PNG.
- Import historical readings from CSV or XLSX files.
- Automatically create meters found in an imported file.
- Store imported `Date`, `Meter`, `Reading`, `Units`, and `Remarks` values.
- Ignore imported `Cost` and `Attachment` columns. Cost is recalculated by the app and attachments are not imported.

## Requirements

- Node.js 18 or newer
- npm
- Expo-compatible Android or iOS development environment for local native builds
- An Expo account and EAS CLI for cloud APK builds

## Install Dependencies

From the project directory:

```bash
npm install
```

## Run During Development

Start the Expo development server:

```bash
npm run start
```

Then open the app in Expo Go, an attached Android device, an Android emulator, or an iOS simulator.

Run directly on Android:

```bash
npm run android
```

Run directly on iOS:

```bash
npm run ios
```

For release-like JavaScript testing without creating an APK:

```bash
npx expo start --no-dev --minify -c
```

## Import CSV or XLSX Data

Use **Add Reading > Import readings from CSV or XLSX**.

The first worksheet is used for XLSX files. The expected columns are:

| Column | Required | Behavior |
| --- | --- | --- |
| `Date` | Yes | Reading date and time |
| `Meter` | Yes | Existing meter name or a new meter to create |
| `Reading` | Yes | Non-negative meter reading |
| `Units` | No | Preserved when present; otherwise derived from readings |
| `Remarks` | No | Preserved as reading notes |
| `Cost` | No | Ignored; cost is calculated by the app |
| `Attachment` | No | Ignored |

The app accepts the CSV format exported by EB Tracker, including quoted values and remarks containing commas. Imported files are copied to app cache for reading and removed after import.

## Build an Installable Android APK

The `preview` EAS profile is configured to produce an APK rather than an Android App Bundle.

Install and authenticate with EAS:

```bash
npm install -g eas-cli
eas login
```

Build the preview APK:

```bash
eas build --platform android --profile preview
```

When the build completes, open the EAS download link on the Android phone and install the APK. You may need to allow installation from the browser or file manager used to download it.

Build a new APK after code or configuration changes. An already-installed APK does not receive JavaScript or native configuration changes automatically.

## Release Build Troubleshooting

Check Expo dependency compatibility:

```bash
npx expo-doctor
npx expo install --check
npx expo install --fix
```

If a release APK closes immediately, collect the Android crash log with USB debugging enabled:

```powershell
adb logcat -c
```

Open the app so it crashes, then run:

```powershell
adb logcat -d | Select-String "FATAL|AndroidRuntime|ReactNative"
```

## Project Structure

```text
App.js                  Main screen and tab navigation
src/
  analysis.js            Reading validation and anomaly detection
  attachments.js         Meter-photo selection and storage
  csvImport.js           CSV/XLSX parsing and import normalization
  cycles.js              Billing-cycle operations
  meters.js              Meter management
  storage.js             Reading persistence
  tariff.js              Electricity cost calculation
assets/                  App splash and image assets
app.json                Expo application configuration
eas.json                EAS build profiles
```

## Data and Privacy

Readings, meters, cycles, remarks, and local attachment paths are stored on the device using AsyncStorage and the app's local file storage. Clearing app data or uninstalling the app removes locally stored data unless it has been exported separately.
