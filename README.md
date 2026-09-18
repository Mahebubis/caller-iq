# CallIQ Enterprise - Developer Setup Guide

Welcome to the CallIQ project! This document explains how the app works, its architecture, and how to set up the development environment on a new machine.

## 📱 What is CallIQ?
CallIQ is a lead-tracking and CRM synchronization app built for counselors and agents. 
It monitors device phone calls in the background, determines which SIM card was used (SIM 1 or SIM 2), measures the call duration, and securely syncs the call logs to a remote CRM admin panel.

### **Architecture & How it Works**
This app is a hybrid application utilizing a **React Native** frontend and a heavily customized **Android Native (Kotlin)** backend.

1. **Frontend (UI - `App.tsx`)**: Built in React Native. It displays live device calls, calculates KPIs (Total Dials, Talk Time, Connection Rate), and allows agents to tag post-call outcomes (e.g., "Interested", "Callback Scheduled").
2. **Native Modules (`CallBridgeModule.kt`)**: A custom bridge connecting React Native to the Android OS. It handles requesting permissions and querying the Android `CallLog` database.
3. **Dual-SIM Detection (`CallIqConfig.kt` & `CallLogHelper.kt`)**: Implements aggressive probing of both standard Android APIs and OEM-specific hidden database columns (Samsung, Oppo, Xiaomi) to accurately determine which SIM slot was used.
4. **Background Sync (`CallSyncWorker.kt` & `CallReceiver.kt`)**: Uses Android's `WorkManager` and `BroadcastReceiver`. When a call ends, the receiver wakes up the app in the background and schedules a worker to safely POST the call data to the CRM backend (`https://cit3.internshipstudio.com/...`).

---

## 🛠️ Prerequisites for Development

Before setting up the project, ensure the new laptop has the following installed:
1. **Node.js** (v18 or newer): [Download here](https://nodejs.org/)
2. **Java Development Kit (JDK)** (v17 is recommended for React Native 0.73): [Download Microsoft build of OpenJDK](https://learn.microsoft.com/en-us/java/openjdk/download)
3. **Android Studio**: [Download here](https://developer.android.com/studio)
   - Ensure the **Android SDK**, **Android SDK Platform**, and **Android Virtual Device** are installed via the SDK Manager.
   - Setup your `ANDROID_HOME` environment variables.

---

## 🚀 Step-by-Step Setup Instructions

### 1. Extract the Source Code
Extract the `CallIQ_Project_Source.zip` file to your preferred workspace (e.g., `C:\Users\YourName\AndroidStudioProjects\calliq`).

### 2. Install NPM Dependencies
Open a Terminal (or Command Prompt) inside the extracted project folder and run:
```bash
npm install
```
*This will download all the required React Native dependencies into the `node_modules` folder.*

### 3. Start the Metro Bundler
In the same terminal, start the React Native JavaScript bundler:
```bash
npm start
```
*Leave this terminal window open in the background.*

### 4. Build and Run the App on Android
You have two ways to run the app:

**Option A: Using the Command Line**
Open a *new* terminal window in the project folder and run:
```bash
npm run android
```
*(Ensure an Android Emulator is running, or a physical Android device is connected via USB with "USB Debugging" enabled in Developer Options).*

**Option B: Using Android Studio (Recommended for Native Debugging)**
1. Open Android Studio.
2. Click **File > Open** and select the `android` folder inside the project (`calliq/android`).
3. Allow Android Studio a few minutes to download Gradle and index the Kotlin files.
4. Click the green **Play (Run)** button in the top toolbar to install the app on your device/emulator.

---

## ⚠️ Important Development Notes
- **Permissions**: The app requires `READ_CALL_LOG` and `READ_PHONE_STATE`. The React Native UI handles prompting for these.
- **Battery Optimization**: OEMs (like Xiaomi, OnePlus) aggressively kill background tasks. The app includes a "Fix Now" button on the UI that redirects the user to the battery settings to exempt the app so background sync works reliably.
- **Test Devices**: Emulators do not handle Dual-SIM scenarios well. It is highly recommended to test the native call logging logic on a **physical Android device** with an active SIM card.