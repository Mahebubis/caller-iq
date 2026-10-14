import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, BackHandler, Linking, NativeModules, Text, useColorScheme, View } from 'react-native';
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
import { panelAsk } from './src/api';
import { callbackTime, last10, prettyPhone } from './src/format';
import { darkTheme, lightTheme, makeStyles, radius, space, ThemeContext, ThemePref, useTheme } from './src/theme';
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

type Tab = 'feed' | 'imports' | 'callbacks';

/** Skips a state update (and the re-render of every tab) when a poll brought back the same thing. */
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

const withTimeout = <T,>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/* ── Theme: the phone's light/dark setting unless the counselor picked one in Settings ── */

const App = (): React.JSX.Element => {
  const scheme = useColorScheme();
  const [pref, setPref] = useState<ThemePref>('system');

  useEffect(() => {
    CallBridge?.loadUiCache?.(THEME_KEY).then((v: string) => {
      if (v === 'light' || v === 'dark' || v === 'system') setPref(v);
    }).catch(() => {});
  }, []);

  const theme = (pref === 'system' ? scheme === 'dark' : pref === 'dark') ? darkTheme : lightTheme;

  // Status bar, navigation bar and the window behind them follow the theme too.
  useEffect(() => {
    CallBridge?.setSystemBarsTheme?.(theme.dark, theme.c.surface);
  }, [theme]);

  const changePref = useCallback((p: ThemePref) => {
    setPref(p);
    CallBridge?.saveUiCache?.(THEME_KEY, p);
  }, []);

  return (
    <ThemeContext.Provider value={theme}>
      <ToastProvider>
        <Main themePref={pref} onThemePref={changePref} />
      </ToastProvider>
    </ThemeContext.Provider>
  );
};

const Main = ({ themePref, onThemePref }: { themePref: ThemePref; onThemePref: (p: ThemePref) => void }) => {
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
  const handleDial = useCallback((phoneNumber: string | undefined | null) => {
    if (!phoneNumber) return;
    const now = Date.now();
    if (lastDial.current.n === phoneNumber && now - lastDial.current.at < 1500) return;
    lastDial.current = { n: phoneNumber, at: now };
    Linking.openURL(`tel:${phoneNumber}`).catch((err) => {
      addLog(`Dialer error: ${err.message || err}`);
      toast('This phone could not open the dialer', 'error');
    });
  }, [addLog, toast]);

  // The auto-dialer places the call itself (CALL_PHONE), falling back to the dialer without it.
  const autoDial = useCallback(async (phoneNumber: string) => {
    try {
      if (CallBridge?.placeCall) await CallBridge.placeCall(phoneNumber);
      else await Linking.openURL(`tel:${phoneNumber}`);
    } catch (err: any) {
      addLog(`Auto-dial error: ${err?.message || err}`);
      toast('This phone could not place the call', 'error');
    }
  }, [addLog, toast]);

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

  const setupLeft = setup ? setup.steps.filter((x) => x.required && !x.ok).length : 0;
  const sync: { icon: IconName; label: string; fg: string; bg: string; onPress: () => void } = setup?.syncError
    ? { icon: 'sync_problem', label: 'Not uploading', fg: t.c.danger, bg: t.c.dangerSoft, onPress: () => setIsPopupSetupOpen(true) }
    : pendingQueueCount > 0
      ? { icon: 'cloud_upload', label: `${pendingQueueCount} queued`, fg: t.c.warning, bg: t.c.warningSoft, onPress: handleForceFlushQueue }
      : { icon: 'cloud_done', label: 'Synced', fg: t.c.success, bg: t.c.successSoft, onPress: () => setIsPopupSetupOpen(true) };

  const TABS: { key: Tab; icon: IconName; label: string; badge?: number }[] = [
    { key: 'feed', icon: 'call', label: 'Calls' },
    { key: 'imports', icon: 'format_list_bulleted', label: 'Lists' },
    { key: 'callbacks', icon: 'phone_callback', label: 'Callbacks', badge: callbackCount },
  ];

  return (
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.logo}><Icon name="phone_in_talk" size={22} color={t.c.onPrimary} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.brand}>Caller IQ</Text>
          <Text style={s.brandSub} numberOfLines={1}>Internship Studio{setup?.model ? ` · ${setup.model}` : ''}</Text>
        </View>
        <Tactile
          onPress={sync.onPress}
          disabled={syncing}
          scaleTo={0.92}
          unstable_pressDelay={0}
          accessibilityRole="button"
          accessibilityLabel={`Upload status: ${sync.label}`}
          hitSlop={6}
          style={[s.syncPill, { backgroundColor: sync.bg }]}
        >
          {syncing || pendingQueueCount > 0
            ? <PulseDot color={setup?.syncError ? t.c.coral : t.c.amber} size={7} />
            : <Icon name={sync.icon} size={15} color={sync.fg} />}
          <Text style={[s.syncText, { color: sync.fg }]}>{syncing ? 'Uploading…' : sync.label}</Text>
        </Tactile>
        <IconButton icon="settings" label="Settings" tone="outlined" size={38} onPress={() => setIsAdminModalOpen(true)} />
      </View>

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
          reloadSignal={callbacksReload}
          onOpenList={openList}
        />
      </View>

      {/* Bottom navigation */}
      <View style={s.tabBar} accessibilityRole="tablist">
        {TABS.map((tb) => (
          <TabItem key={tb.key} icon={tb.icon} label={tb.label} badge={tb.badge} on={activeTab === tb.key} onPress={() => pressTab(tb.key)} />
        ))}
        <TabItem icon="checklist" label="Setup" badge={setupLeft} on={false} onPress={() => setIsPopupSetupOpen(true)} />
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
    </View>
  );
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
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.lg, paddingVertical: 10,
    backgroundColor: t.c.surface, borderBottomWidth: 1, borderBottomColor: t.c.border,
  },
  logo: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: t.c.primary, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 17, fontWeight: '700', color: t.c.text, letterSpacing: -0.2 },
  brandSub: { fontSize: 11.5, color: t.c.muted, marginTop: 1 },
  syncPill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, minHeight: 30, borderRadius: radius.pill },
  syncText: { fontSize: 12, fontWeight: '600' },

  tabBar: {
    flexDirection: 'row', backgroundColor: t.c.surface, borderTopWidth: 1, borderTopColor: t.c.border, paddingTop: 8, paddingBottom: 8,
  },
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
