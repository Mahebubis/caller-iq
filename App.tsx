import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Linking, NativeModules, Text, TextInput, useColorScheme, View } from 'react-native';
import ImportsScreen, { ImportsHandle, ImportList, Show } from './src/ImportsScreen';
import CallbacksScreen, { Owed } from './src/CallbacksScreen';
import CallsScreen, { CallsHandle } from './src/CallsScreen';
import TagCallSheet from './src/sheets/TagCallSheet';
import SetupSheet from './src/sheets/SetupSheet';
import SettingsSheet from './src/sheets/SettingsSheet';
import SimLabelsSheet from './src/sheets/SimLabelsSheet';
import BuildNoteDialog from './src/sheets/BuildNoteDialog';
import ScheduleSheet from './src/sheets/ScheduleSheet';
import SmsSheet from './src/sheets/SmsSheet';
import { useWaSend, WhatsAppBadge, WhatsAppProvider } from './src/whatsapp';
import { EngageProvider, PointsBar, usePoints, useUndo } from './src/engage';
import FocusSheet, { FocusTarget } from './src/sheets/FocusSheet';
import SearchSheet from './src/sheets/SearchSheet';
import MiniCallBar, { ActiveCall, Disposition } from './src/MiniCallBar';
import StatsScreen from './src/StatsScreen';
import { crm, native, setCrmEndpoint } from './src/crm';
import { fillSales, TEMPLATES } from './src/sales';
import { autosave } from './src/backup';
import { markMessaged } from './src/messaged';
import { panelAsk } from './src/api';
import { callbackTime, last10, prettyPhone } from './src/format';
import { AccentKey, elevation, FontSize, getTheme, glow, makeStyles, radius, space, ThemeContext, ThemePref, useTheme } from './src/theme';
import { Gradient, Logo } from './src/art';
import { HomeHero } from './src/HomeDash';
import type { DialerInfo } from './src/ImportsScreen';
import CallScreen from './src/CallScreen';
import QuickCallSheet from './src/sheets/QuickCallSheet';
import { Icon, IconButton, IconName, PulseDot, Tactile, ToastProvider, useToast } from './src/ui';
import {
  BuildInfo, CallLogItem, PopupReadiness, ScheduleTarget, SetupInfo, SmsTarget, SetupStep, SimDiagnostics, SimNicknameMap, UssdSettings,
} from './src/types';

const { CallBridge } = NativeModules;

const DEFAULT_SIM_MAPPING: SimNicknameMap = {
  'SIM 1': 'SIM 1: EdTech Inbound Leads',
  'SIM 2': 'SIM 2: Support & Admissions',
  'SIM_WAITING_FALLBACK': 'SIM (Primary Slot)',
};

const DEFAULT_ENDPOINT = 'https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php';
const THEME_KEY = 'theme_pref';
const ACCENT_KEY = 'accent_pref';
const SIZE_KEY = 'font_size_pref';

export interface Appearance {
  themePref: ThemePref;
  onThemePref: (p: ThemePref) => void;
  accent: AccentKey;
  onAccent: (a: AccentKey) => void;
  fontSize: FontSize;
  onFontSize: (f: FontSize) => void;
}

type Tab = 'feed' | 'imports' | 'callbacks' | 'stats';

/** Skips a state update (and the re-render of every tab) when a poll brought back the same thing. */
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/* ── Theme: the phone's light/dark setting unless the counselor picked one in Settings ── */

const App = (): React.JSX.Element => {
  const scheme = useColorScheme();
  const [pref, setPref] = useState<ThemePref>('system');
  const [accent, setAccent] = useState<AccentKey>('sunset');
  const [size, setSize] = useState<FontSize>('medium');

  useEffect(() => {
    CallBridge?.loadUiCache?.(THEME_KEY).then((v: string) => {
      if (v === 'light' || v === 'dark' || v === 'system') setPref(v);
    }).catch(() => {});
    CallBridge?.loadUiCache?.(ACCENT_KEY).then((v: string) => { if (v) setAccent(v as AccentKey); }).catch(() => {});
    CallBridge?.loadUiCache?.(SIZE_KEY).then((v: string) => { if (v === 'small' || v === 'medium' || v === 'large') setSize(v); }).catch(() => {});
  }, []);

  const theme = getTheme(pref === 'system' ? scheme === 'dark' : pref === 'dark', accent, size);

  // Status bar, navigation bar and the window behind them follow the theme too — set by Main,
  // which knows whether Home's plum hero is showing (child effects run first, so not here too).

  const changePref = useCallback((p: ThemePref) => {
    setPref(p);
    CallBridge?.saveUiCache?.(THEME_KEY, p);
  }, []);
  const changeAccent = useCallback((a: AccentKey) => { setAccent(a); CallBridge?.saveUiCache?.(ACCENT_KEY, a); }, []);
  const changeSize = useCallback((f: FontSize) => { setSize(f); CallBridge?.saveUiCache?.(SIZE_KEY, f); }, []);
  const appearance = { themePref: pref, onThemePref: changePref, accent, onAccent: changeAccent, fontSize: size, onFontSize: changeSize };

  return (
    <ThemeContext.Provider value={theme}>
      <ToastProvider>
        <Main appearance={appearance} />
      </ToastProvider>
    </ThemeContext.Provider>
  );
};

