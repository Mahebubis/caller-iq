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
---

## 💬 WhatsApp bridge (optional)
The WhatsApp buttons (on unanswered contacts, in the power dialer, the Focus workspace's pitch buttons, and bulk campaigns) send in the background through a small Node service in `whatsapp-bridge/`. It also listens for replies (lead → "Replied - Priority", opt-out → DND). Run it on a computer the phones can reach, then link it from the **WhatsApp** badge in the app's top bar. See [whatsapp-bridge/README.md](whatsapp-bridge/README.md), including the warning about WhatsApp bans. Without the bridge, the buttons open WhatsApp on the phone with the message filled in.

**`npm run dev`** starts Metro and the bridge together (bridge settings from the environment or `whatsapp-bridge/.env`, e.g. `BRIDGE_KEY=…`).

## 🏆 Sales workspace, points & stats
- **Lists tab:** import a CSV from the phone (column mapping, default status, number scrubber, duplicate check with skip / overwrite / merge history, best time to call from a time column); merge or split lists (⋮ on a list); `#` numbering with ★ VIP pins on top; live summary (callback/missed, scheduled, WhatsApp/replied, converted, talk time); "Waiting: 18m" SLA timer (red after 30 min); list ↔ board (deal stages) view; CSV export of any filter to Downloads; Ghosting reviver tab.
- **Focus workspace** (tap a person or their `#`): call script in EN / HI / MR / Hinglish, objection rebuttals, BANT meter, sentiment → heat score, stage (Converted asks for a referral, Not interested for the reason), mid-call WhatsApp pitches, 4-hour offer hold with an automatic reminder, notes typed or dictated (Android voice typing), voice notes, timeline. Edit name / number / status and pin from its header.
- **Mini call bar** while a call placed from the app is on: stopwatch and five quick outcomes.
- **Points** (no money): ⚡ points today, 🔥 connected streak, shift goal and rank under the header; **Stats** tab with points by action, leaderboard, funnel, lost reasons and a calls heatmap. Rules and the daily goal are set by an admin in Stats (unlock Settings first).
- **Search** button (Ctrl+K on a keyboard). With a hardware keyboard: Space dial, W WhatsApp, N next, 1–5 outcome, Ctrl+Z undo.

## ⚙️ Automation & team tools
- **Follow-up drip** (Focus → Follow-up drip, or select people → *Drip*): WhatsApp now, after 24 h and after 48 h, sent by the bridge even with the app closed. It stops on its own when the lead replies on WhatsApp or picks up a call.
- **Files & voice notes**: attach a PDF, image or audio file in Focus or in a bulk campaign; it goes with the message as its caption (audio optionally as a WhatsApp voice note).
- **Google Sheet sync**: Import → *Google Sheet link* (shared "anyone with the link can view", or published). The list keeps pulling rows with new numbers every 2 minutes while the app is open; the list's ⋮ menu has *Sync now* / *Stop syncing*.
- **Workspace backup** (Stats tab): this phone's own settings are snapshotted every 60 s; *Export .json* saves a backup to Downloads, *Restore* brings one back.
- **Laptop → phone dialing**: open `http://<bridge computer>:3001/dialer?key=<BRIDGE_KEY>` on the laptop. *Call on phone* pops the number up in the app (one tap to call); *tel:* hands it to Windows Phone Link / Mac Continuity; the page's QR opens a mobile dialer view on any phone.
- **Round robin**: share people out equally between agents at import, or select people → *Assign*. The list's *Mine / Unassigned / <agent>* chips filter by who they belong to.
- **Offer calculator** (Focus): plan + on-call discount + EMI months → the offer formatted and sent on WhatsApp (+20 points). Plans are a team setting (editable in Focus when Settings is unlocked).
- **Competitor battle matrix** (Focus → Competitor mentioned): logs the competitor (Stats chart) and shows Us vs Them to read on the call. Our column is pre-filled; the competitors' columns start empty for the team to fill in from what students say.

## 🎨 Design system — "Sunset Coral & Warm Peach"
- **Tokens** live in `src/theme.ts`: peach page gradient, white cards with a warm coral shadow (`elevation()`), blush inputs/pills, the sunset-coral gradient for primary actions (`glow()`), the plum Home hero and the crimson call screen. Light and dark, six accent colours and Small / Medium / Large text, all in Settings → Appearance.
- **Typeface:** Plus Jakarta Sans (SIL OFL, `third_party/PlusJakartaSans-OFL.txt`), installed as `res/font/plus_jakarta_sans.xml` and registered in `MainApplication`; `makeStyles` applies it and the text size to every text style.
- **Artwork:** `CiqArtViews.kt` draws gradients, the botanical leaf sprays and the donut chart natively (no extra library); `src/art.tsx` wraps them (`Gradient`, `Leaves`, `Donut`, `Avatar`, `Logo`).
- **Screens:** Home dashboard (`src/HomeDash.tsx`), active call screen (`src/CallScreen.tsx`), Reports charts (`src/ReportsCharts.tsx`), the start-calling sheet behind the centre call button (`src/sheets/QuickCallSheet.tsx`).

## 🗄️ Panel files to upload
Upload everything in `server/caller-iq/` to the panel's `api/caller-iq/`: `imports.php`, `callbacks.php`, and the new `crm.php` + `crm_lib.php`. Tables are created on first use. `imports.php` also fixes lists showing people as **Called** because of calls from before the list was uploaded — status now counts only calls made after the upload.