const Main = ({ appearance }: { appearance: Appearance }) => {
  const { themePref, onThemePref } = appearance;
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();

  const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);

  // Tabs
  const [activeTab, setActiveTab] = useState<Tab>('feed');
  const [callbackCount, setCallbackCount] = useState<number>(0);
  const [callbackItems, setCallbackItems] = useState<Owed[]>([]);
  const [callbacksReload, setCallbacksReload] = useState<number>(0);
  const [scheduleFor, setScheduleFor] = useState<ScheduleTarget | null>(null);
  const [smsFor, setSmsFor] = useState<SmsTarget | null>(null);
  const [callLogs, setCallLogs] = useState<CallLogItem[]>([]);
  const [simNicknames, setSimNicknames] = useState<SimNicknameMap>(DEFAULT_SIM_MAPPING);

  // The Lists and Calls tabs keep their own state; these only let the back button reach into them.
  const importsRef = useRef<ImportsHandle>(null);
  // The sales workspace: who is in Focus, the search palette, and the call placed from the app.
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const [searchOpen, setSearchOpen] = useState<boolean>(false);
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [callScreen, setCallScreen] = useState<boolean>(false);
  const [quickCall, setQuickCall] = useState<boolean>(false);
  // What the power dialer is doing, so the call screen can show "3 of 25" and who is next.
  const [dialerInfo, setDialerInfo] = useState<DialerInfo | null>(null);
  const resumeDialerAfterSchedule = useRef<boolean>(false);
  // Points, undo and WhatsApp live in providers rendered below; <Expose> hands them up here.
  const engage = useRef<{ points: ReturnType<typeof usePoints>; undo: ReturnType<typeof useUndo>; wa: ReturnType<typeof useWaSend> } | null>(null);
  const appLive = useRef<any>({});
  const callsRef = useRef<CallsHandle>(null);
  const [callingLists, setCallingLists] = useState<ImportList[]>([]);
  // "Called by" — shared with the post-call popup, remembered on the phone.
  const [callers, setCallers] = useState<string[]>([]);
  const [calledBy, setCalledByState] = useState<string>('');
  // Outcomes tagged in this app, kept on the phone: the call log itself does not hold them, so
  // without this a "Callback Scheduled" tag was forgotten the moment the app restarted.
  const savedOutcomes = useRef<{ [key: string]: string }>({});

  // Sheets
  const [activeDispositionCall, setActiveDispositionCall] = useState<CallLogItem | null>(null);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState<boolean>(false);
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(false);
  const [isSimModalOpen, setIsSimModalOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [syncing, setSyncing] = useState<boolean>(false);

  // Post-call popup + SIM detection
  const [readiness, setReadiness] = useState<PopupReadiness | null>(null);
  const [isPopupSetupOpen, setIsPopupSetupOpen] = useState<boolean>(false);
  const [overlayGranted, setOverlayGranted] = useState<boolean>(true);
  const [popupEnabled, setPopupEnabled] = useState<boolean>(true);
  const [popupForMissed, setPopupForMissed] = useState<boolean>(true);
  const [popupTimeout, setPopupTimeout] = useState<number>(45);
  const [simDiag, setSimDiag] = useState<SimDiagnostics>({});
  const [ussd, setUssd] = useState<UssdSettings | null>(null);
  const [checkingSlot, setCheckingSlot] = useState<number | null>(null);

  // One-tap setup ("Allow all permissions")
  const [setup, setSetup] = useState<SetupInfo | null>(null);
  const [wizardOn, setWizardOn] = useState<boolean>(false);
  const [wizardKey, setWizardKey] = useState<string | null>(null);
  const [wizardTotal, setWizardTotal] = useState<number>(0);
  const [askConfirm, setAskConfirm] = useState<SetupStep | null>(null);
  // "Is this the latest build?" — the note from BUILD_NOTE.txt, shown each time the app opens.
  const [buildInfo, setBuildInfo] = useState<BuildInfo | null>(null);
  const [showBuildCard, setShowBuildCard] = useState<boolean>(false);
  const [connTest, setConnTest] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  // Read by the AppState listener, which must always see live values rather than a stale closure.
  const wizardRef = useRef<{ on: boolean; inFlight: string; attempted: Set<string> }>({ on: false, inFlight: '', attempted: new Set() });

  // Admin config
  const [syncEndpoint, setSyncEndpoint] = useState<string>(DEFAULT_ENDPOINT);
  const [systemLogs, setSystemLogs] = useState<string[]>([]);

  // The 15-second poll only reads what a sheet is showing while that sheet is open.
  const detailsWanted = useRef(false);
  detailsWanted.current = isPopupSetupOpen || isAdminModalOpen;

  const addLog = useCallback((msg: string) => {
    const time = new Date().toLocaleTimeString();
    setSystemLogs((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 24)]);
  }, []);

  const getSimLabel = (simIdRaw: string): string => (simIdRaw ? simNicknames[simIdRaw] || simIdRaw : 'Unknown SIM');

  /* ── Reading the phone ─────────────────────────────────────────────────── */

  // The newest call on screen and when all 300 were last read — lets the poll skip unchanged reads.
  const newestCall = useRef<{ key: string; fullAt: number }>({ key: '', fullAt: 0 });
  // One read at a time: a second request while one runs joins it (launch used to start two at once,
  // which native code then ran one after the other, doubling the wait for the first screen).
  const readInFlight = useRef<Promise<void> | null>(null);

  const fetchSystemData = useCallback((quiet: boolean = false): Promise<void> => {
    if (readInFlight.current) return readInFlight.current;
    const run = readPhone(quiet).finally(() => { readInFlight.current = null; });
    readInFlight.current = run;
    return run;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const readPhone = async (quiet: boolean) => {
    try {
      if (!CallBridge) {
        addLog('CallBridge native module not linked.');
        return;
      }
      const details = !quiet || detailsWanted.current;

      /*
       * 300 calls: enough history for the Callbacks tab to find calls owed from earlier in the week.
       * Reading them takes seconds on a slow phone and holds up every other native call meanwhile,
       * so the 15-second poll first reads just the newest call and skips the full read when it is
       * the one already on screen (a call only reaches the log once it has ended). A full read
       * still happens every 2 minutes, for SIMs worked out later.
       */
      const readCalls = async (): Promise<CallLogItem[] | null> => {
        if (!CallBridge.getRecentCallLogs) {
          return CallBridge.getRecentCalls ? withTimeout<CallLogItem[] | null>(CallBridge.getRecentCalls().catch(() => null), 5000, null) : null;
        }
        if (quiet && newestCall.current.key && Date.now() - newestCall.current.fullAt < 2 * 60 * 1000) {
          const top = await withTimeout<CallLogItem[] | null>(CallBridge.getRecentCallLogs(1).catch(() => null), 5000, null);
          if (!top || (top[0]?.idempotencyKey || '') === newestCall.current.key) return null;
        }
        // Long timeout: giving up early used to leave the feed empty on slower phones.
        const all = await withTimeout<CallLogItem[] | null>(CallBridge.getRecentCallLogs(300).catch(() => null), 20000, null);
        if (all) newestCall.current = { key: all[0]?.idempotencyKey || '', fullAt: Date.now() };
        return all;
      };

      const [statusRes, queueRes, rawLogsRes, nicknameJson, setupRes, readinessRes, ussdRes, diagJson] = await Promise.all([
        CallBridge.getTrackingStatus ? withTimeout<any>(CallBridge.getTrackingStatus().catch(() => null), 3000, null) : null,
        CallBridge.getPendingQueueCount ? withTimeout(CallBridge.getPendingQueueCount().catch(() => null), 3000, null) : null,
        readCalls(),
        CallBridge.getSimNicknames ? withTimeout(CallBridge.getSimNicknames().catch(() => '{}'), 1500, '{}') : '{}',
        CallBridge.getSetupState ? withTimeout<any>(CallBridge.getSetupState().catch(() => null), 2000, null) : null,
        details && CallBridge.getPopupReadiness ? withTimeout<any>(CallBridge.getPopupReadiness().catch(() => null), 1500, null) : null,
        details && CallBridge.getUssdSettings ? withTimeout<any>(CallBridge.getUssdSettings().catch(() => null), 1500, null) : null,
        details && CallBridge.getSimDiagnostics ? withTimeout(CallBridge.getSimDiagnostics().catch(() => ''), 1500, '') : '',
      ]);

      if (statusRes) {
        if (statusRes.syncEndpoint) setSyncEndpoint(statusRes.syncEndpoint);
        if (typeof statusRes.overlayGranted === 'boolean') setOverlayGranted(statusRes.overlayGranted);
        if (typeof statusRes.popupEnabled === 'boolean') setPopupEnabled(statusRes.popupEnabled);
        if (typeof statusRes.popupForMissed === 'boolean') setPopupForMissed(statusRes.popupForMissed);
        if (typeof statusRes.popupTimeoutSec === 'number') setPopupTimeout(statusRes.popupTimeoutSec);
      }
      if (setupRes) setSetup((prev) => (same(prev, setupRes) ? prev : setupRes));
      if (readinessRes) setReadiness((prev) => (same(prev, readinessRes) ? prev : readinessRes));
      if (ussdRes) setUssd((prev) => (same(prev, ussdRes) ? prev : ussdRes));
      if (diagJson) {
        try {
          const d = JSON.parse(diagJson);
          setSimDiag((prev) => (same(prev, d) ? prev : d));
        } catch (_) {}
      }
      if (typeof queueRes === 'number') setPendingQueueCount(queueRes);

      if (nicknameJson && nicknameJson !== '{}') {
        try {
          const parsed = JSON.parse(nicknameJson);
          setSimNicknames((prev) => {
            const next = { ...prev, ...parsed };
            return same(prev, next) ? prev : next;
          });
        } catch (_) {}
      }

      if (Array.isArray(rawLogsRes)) {
        setCallLogs((prev) => {
          const outcomeMap: { [key: string]: string } = {};
          prev.forEach((item) => { if (item?.outcome) outcomeMap[item.idempotencyKey] = item.outcome; });
          const merged: CallLogItem[] = rawLogsRes
            .map((item: CallLogItem) => ({
              ...item,
              outcome: outcomeMap[item.idempotencyKey] || savedOutcomes.current[item.idempotencyKey] || item.outcome,
            }))
            .sort((a: CallLogItem, b: CallLogItem) => (b.timestamp || 0) - (a.timestamp || 0));
          // Nothing new since the last read: keep the same array so no tab re-renders.
          const unchanged = merged.length === prev.length && merged.every((c, i) => {
            const o = prev[i];
            return c.idempotencyKey === o.idempotencyKey && c.outcome === o.outcome && c.duration === o.duration
              && c.callType === o.callType && c.simId === o.simId && c.simSlot === o.simSlot;
          });
          return unchanged ? prev : merged;
        });
        if (!quiet) addLog(`Fetched ${rawLogsRes.length} live calls from device.`);
      }
    } catch (err: any) {
      addLog(`Fetch error: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  };

  /* The popup is the whole point of the app, so an install that cannot show it should not be able
     to go unnoticed: the setup sheet opens itself once per launch until it is sorted. */
  const setupPrompted = useRef(false);
  useEffect(() => {
    if (!setup || setupPrompted.current) return;
    setupPrompted.current = true;
    if (setup.steps.some((x) => x.required && x.status === 'todo')) {
      const timer = setTimeout(() => setIsPopupSetupOpen(true), 600);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [setup]);

  /*
   * Android's back button should close what is open — a sheet, a dialog — and only leave the app
   * when nothing is. Without this every back press quits mid-task, which on a phone feels broken.
   */
  useEffect(() => {
    const onBack = () => {
      if (activeDispositionCall) { setActiveDispositionCall(null); return true; }
      if (askConfirm) { setAskConfirm(null); return true; }
      if (isPopupSetupOpen) { closeSetup(); return true; }
      if (isSimModalOpen) { setIsSimModalOpen(false); return true; }
      if (isAdminModalOpen) { setIsAdminModalOpen(false); return true; }
      if (activeTab === 'imports' && importsRef.current?.handleBack()) return true;
      if (activeTab !== 'feed') { setActiveTab('feed'); return true; }
      if (callsRef.current?.handleBack()) return true;
      return false;     // nothing open: let Android leave the app
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [activeTab, activeDispositionCall, askConfirm, isPopupSetupOpen, isSimModalOpen, isAdminModalOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    CallBridge?.getBuildInfo?.().then((info: BuildInfo) => {
      if (!info) return;
      setBuildInfo(info);
      if (String(info.note || '').trim()) setShowBuildCard(true);
    }).catch(() => {});
    CallBridge?.getCalledBy?.().then((r: any) => {
      if (!r) return;
      setCallers(Array.isArray(r.names) ? r.names : []);
      setCalledByState(r.current || '');
    }).catch(() => {});
    CallBridge?.loadUiCache?.('call_outcomes_v1').then((raw: string) => {
      try {
        if (!raw) return;
        savedOutcomes.current = JSON.parse(raw) || {};
        setCallLogs((prev) => prev.map((c) => (c.outcome ? c : { ...c, outcome: savedOutcomes.current[c.idempotencyKey] })));
      } catch (_) {}
    }).catch(() => {});
  }, []);

  const pickCaller = (name: string) => {
    const next = calledBy === name ? '' : name;    // tapping the picked name clears it
    setCalledByState(next);
    CallBridge?.setCalledBy?.(next);
  };

  /* Live call log: while Calls or Callbacks is on screen, re-read the phone's call log every 15 s
     so a call that just ended appears (and a callback clears) without pulling to refresh. */
  useEffect(() => {
    if (activeTab === 'imports') return undefined;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') fetchSystemData(true);
    }, 15000);
    return () => clearInterval(timer);
  }, [activeTab, fetchSystemData]);

  /* Registered once. The Lists tab refreshes itself (quietly) — see src/ImportsScreen.tsx. */
  useEffect(() => {
    fetchSystemData();
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') fetchSystemData(true);
    });
    return () => subscription.remove();
  }, [fetchSystemData]);

  // A pull on the Calls tab re-reads the phone and, since that tab shows them too, the lists.
  const handleManualRefresh = useCallback(() => {
    addLog('Manual refresh triggered.');
    setLoading(true);
    fetchSystemData();
    importsRef.current?.refresh();
  }, [addLog, fetchSystemData]);

  /* ── Post-call popup ──────────────────────────────────────────────────── */

  // Android only allows a window over the dialer once "Display over other apps" is granted,
  // and only the user can grant it — this opens that settings screen.
  const handleEnableOverlay = async () => {
    try {
      if (CallBridge?.requestOverlayPermission) {
        await CallBridge.requestOverlayPermission();
        addLog('Opened the "Display over other apps" settings screen.');
        setTimeout(fetchSystemData, 1500);
      }
    } catch (err: any) {
      addLog(`Overlay permission error: ${err.message || err}`);
    }
  };

  const savePopupSettings = async (enabled: boolean, forMissed: boolean, timeoutSec: number) => {
    setPopupEnabled(enabled);
    setPopupForMissed(forMissed);
    setPopupTimeout(timeoutSec);
    try {
      if (CallBridge?.setPopupSettings) {
        await CallBridge.setPopupSettings(enabled, forMissed, timeoutSec);
        addLog(`Post-call popup ${enabled ? 'enabled' : 'disabled'} (${timeoutSec}s, missed: ${forMissed ? 'yes' : 'no'}).`);
      }
    } catch (err: any) {
      addLog(`Popup settings error: ${err.message || err}`);
      toast('Could not save the popup setting', 'error');
    }
  };

  /* ── "Allow all permissions" ────────────────────────────────────────────
     Walks through only what is still off on THIS phone, in order. Each step either answers in a
     dialog over the app (permissions, battery) or opens the exact settings screen. When the
     counselor comes back — and on most phones the app brings itself back the moment the switch is
     on — it re-reads the phone and moves straight to the next step. A switch the phone cannot
     read back is confirmed by the counselor, never assumed. */

  const loadSetup = async (): Promise<SetupInfo | null> => {
    if (!CallBridge?.getSetupState) return null;
    try {
      const st = await withTimeout<SetupInfo | null>(CallBridge.getSetupState().catch(() => null), 2000, null);
      if (st) setSetup(st);
      return st;
    } catch (_) {
      return null;
    }
  };

  /** Required first, then recommended; never one already tried in this run, so it cannot loop. */
  const nextStep = (st: SetupInfo | null): SetupStep | undefined => {
    if (!st) return undefined;
    const tried = wizardRef.current.attempted;
    return st.steps.find((x) => !x.ok && x.required && !tried.has(x.key))
      || st.steps.find((x) => !x.ok && !x.required && !tried.has(x.key));
  };

  const finishWizard = (st: SetupInfo | null) => {
    wizardRef.current.on = false;
    wizardRef.current.inFlight = '';
    setWizardOn(false);
    setWizardKey(null);
    const left = st ? st.steps.filter((x) => x.required && !x.ok) : [];
    addLog(left.length ? `Setup paused — still off: ${left.map((x) => x.title).join(', ')}.` : 'Setup complete — every required switch is on.');
  };

  const goNext = (st: SetupInfo | null) => {
    if (!wizardRef.current.on) return;
    const next = nextStep(st);
    if (!next) { finishWizard(st); return; }
    // A beat to let the checklist show the tick before the next screen opens.
    setTimeout(() => { if (wizardRef.current.on) runStep(next); }, 450);
  };

  /** The counselor is back from a step (or skipped it). */
  const onStepDone = async (key: string, opts: { noAsk?: boolean } = {}) => {
    wizardRef.current.inFlight = '';
    const st = await loadSetup();
    const step = st?.steps.find((x) => x.key === key);
    // The phone cannot read this switch, so ask — once — rather than guess.
    if (!opts.noAsk && step && step.kind === 'manual' && !step.ok) {
      setAskConfirm(step);
      return;
    }
    goNext(st);
  };

  const runStep = async (step: SetupStep) => {
    const w = wizardRef.current;
    w.attempted.add(step.key);
    w.inFlight = step.key;
    setWizardKey(step.key);
    setAskConfirm(null);
    try {
      if (step.key === 'phone') {
        const res = await withTimeout<any>(CallBridge?.requestCorePermissions?.() ?? Promise.resolve(null), 90000, null);
        w.inFlight = '';
        if (res && !res.granted && Array.isArray(res.blocked) && res.blocked.length) {
          // Refused with "Don't ask again": Android will never show that dialog again, so the
          // only place left to allow it is App info.
          Alert.alert(
            'Allow it in App info',
            'Android will not ask again. On the next screen open Permissions, and allow Call logs and Phone. Then press Back.',
            [
              { text: 'Skip', style: 'cancel', onPress: () => { onStepDone('phone', { noAsk: true }); } },
              { text: 'Open App info', onPress: async () => { w.inFlight = 'phone_details'; await CallBridge?.openSetupStep?.('app_details'); } },
            ],
          );
          return;
        }
        await onStepDone('phone');
        return;
      }
      const opened = await CallBridge?.openSetupStep?.(step.key);
      if (!opened) {
        w.inFlight = '';
        Alert.alert('Open it in Settings', `${step.title}: ${step.how}`, [{ text: 'OK', onPress: () => { onStepDone(step.key); } }]);
      }
      // Otherwise wait: the AppState listener below picks up the return.
    } catch (err: any) {
      w.inFlight = '';
      addLog(`Setup step ${step.key} failed: ${err?.message || err}`);
      await onStepDone(step.key, { noAsk: true });
    }
  };

  const startWizard = async () => {
    setIsPopupSetupOpen(true);
    wizardRef.current = { on: true, inFlight: '', attempted: new Set() };
    const st = (await loadSetup()) || setup;
    const first = nextStep(st);
    if (!first) {
      wizardRef.current.on = false;
      toast('Everything this phone needs is already on');
      return;
    }
    setWizardTotal(st ? st.steps.filter((x) => !x.ok).length : 0);
    setWizardOn(true);
    runStep(first);
  };

  /** One step on its own, from its row in the checklist. */
  const runSingle = (step: SetupStep) => {
    wizardRef.current = { on: false, inFlight: '', attempted: new Set() };
    runStep(step);
  };

  const answerConfirm = async (yes: boolean) => {
    const step = askConfirm;
    setAskConfirm(null);
    if (!step) return;
    if (yes) {
      await CallBridge?.confirmSetupStep?.(step.key, true);
      addLog(`Confirmed: ${step.title} is on.`);
    }
    goNext(await loadSetup());
  };

  const confirmDirect = async (step: SetupStep) => {
    await CallBridge?.confirmSetupStep?.(step.key, true);
    addLog(`Confirmed: ${step.title} is on.`);
    loadSetup();
  };

  const closeSetup = () => {
    if (wizardRef.current.on) finishWizard(setup);
    setAskConfirm(null);
    setIsPopupSetupOpen(false);
  };

  /* "Keep CallIQ running": the foreground service that stops Android freezing or killing the app
     between calls — without it, live calls and uploads go missing on an installed APK. */
  const toggleMonitor = async (on: boolean) => {
    if (!on) {
      Alert.alert(
        'Turn off background tracking?',
        'Android will then freeze or close CallIQ between calls, and live calls may stop showing on the dashboard.',
        [
          { text: 'Keep it on', style: 'cancel' },
          { text: 'Turn off', style: 'destructive', onPress: async () => { await CallBridge?.setMonitorEnabled?.(false); addLog('Background tracking switched off.'); setTimeout(loadSetup, 600); } },
        ],
      );
      return;
    }
    await CallBridge?.setMonitorEnabled?.(true);
    addLog('Background tracking switched on.');
    setTimeout(loadSetup, 800);
  };

  const handleTestConnection = async () => {
    setConnTest({ busy: true });
    try {
      const r = await withTimeout<any>(CallBridge?.testConnection?.() ?? Promise.resolve(null), 25000, null);
      setConnTest({ busy: false, ok: !!r?.ok, message: r?.message || 'No answer — check the internet connection.' });
      loadSetup();
    } catch (err: any) {
      setConnTest({ busy: false, ok: false, message: err?.message || 'Test failed.' });
    }
  };

  // The live handler for the AppState listener (which is registered once).
  const stepReturnRef = useRef<(key: string) => void>(() => {});
  stepReturnRef.current = (key: string) => { onStepDone(key); };

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      const k = wizardRef.current.inFlight;
      // The permission dialog answers through its own promise, not through a return.
      if (!k || k === 'phone') return;
      stepReturnRef.current(k === 'phone_details' ? 'phone' : k);
    });
    return () => sub.remove();
  }, []);

  // Runs the very same path a real hang-up takes, so a pass here means real calls will pop up too.
  const handleSimulateCallEnd = async () => {
    try {
      const ok = await CallBridge?.simulateCallEnd?.();
      if (!ok) Alert.alert('Could not show it', 'Check the steps above — “Display over other apps” is what Android requires.');
      setTimeout(fetchSystemData, 1500);
    } catch (err: any) {
      addLog(`Test error: ${err.message || err}`);
    }
  };

  const handleTestPopup = async () => {
    try {
      if (!CallBridge?.showPopupForLastCall) return;
      const shown = await CallBridge.showPopupForLastCall();
      if (shown) addLog('Test popup shown for the most recent call.');
      else toast('Make or receive a call first — the preview uses the last call', 'error');
    } catch (err: any) {
      addLog(`Test popup error: ${err.message || err}`);
    }
  };

  /* ── SIM balance over USSD ────────────────────────────────────────────── */

  const toggleUssd = async (on: boolean) => {
    setUssd((u) => (u ? { ...u, enabled: on } : u));
    try {
      await CallBridge?.setUssdSettings?.(on);
      addLog(on ? 'Daily SIM balance checks switched on.' : 'Daily SIM balance checks switched off.');
    } catch (err: any) {
      addLog(`Balance check error: ${err.message || err}`);
    }
  };

  const saveUssdCode = async (slot: number, code: string) => {
    setUssd((u) => (u ? { ...u, sims: u.sims.map((x) => (x.slot === slot ? { ...x, code } : x)) } : u));
    try { await CallBridge?.setUssdCode?.(slot, code); } catch (_) {}
  };

  // Runs the carrier's code on that SIM and shows whatever comes back, word for word.
  const checkBalanceNow = async (slot: number) => {
    setCheckingSlot(slot);
    try {
      const res = await CallBridge?.checkSimBalance?.(slot);
      const text = res?.text || 'No reply.';
      addLog(`SIM ${slot}: ${text}`);
      Alert.alert(res?.ok ? `SIM ${slot} — operator reply` : `SIM ${slot} — no reading`, text);
      setTimeout(fetchSystemData, 800);
    } catch (err: any) {
      Alert.alert('Could not check', err.message || String(err));
    } finally {
      setCheckingSlot(null);
    }
  };

  /* ── Uploads, outcomes, labels ────────────────────────────────────────── */

  const handleForceFlushQueue = useCallback(async () => {
    setSyncing(true);
    addLog('Upload now: enqueuing the WorkManager sync…');
    try {
      if (CallBridge?.triggerManualSync) {
        const res = await CallBridge.triggerManualSync();
        addLog(`WorkManager flush: ${res ? res.message : 'OK'}`);
        toast('Upload started — calls go up in the background');
      }
      await fetchSystemData(true);
    } catch (err: any) {
      addLog(`Flush error: ${err.message || err}`);
      toast(`Upload failed — ${err.message || 'try again'}`, 'error');
    } finally {
      setSyncing(false);
    }
  }, [addLog, fetchSystemData, toast]);

  const handleSelectOutcome = async (outcomeLabel: string) => {
    const call = activeDispositionCall;
    if (!call) return;
    setActiveDispositionCall(null);
    setCallLogs((prev) => prev.map((item) => (item && item.idempotencyKey === call.idempotencyKey ? { ...item, outcome: outcomeLabel } : item)));

    addLog(`Tagged ${call.number} as "${outcomeLabel}"`);
    if (call.duration > 0) engage.current?.points.award('connected', call.idempotencyKey || `${last10(call.number)}:${call.timestamp}`, call.number);
    if (activeCall && last10(activeCall.number) === last10(call.number)) setActiveCall(null);
    savedOutcomes.current = { ...savedOutcomes.current, [call.idempotencyKey]: outcomeLabel };
    const keep = Object.entries(savedOutcomes.current).slice(-500);   // newest 500 are plenty
    CallBridge?.saveUiCache?.('call_outcomes_v1', JSON.stringify(Object.fromEntries(keep)));

    try {
      if (CallBridge?.syncCallOutcome) {
        await CallBridge.syncCallOutcome(call.number, call.callType, call.duration, call.simId, call.timestamp, call.idempotencyKey, outcomeLabel);
      }
      toast(`Tagged as “${outcomeLabel}”`);
    } catch (err: any) {
      addLog(`Outcome sync notice: ${err.message || err}`);
      toast('Saved on this phone — it uploads when the connection is back', 'error');
    }
  };

  const handleSaveSimNicknames = async (sim1: string, sim2: string) => {
    const updatedMap: SimNicknameMap = {
      ...simNicknames,
      'SIM 1': sim1 || simNicknames['SIM 1'] || DEFAULT_SIM_MAPPING['SIM 1'],
      'SIM 2': sim2 || simNicknames['SIM 2'] || DEFAULT_SIM_MAPPING['SIM 2'],
    };
    setSimNicknames(updatedMap);
    try {
      if (CallBridge?.saveSimNicknames) {
        await CallBridge.saveSimNicknames(JSON.stringify(updatedMap));
        addLog('Saved custom SIM nicknames to native preferences.');
      }
      toast('SIM labels saved');
    } catch (err: any) {
      addLog(`Nickname save error: ${err.message || err}`);
      toast('Could not save the SIM labels', 'error');
    }
    setIsSimModalOpen(false);
  };

  // Admin PIN — a light gate against accidental changes, not real security.
  const handleUnlock = (pin: string): boolean => {
    if (pin === '1234' || pin === '0000') {
      setIsAdminUnlocked(true);
      addLog('Admin settings unlocked.');
      return true;
    }
    return false;
  };

  const handleSaveEndpoint = async (url: string) => {
    try {
      if (CallBridge?.setSyncEndpoint) {
        await CallBridge.setSyncEndpoint(url);
        setSyncEndpoint(url);
        addLog(`Updated sync endpoint to: ${url}`);
        toast('Server address saved');
      }
    } catch (err: any) {
      addLog(`Endpoint error: ${err.message || err}`);
      toast(`Not saved — ${err.message || err}`, 'error');
    }
  };

  /* ── Navigation ── */

  // One tap opens the dialer once: a second tap on the same number within 1.5 s is ignored.
  const lastDial = useRef<{ n: string; at: number }>({ n: '', at: 0 });
  /* A call placed from the app: the mini call bar shows who it is, and it earns points — an attempt
     (once an hour per number), plus the on-time bonus when a scheduled callback is made around
     its time (10 min early to 30 min late). */
  const startedCall = useCallback((phoneNumber: string, viaDialer = false) => {
    const k = last10(phoneNumber);
    const L = appLive.current;
    const f: FocusTarget | null = L.focus && last10(L.focus.number) === k ? L.focus : null;
    const owed = (L.callbackItems || []).find((o: Owed) => o.key === k);
    const row = f ? null : importsRef.current?.visibleRows().find((r) => last10(r.target.number) === k)?.target;
    setActiveCall({
      number: phoneNumber, name: f?.name || owed?.name || row?.name, segment: f?.segment || owed?.segment || row?.segment,
      startedAt: Date.now(), phase: 'dialing', dialer: viaDialer,
    });
    // Back from the phone's dialer, the call screen is waiting with the timer and the outcomes — so the
    // native post-call popup stays away for this call (it still comes up if the app is closed).
    setCallScreen(true);
    NativeModules.CrmBridge?.markInAppCall?.(phoneNumber);
    const p = engage.current?.points;
    if (!p || !k) return;
    p.award('attempt', `${k}:${new Date().toISOString().slice(0, 13)}`, phoneNumber);
    const due = owed?.dueAt || f?.dueAt;
    if (due && Date.now() >= due - 10 * 60000 && Date.now() <= due + 30 * 60000) p.award('ontime', `${k}:${due}`, phoneNumber);
  }, []);

  const handleDial = useCallback((phoneNumber: string | undefined | null) => {
    if (!phoneNumber) return;
    const now = Date.now();
    if (lastDial.current.n === phoneNumber && now - lastDial.current.at < 1500) return;
    lastDial.current = { n: phoneNumber, at: now };
    startedCall(phoneNumber);
    Linking.openURL(`tel:${phoneNumber}`).catch((err) => {
      addLog(`Dialer error: ${err.message || err}`);
      toast('This phone could not open the dialer', 'error');
    });
  }, [addLog, toast, startedCall]);

  // The auto-dialer places the call itself (CALL_PHONE), falling back to the dialer without it.
  const autoDial = useCallback(async (phoneNumber: string) => {
    startedCall(phoneNumber, true);
    try {
      if (CallBridge?.placeCall) await CallBridge.placeCall(phoneNumber);
      else await Linking.openURL(`tel:${phoneNumber}`);
    } catch (err: any) {
      addLog(`Auto-dial error: ${err?.message || err}`);
      toast('This phone could not place the call', 'error');
    }
  }, [addLog, toast, startedCall]);

  /* ── Scheduled callbacks ──────────────────────────────────────────────────
   * Saved on the panel (shared with the team) and armed as an alarm on this phone, which rings
   * a high-priority reminder at that time even with the app closed. */
  const openSchedule = useCallback((target: ScheduleTarget) => setScheduleFor(target), []);
  const afterScheduleChange = useCallback(() => {
    setCallbacksReload((n) => n + 1);
    importsRef.current?.refreshOpen();
  }, []);

  const setCallback = useCallback(async (target: ScheduleTarget, dueMs: number, note: string) => {
    await panelAsk('callbacks.php', { action: 'schedule', number: target.number, due_ms: dueMs, note, name: target.name || '' }, syncEndpoint);
    const who = target.name || prettyPhone(target.number);
    CallBridge?.scheduleCallbackReminder?.(`cb_${last10(target.number)}`, dueMs, `Call back ${who}`,
      note || (target.segment ? `From ${target.segment}` : 'Scheduled callback'), target.number).catch(() => {});
    addLog(`Callback for ${target.number} set for ${callbackTime(dueMs)}.`);
    afterScheduleChange();
  }, [syncEndpoint, addLog, afterScheduleChange]);

  const saveSchedule = useCallback(async (dueMs: number, note: string) => {
    if (!scheduleFor) return;
    try {
      await setCallback(scheduleFor, dueMs, note);
      toast(`Callback set for ${callbackTime(dueMs)}`);
      setScheduleFor(null);
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  }, [scheduleFor, setCallback, toast]);

  const clearCallback = useCallback(async (number: string) => {
    try {
      await panelAsk('callbacks.php', { action: 'unschedule', number }, syncEndpoint);
      CallBridge?.cancelCallbackReminder?.(`cb_${last10(number)}`).catch(() => {});
      afterScheduleChange();
      setScheduleFor(null);
      toast('Callback cleared');
    } catch (e: any) {
      toast(`Not cleared — ${e?.message || e}`, 'error');
    }
  }, [syncEndpoint, afterScheduleChange, toast]);

  const snoozeCallback = useCallback(async (o: Owed, minutes: number) => {
    const dueMs = Date.now() + minutes * 60 * 1000;
    try {
      await setCallback({ number: o.number, name: o.name, segment: o.segment, note: o.note }, dueMs, o.note || '');
      toast(`Snoozed — reminder at ${callbackTime(dueMs)}`);
    } catch (e: any) {
      toast(`Not snoozed — ${e?.message || e}`, 'error');
    }
  }, [setCallback, toast]);
  const doneCallback = useCallback((o: Owed) => clearCallback(o.number), [clearCallback]);

  /* ── Quick SMS after an unanswered call — logged on the contact in the panel. */
  const openSms = useCallback((target: SmsTarget) => setSmsFor(target), []);
  const logSms = useCallback(async (template: string, body: string) => {
    if (!smsFor) return;
    const to = smsFor;
    setSmsFor(null);
    markMessaged(to.number);
    try {
      await panelAsk('callbacks.php', { action: 'sms_log', number: to.number, template, body }, syncEndpoint);
      addLog(`SMS "${template}" to ${to.number} logged.`);
      afterScheduleChange();
    } catch (e: any) {
      toast(`SMS sent, but not logged — ${e?.message || e}`, 'error');
    }
  }, [smsFor, syncEndpoint, addLog, afterScheduleChange, toast]);

  const openList = useCallback((id: number, show?: Show) => {
    setActiveTab('imports');
    importsRef.current?.openListById(id, show);
  }, []);
  const seeAllLists = useCallback(() => setActiveTab('imports'), []);
  const seeCallbacks = useCallback(() => setActiveTab('callbacks'), []);
  const editSims = useCallback(() => setIsSimModalOpen(true), []);
  // Stable for the memoized Calls tab, but always calling the latest handlers.
  const latest = useRef({ startWizard, handleTestConnection });
  latest.current = { startWizard, handleTestConnection };
  const startSetup = useCallback(() => { latest.current.startWizard(); }, []);
  const testFromBanner = useCallback(() => { setIsPopupSetupOpen(true); latest.current.handleTestConnection(); }, []);
  const tagCall = useCallback((c: CallLogItem) => setActiveDispositionCall(c), []);

  const pressTab = (key: Tab) => {
    // Tapping the open Lists tab again goes back to all lists.
    if (key === activeTab && key === 'imports') importsRef.current?.handleBack();
    setActiveTab(key);
  };

  // Home's plum hero runs up under the status bar; every other tab has the white header there.
  useEffect(() => {
    if (activeTab === 'feed') CallBridge?.setSystemBarsTheme?.(true, t.grad.header[0]);
    else CallBridge?.setSystemBarsTheme?.(t.dark, t.c.surface);
  }, [activeTab, t]);

  /* ── Focus workspace, mini call bar dispositions, search, keyboard ── */
  setCrmEndpoint(syncEndpoint);
  appLive.current = { focus, callbackItems, activeCall, searchOpen };
  const openFocus = useCallback((t: FocusTarget) => setFocus(t), []);
  const focusFromCall = (c: ActiveCall): FocusTarget => {
    const row = importsRef.current?.visibleRows().find((r) => last10(r.target.number) === last10(c.number))?.target;
    const owed = callbackItems.find((o) => o.key === last10(c.number));
    return row || { number: c.number, name: c.name || owed?.name, segment: c.segment || owed?.segment, attempts: owed?.tries, dueAt: owed?.dueAt };
  };

  const dispose = useCallback(async (d: Disposition) => {
    const c = appLive.current.activeCall as ActiveCall | null;
    if (!c) return;
    setActiveCall(null);
    const e = engage.current;
    // The same call tag the post-call popup would have sent, matched to the call by its start time.
    const tag = { interested: 'Interested', callback: 'Callback Scheduled', no_answer: 'Not Answering', lost: 'Not Interested', converted: 'Converted' }[d];
    NativeModules.CrmBridge?.tagInAppCall?.(c.number, c.startedAt, tag).catch(() => {});
    // The power dialer goes on to the next person — after the callback time is picked, if that was it.
    if (c.dialer) {
      if (d === 'callback') { importsRef.current?.dialerPause(); resumeDialerAfterSchedule.current = true; }
      else importsRef.current?.dialerNext();
    } else setCallScreen(false);
    try {
      if (d === 'callback') { setCallScreen(false); setScheduleFor({ number: c.number, name: c.name, segment: c.segment }); return; }
      if (d === 'no_answer') {
        e?.wa.sendOne({ name: c.name, phone: c.number, segment: c.segment }, fillSales(TEMPLATES.en.missed, { name: c.name, segment: c.segment, me: calledBy }), { how: 'No answer' });
        return;
      }
      const stage = d === 'interested' ? 'interested' : d === 'converted' ? 'converted' : 'lost';
      const r = await crm.metaSet(c.number, { stage });
      e?.points.celebrate(r.awarded);
      importsRef.current?.patchMeta(c.number, r.meta);
      // A sale asks for a referral; "not interested" for the reason — both in Focus.
      if ((d === 'converted' || d === 'lost') && !c.dialer) setFocus({ ...focusFromCall(c), meta: r.meta, prompt: d === 'converted' ? 'referral' : undefined });
      else if (d === 'converted') toast(`🎉 ${c.name || prettyPhone(c.number)} converted — add their referral from the list later`);
      else if (d === 'lost') toast(`${c.name || prettyPhone(c.number)} marked not interested`);
      else toast(`${c.name || prettyPhone(c.number)} marked interested`);
      e?.undo.push(`Marked ${stage}`, () => crm.metaSet(c.number, { stage: 'contacted' }).then((b) => importsRef.current?.patchMeta(c.number, b.meta)));
    } catch (err: any) {
      toast(`Not saved — ${err?.message || err}`, 'error');
    }
  }, [calledBy, callbackItems, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /* The phone's own call state: the line opening starts the timer, hanging up stops it and brings
     the outcomes up — whoever ended the call, and wherever the counselor is in the app. */
  useEffect(() => {
    const sub = native.events?.addListener('CallIQCallState', (ev: { state: string; at: number }) => {
      setActiveCall((c) => {
        if (!c) return c;
        if (ev.state === 'OFFHOOK' && c.phase !== 'live' && c.phase !== 'ended') return { ...c, phase: 'live', liveAt: Date.now() };
        // IDLE straight after dialing, before the line opened, is the phone settling — not an end.
        if (ev.state === 'IDLE' && c.phase === 'live') return { ...c, phase: 'ended', endedAt: Date.now() };
        if (ev.state === 'IDLE' && c.phase === 'dialing' && Date.now() - c.startedAt > 4000) return { ...c, phase: 'ended', endedAt: Date.now() };
        return c;
      });
      if (ev.state === 'IDLE' && appLive.current.activeCall) setCallScreen(true);
    });
    return () => sub?.remove();
  }, []);

  // The callback time for a power-dialer call is set (or the sheet closed): back to the list.
  useEffect(() => {
    if (!scheduleFor && resumeDialerAfterSchedule.current) {
      resumeDialerAfterSchedule.current = false;
      importsRef.current?.dialerResume();
      setCallScreen(true);
    }
  }, [scheduleFor]);

  // The power dialer ending closes its screen; it opening (from a list) shows it.
  const dialerWasOn = useRef<boolean>(false);
  useEffect(() => {
    const on = !!dialerInfo;
    if (on && !dialerWasOn.current) setCallScreen(true);
    if (!on && dialerWasOn.current && !appLive.current.activeCall) setCallScreen(false);
    dialerWasOn.current = on;
  }, [dialerInfo]);

  // Hardware keyboard: Ctrl+K search, Ctrl+Z undo, Space dial, W WhatsApp, N next, 1-5 outcome.
  useEffect(() => {
    const sub = native.events?.addListener('CallIQKey', (ev: { key: string; ctrl: boolean }) => {
      const L = appLive.current;
      const e = engage.current;
      if (ev.ctrl && ev.key === 'k') { setSearchOpen(true); return; }
      if (ev.ctrl && ev.key === 'z') { e?.undo.undoLast(); return; }
      if (ev.key === 'escape') { if (L.searchOpen) setSearchOpen(false); else setFocus(null); return; }
      if (ev.ctrl || TextInput.State.currentlyFocusedInput()) return;   // typing
      const f: FocusTarget | null = L.focus;
      if (ev.key === 'space') {
        if (f) handleDial(f.number);
        else if (!importsRef.current?.dialerCallNow()) toast('Open someone (or start the power dialer) first');
      } else if (ev.key === 'w') {
        const who = f || importsRef.current?.dialerPerson();
        if (who) e?.wa.sendOne({ name: who.name, phone: who.number, segment: who.segment }, fillSales(TEMPLATES.en.missed, { name: who.name, segment: who.segment, me: calledBy }));
      } else if (ev.key === 'n') {
        const nx = importsRef.current?.next(f?.number);
        if (nx) setFocus(nx);
      } else if (/^[1-5]$/.test(ev.key)) {
        const d = (['interested', 'callback', 'no_answer', 'lost', 'converted'] as Disposition[])[Number(ev.key) - 1];
        if (L.activeCall) dispose(d);
        else if (f) setActiveCall({ number: f.number, name: f.name, segment: f.segment, startedAt: Date.now() });
      }
    });
    return () => sub?.remove();
  }, [handleDial, dispose, calledBy, toast]);

  /* A lead who picks up (or calls in and talks) needs no more drip messages. */
  const dripSeen = useRef<number>(Date.now());
  useEffect(() => {
    const wa = engage.current?.wa;
    if (!wa) return;
    const fresh = callLogs.filter((c) => c && c.timestamp > dripSeen.current && c.duration > 0);
    if (!fresh.length) return;
    dripSeen.current = Math.max(...fresh.map((c) => c.timestamp));
    fresh.forEach((c) => { if (wa.drips[last10(c.number)]) wa.stopDrip(c.number, 'stopped — they answered a call'); });
  }, [callLogs]);

  /* This phone's own settings, snapshotted every 60 seconds (Stats → Workspace backup). */
  useEffect(() => {
    autosave().catch(() => {});
    const timer = setInterval(() => { autosave().catch(() => {}); }, 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const setupLeft = setup ? setup.steps.filter((x) => x.required && !x.ok).length : 0;
  const sync: { icon: IconName; label: string; fg: string; bg: string; onPress: () => void } = setup?.syncError
    ? { icon: 'sync_problem', label: 'Not uploading', fg: t.c.danger, bg: t.c.dangerSoft, onPress: () => setIsPopupSetupOpen(true) }
    : pendingQueueCount > 0
      ? { icon: 'cloud_upload', label: `${pendingQueueCount} queued`, fg: t.c.warning, bg: t.c.warningSoft, onPress: handleForceFlushQueue }
      : { icon: 'cloud_done', label: 'Synced', fg: t.c.success, bg: t.c.successSoft, onPress: () => setIsPopupSetupOpen(true) };

  const TABS: { key: Tab; icon: IconName; label: string; badge?: number }[] = [
    { key: 'feed', icon: 'home', label: 'Home' },
    { key: 'imports', icon: 'format_list_bulleted', label: 'Lists' },
    { key: 'callbacks', icon: 'phone_callback', label: 'Callbacks', badge: callbackCount },
    { key: 'stats', icon: 'bar_chart', label: 'Reports' },
  ];

  /* Home's quick actions and the centre call button. */
  const powerDialList = (id: number) => { setQuickCall(false); setActiveTab('imports'); importsRef.current?.openListById(id, 'to_call', true); };
  const onTile = useCallback((k: 'start' | 'lists' | 'callbacks' | 'reports') => {
    if (k === 'start') setQuickCall(true);
    else setActiveTab(k === 'lists' ? 'imports' : k === 'callbacks' ? 'callbacks' : 'stats');
  }, []);
  const syncPill = (glass: boolean) => (
    <Tactile
      onPress={sync.onPress}
      disabled={syncing}
      scaleTo={0.92}
      unstable_pressDelay={0}
      accessibilityRole="button"
      accessibilityLabel={`Upload status: ${sync.label}`}
      hitSlop={6}
      style={[s.syncPill, { backgroundColor: glass ? 'rgba(255,255,255,0.16)' : sync.bg }]}
    >
      {syncing || pendingQueueCount > 0
        ? <PulseDot color={setup?.syncError ? t.c.coral : t.c.amber} size={7} />
        : <Icon name={sync.icon} size={15} color={glass ? '#FFFFFF' : sync.fg} />}
      <Text style={[s.syncText, { color: glass ? '#FFFFFF' : sync.fg }]}>{syncing ? 'Uploading…' : sync.label}</Text>
    </Tactile>
  );

  return (
    <WhatsAppProvider syncEndpoint={syncEndpoint} addLog={addLog} me={calledBy}>
    <EngageProvider calls={callLogs} ready={!!syncEndpoint}>
    <Expose to={engage} />
    <Gradient colors={t.grad.page} angle={180} style={s.container}>
      {/* Header — Home has its own plum hero instead */}
      {activeTab !== 'feed' && (
        <View style={s.header}>
          <View style={{ flex: 1, minWidth: 92 }}>
            <Logo size={22} />
            <Text style={s.brandSub} numberOfLines={1}>Internship Studio{setup?.model ? ` · ${setup.model}` : ''}</Text>
          </View>
          {syncPill(false)}
          <WhatsAppBadge style={s.syncPill} textStyle={s.syncText} compact />
          <IconButton icon="search" label="Find anyone (Ctrl+K)" tone="outlined" size={38} onPress={() => setSearchOpen(true)} />
          <IconButton icon="settings" label="Settings" tone="outlined" size={38} badge={setupLeft} onPress={() => setIsAdminModalOpen(true)} />
        </View>
      )}

      {activeTab !== 'feed' && <PointsBar onPress={() => setActiveTab('stats')} />}
      <DialRequestBanner onCall={handleDial} />

      {/* Tabs — all mounted, so what each has loaded survives switching. Hidden through a plain
          View: Android does not collapse a ScrollView set to display:none. */}
      <View style={[{ flex: 1 }, activeTab !== 'feed' && s.hidden]}>
        <CallsScreen
          ref={callsRef}
          calls={callLogs}
          loading={loading}
          onRefresh={handleManualRefresh}
          setup={setup}
          pendingQueueCount={pendingQueueCount}
          syncing={syncing}
          onUploadNow={handleForceFlushQueue}
          onStartSetup={startSetup}
          onTestConnection={testFromBanner}
          lists={callingLists}
          onOpenList={openList}
          onSeeAllLists={seeAllLists}
          tasks={callbackItems}
          onSeeCallbacks={seeCallbacks}
          onSchedule={openSchedule}
          onSnooze={snoozeCallback}
          onDoneCallback={doneCallback}
          onSms={openSms}
          onFocus={openFocus}
          onTile={onTile}
          hero={(
            <HomeHero
              name={calledBy}
              bell={callbackCount}
              onBell={seeCallbacks}
              onAvatar={() => setIsAdminModalOpen(true)}
              onSearch={() => setSearchOpen(true)}
              setupLeft={setupLeft}
              onSetup={() => setIsPopupSetupOpen(true)}
              status={<>{syncPill(true)}<WhatsAppBadge style={s.syncPill} textStyle={s.syncText} /></>}
            />
          )}
          simNicknames={simNicknames}
          onEditSims={editSims}
          onTag={tagCall}
          onDial={handleDial}
        />
      </View>

      <View style={[{ flex: 1 }, activeTab !== 'imports' && s.hidden]}>
        <ImportsScreen
          ref={importsRef}
          active={activeTab === 'imports'}
          syncEndpoint={syncEndpoint}
          onDial={handleDial}
          onAutoDial={autoDial}
          onSchedule={openSchedule}
          onSms={openSms}
          addLog={addLog}
          onListsChange={setCallingLists}
          onFocus={openFocus}
          onDialerChange={setDialerInfo}
          onOpenReports={() => setActiveTab('stats')}
        />
      </View>

      <View style={[{ flex: 1 }, activeTab !== 'callbacks' && s.hidden]}>
        <CallbacksScreen
          active={activeTab === 'callbacks'}
          syncEndpoint={syncEndpoint}
          calls={callLogs}
          lists={callingLists}
          onDial={handleDial}
          onCount={setCallbackCount}
          onItems={setCallbackItems}
          onSchedule={openSchedule}
          onSms={openSms}
          onFocus={openFocus}
          reloadSignal={callbacksReload}
          onOpenList={openList}
        />
      </View>

      <View style={[{ flex: 1 }, activeTab !== 'stats' && s.hidden]}>
        <StatsScreen active={activeTab === 'stats'} admin={isAdminUnlocked} lists={callingLists} />
      </View>

      {!!activeCall && (
        <MiniCallBar call={activeCall} onPick={dispose} onOpen={() => setCallScreen(true)} onClose={() => setActiveCall(null)} />
      )}

      {/* Bottom navigation */}
      <View style={s.dockWrap}>
        <View style={s.tabBar} accessibilityRole="tablist">
          {TABS.slice(0, 2).map((tb) => (
            <TabItem key={tb.key} icon={tb.icon} label={tb.label} badge={tb.badge} on={activeTab === tb.key} onPress={() => pressTab(tb.key)} />
          ))}
          <View style={s.fabSlot} />
          {TABS.slice(2).map((tb) => (
            <TabItem key={tb.key} icon={tb.icon} label={tb.label} badge={tb.badge} on={activeTab === tb.key} onPress={() => pressTab(tb.key)} />
          ))}
        </View>
        {/* The centre call button: back to the call in progress, or start one. */}
        <Tactile
          onPress={() => (activeCall ? setCallScreen(true) : setQuickCall(true))}
          scaleTo={0.9}
          unstable_pressDelay={0}
          accessibilityRole="button"
          accessibilityLabel={activeCall ? 'Back to the call' : 'Start calling'}
          style={s.fab}
        >
          <Gradient colors={t.grad.primary} angle={135} corner={32} style={s.fabInner}>
            <Icon name={activeCall ? 'phone_in_talk' : 'call'} size={30} color="#FFFFFF" />
          </Gradient>
        </Tactile>
      </View>

      <TagCallSheet
        call={activeDispositionCall}
        callers={callers}
        calledBy={calledBy}
        onPickCaller={pickCaller}
        onSelect={handleSelectOutcome}
        onClose={() => setActiveDispositionCall(null)}
      />

      <BuildNoteDialog info={buildInfo} visible={showBuildCard} onClose={() => setShowBuildCard(false)} />

      <SetupSheet
        visible={isPopupSetupOpen}
        onClose={() => { closeSetup(); fetchSystemData(true); }}
        setup={setup}
        wizardOn={wizardOn}
        wizardKey={wizardKey}
        stepNo={Math.min(wizardRef.current.attempted.size, Math.max(wizardTotal, 1))}
        stepTotal={Math.max(wizardTotal, 1)}
        askConfirm={askConfirm}
        lastNote={readiness?.lastNote || ''}
        connTest={connTest}
        onStartWizard={startWizard}
        onRunStep={runStep}
        onRunSingle={runSingle}
        onSkip={(key) => onStepDone(key, { noAsk: true })}
        onStop={() => finishWizard(setup)}
        onAnswerConfirm={answerConfirm}
        onConfirmDirect={confirmDirect}
        onToggleMonitor={toggleMonitor}
        onTestConnection={handleTestConnection}
        onTestPopup={handleSimulateCallEnd}
      />

      <ScheduleSheet
        target={scheduleFor}
        onSave={saveSchedule}
        onClear={() => (scheduleFor ? clearCallback(scheduleFor.number) : Promise.resolve())}
        onClose={() => setScheduleFor(null)}
      />

      <SmsSheet target={smsFor} myName={calledBy} onSent={logSms} onClose={() => setSmsFor(null)} />

      <FocusSheet
        target={focus}
        myName={calledBy}
        onClose={() => setFocus(null)}
        onDial={handleDial}
        onSchedule={openSchedule}
        onSms={openSms}
        onMeta={(n, m) => importsRef.current?.patchMeta(n, m)}
        onEditRow={(tg, patch) => importsRef.current?.editRow(tg, patch) ?? Promise.resolve()}
        onPin={(tg, on) => importsRef.current?.pinRow(tg, on) ?? Promise.resolve()}
        onReferral={() => importsRef.current?.refreshOpen()}
        admin={isAdminUnlocked}
      />

      <CallScreen
        call={activeCall}
        dialer={dialerInfo}
        visible={callScreen && (!!activeCall || !!dialerInfo)}
        onClose={() => setCallScreen(false)}
        onPick={dispose}
        onCallAgain={() => { const c = activeCall; if (c) { setActiveCall(null); (c.dialer ? autoDial : handleDial)(c.number); } }}
        onDialer={(a) => {
          const h = importsRef.current;
          if (!h) return;
          if (a === 'next') { setActiveCall(null); h.dialerNext(); }
          else if (a === 'callNow') h.dialerCallNow();
          else if (a === 'pause') h.dialerPause();
          else if (a === 'resume') h.dialerResume();
          else if (a === 'skip') h.dialerSkip();
          else { setActiveCall(null); h.dialerStop(); setCallScreen(false); }
        }}
        onSchedule={() => { const c = activeCall; setCallScreen(false); if (c) setScheduleFor({ number: c.number, name: c.name, segment: c.segment }); }}
        onWhatsApp={() => { const c = activeCall; if (c) engage.current?.wa.sendOne({ name: c.name, phone: c.number, segment: c.segment }, fillSales(TEMPLATES.en.missed, { name: c.name, segment: c.segment, me: calledBy })); }}
        onOpen={() => { const c = activeCall; setCallScreen(false); if (c) setFocus(focusFromCall(c)); }}
      />

      <QuickCallSheet
        visible={quickCall}
        onClose={() => setQuickCall(false)}
        lists={callingLists}
        onDial={(n) => { setQuickCall(false); handleDial(n); }}
        onPowerDial={powerDialList}
      />

      <SearchSheet
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        rows={searchOpen ? importsRef.current?.visibleRows() || [] : []}
        owed={callbackItems}
        calls={callLogs}
        onPick={openFocus}
      />

      <SimLabelsSheet
        visible={isSimModalOpen}
        sim1={getSimLabel('SIM 1')}
        sim2={getSimLabel('SIM 2')}
        onSave={handleSaveSimNicknames}
        onClose={() => setIsSimModalOpen(false)}
      />

      <SettingsSheet
        visible={isAdminModalOpen}
        onClose={() => setIsAdminModalOpen(false)}
        themePref={themePref}
        onThemePref={onThemePref}
        appearance={appearance}
        appVersion={buildInfo?.versionName || setup?.appVersion || ''}
        unlocked={isAdminUnlocked}
        onUnlock={handleUnlock}
        endpoint={syncEndpoint}
        onSaveEndpoint={handleSaveEndpoint}
        syncing={syncing}
        pendingQueueCount={pendingQueueCount}
        onFlush={handleForceFlushQueue}
        popupEnabled={popupEnabled}
        popupForMissed={popupForMissed}
        popupTimeout={popupTimeout}
        overlayGranted={overlayGranted}
        onPopupSettings={savePopupSettings}
        onEnableOverlay={handleEnableOverlay}
        onPreviewPopup={handleTestPopup}
        simDiag={simDiag}
        simNicknames={simNicknames}
        ussd={ussd}
        checkingSlot={checkingSlot}
        onToggleUssd={toggleUssd}
        onUssdCode={saveUssdCode}
        onCheckBalance={checkBalanceNow}
        logs={systemLogs}
      />
    </Gradient>
    </EngageProvider>
    </WhatsAppProvider>
  );
};

/** A number pushed from the laptop dialer (the bridge's /dialer page): one tap to call it here. */
const DialRequestBanner = ({ onCall }: { onCall: (n: string) => void }) => {
  const t = useTheme();
  const s = useStyles();
  const wa = useWaSend();
  const d = wa.dialRequest;
  if (!d) return null;
  return (
    <View style={s.dialReq}>
      <Icon name="smartphone" size={20} color={t.c.success} />
      <View style={{ flex: 1 }}>
        <Text style={s.dialReqTitle} numberOfLines={1}>From the laptop: {d.name || prettyPhone(d.phone)}</Text>
        <Text style={s.brandSub} numberOfLines={1}>{d.name ? `${prettyPhone(d.phone)} · ` : ''}{d.segment || 'tap Call to dial on this phone'}</Text>
      </View>
      <IconButton icon="close" label="Dismiss" size={32} onPress={wa.clearDial} />
      <Tactile onPress={() => { wa.clearDial(); onCall(d.phone); }} style={s.dialReqBtn} accessibilityRole="button" accessibilityLabel={`Call ${d.name || d.phone}`}>
        <Icon name="call" size={18} color="#FFFFFF" />
        <Text style={s.dialReqBtnText}>Call</Text>
      </Tactile>
    </View>
  );
};

/** Hands the providers' APIs up to Main, which renders the providers and so cannot use their hooks. */
const Expose = ({ to }: { to: React.MutableRefObject<any> }) => {
  to.current = { points: usePoints(), undo: useUndo(), wa: useWaSend() };
  return null;
};

const TabItem = ({ icon, label, badge, on, onPress }: { icon: IconName; label: string; badge?: number; on: boolean; onPress: () => void }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tactile
      style={s.tabItem}
      onPress={onPress}
      scaleTo={0.88}
      unstable_pressDelay={0}
      accessibilityRole="tab"
      accessibilityState={{ selected: on }}
      accessibilityLabel={badge ? `${label}, ${badge} pending` : label}
    >
      <View style={[s.tabIndicator, on && { backgroundColor: t.c.primarySoft }]}>
        <Icon name={icon} size={22} color={on ? t.c.link : t.c.muted} />
        {!!badge && badge > 0 && (
          <View style={s.tabBadge}><Text style={s.tabBadgeText}>{badge > 99 ? '99+' : badge}</Text></View>
        )}
      </View>
      <Text style={[s.tabLabel, on && { color: t.c.link, fontWeight: '700' }]}>{label}</Text>
    </Tactile>
  );
};

const useStyles = makeStyles((t) => ({
  container: { flex: 1, backgroundColor: t.c.bg },
  hidden: { display: 'none' },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.lg, paddingVertical: 10,
    backgroundColor: t.c.surface, borderBottomLeftRadius: 22, borderBottomRightRadius: 22, ...elevation(t), zIndex: 2,
  },
  logo: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: t.c.primary, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 17, fontWeight: '700', color: t.c.text, letterSpacing: -0.2 },
  brandSub: { fontSize: 11.5, color: t.c.muted, marginTop: 1 },
  syncPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 30, borderRadius: radius.pill },
  syncText: { fontSize: 12, fontWeight: '600' },
  dialReq: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.lg, paddingVertical: 8,
    backgroundColor: t.c.successSoft, borderBottomWidth: 1, borderBottomColor: t.c.emerald,
  },
  dialReqTitle: { fontSize: 14, fontWeight: '700', color: t.c.text },
  dialReqBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: t.c.emerald, borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 8 },
  dialReqBtnText: { color: '#FFFFFF', fontWeight: '800', fontSize: 14 },

  dockWrap: { paddingHorizontal: space.md, paddingBottom: space.sm, paddingTop: 22 },
  tabBar: {
    flexDirection: 'row', backgroundColor: t.c.surface, borderRadius: 26, paddingTop: 8, paddingBottom: 8, ...elevation(t, 2),
  },
  fabSlot: { width: 76 },
  fab: { position: 'absolute', alignSelf: 'center', top: 0, borderRadius: 38, borderWidth: 4, borderColor: t.c.surface, backgroundColor: t.c.surface, ...glow(t), elevation: 12 },
  fabInner: { width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  tabItem: { flex: 1, alignItems: 'center', minHeight: 52 },
  // A background from the first frame: Android drops the corner radius when a colour is first
  // added to a view later, which left the selected pill square on every tab but the first.
  tabIndicator: { width: 60, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  tabLabel: { fontSize: 11.5, color: t.c.muted, fontWeight: '500', marginTop: 3 },
  tabBadge: {
    position: 'absolute', top: -2, right: 6, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: t.c.danger, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.c.surface,
  },
  tabBadgeText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '700' },
}));

export default App;
