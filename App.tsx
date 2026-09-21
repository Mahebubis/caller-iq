import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  StatusBar,
  StyleSheet,
  Text,
  View,
  Pressable,
  TextInput,
  Alert,
  NativeModules,
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  AppState,
  BackHandler,
} from 'react-native';

const { CallBridge } = NativeModules;

// Type Definitions
export interface CallLogItem {
  number: string;
  callType: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'REJECTED' | string;
  duration: number; // in seconds
  timestamp: number; // in ms
  simId: string;
  simSlot?: number;      // 1 or 2; 0 when the SIM could not be identified
  simCarrier?: string;
  simSource?: string;    // how the SIM was worked out — see SimResolver.kt
  rawSimId?: string;     // the phone account id the call log actually stored
  idempotencyKey: string;
  synced?: boolean;
  outcome?: string; // Disposition tag
}

/** Everything that has to be true before Android will let the post-call popup appear. */
export interface PopupReadiness {
  enabled: boolean;
  overlay: boolean;
  notifications: boolean;
  battery: boolean;
  callLog: boolean;
  needsOemSteps: boolean;
  manufacturer: string;
  oemSteps: string;
  lastNote: string;
  lastNoteAt: number;
}

/** One switch this phone needs, read back from the system where Android allows — see SetupState.kt. */
export interface SetupStep {
  key: string;
  title: string;
  why: string;
  how: string;
  status: 'done' | 'todo' | 'confirmed' | 'unknown';
  required: boolean;
  kind: 'dialog' | 'screen' | 'manual';
  ok: boolean;
}
export interface SetupInfo {
  steps: SetupStep[];
  requiredLeft: number;
  optionalLeft: number;
  popupReady: boolean;
  manufacturer: string;
  model: string;
  android: string;
  sdk: number;
  appVersion: string;
  syncOkAt: number;
  syncError: string;
  syncErrorAt: number;
  bgRunAt: number;
  checkinAt: number;
  checkinError: string;
  monitorEnabled?: boolean;
  monitorRunning?: boolean;
}

const agoText = (ms: number): string => {
  if (!ms) return 'never';
  const sec = Math.max(0, (Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return `${Math.floor(sec / 86400)} days ago`;
};

/** Automatic SIM balance checks: the carrier's own code, run per SIM. */
export interface UssdSim {
  slot: number;
  carrier: string;
  code: string;
  lastReply: string;
  lastCheckedAt: number;
}
export interface UssdSettings {
  supported: boolean;
  enabled: boolean;
  callPermission: boolean;
  sims: UssdSim[];
}

export interface SimDiagnostics {
  sims?: Array<{ slot: number; subscriptionId: number; carrier: string; displayName: string; number: string }>;
  learned?: { [accountId: string]: number };
  liveSlot?: number;
  liveAt?: number;
}

/** Plain-English explanation of how a call's SIM was identified. */
const SIM_SOURCE_TEXT: { [key: string]: string } = {
  telecom: 'matched by phone account',
  account: 'matched by phone account',
  exact: 'matched exactly by the phone',
  label: 'matched by SIM name',
  oem: "from the phone maker's SIM column",
  subid: 'matched by subscription id',
  iccid: 'matched by SIM ICCID',
  live: 'captured live during the call',
  learned: 'remembered from an earlier call',
  slot: 'reported slot number',
  single: 'only one SIM in this phone',
  app: 'set in the app',
  unknown: 'could not be identified',
};

export interface SimNicknameMap {
  [key: string]: string;
}

const DEFAULT_SIM_MAPPING: SimNicknameMap = {
  'SIM 1': 'SIM 1: EdTech Inbound Leads',
  'SIM 2': 'SIM 2: Support & Admissions',
  'SIM_WAITING_FALLBACK': 'SIM (Primary Slot)',
};

const DISPOSITION_OPTIONS = [
  { label: 'Interested', color: '#059669', icon: '✓' },
  { label: 'Callback Scheduled', color: '#D97706', icon: '⏳' },
  { label: 'Not Answering', color: '#DC2626', icon: '✕' },
  { label: 'Enrolled', color: '#7C3AED', icon: '🎓' },
  { label: 'Resolved', color: '#10B981', icon: '✓' },
  { label: 'Course Query', color: '#4F46E5', icon: '💬' },
  { label: 'Escalated to Tech', color: '#DB2777', icon: '⚙' },
];



/** One line of "Is it working?" — label left, the phone's own evidence right. */
const HealthRow = ({ label, value, bad }: { label: string; value: string; bad?: boolean }) => (
  <View style={styles.healthRow}>
    <Text style={styles.healthLabel}>{label}</Text>
    <Text style={[styles.healthValue, bad && { color: '#B91C1C' }]} numberOfLines={3}>{value}</Text>
  </View>
);

const App = (): React.JSX.Element => {
  // Duty & Profile State
  const [permissionsGranted, setPermissionsGranted] = useState<boolean>(true);
  const [batteryOptIgnored, setBatteryOptIgnored] = useState<boolean>(true);
  const [pendingQueueCount, setPendingQueueCount] = useState<number>(0);

  // Feed & Filter State
  const [callLogs, setCallLogs] = useState<CallLogItem[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedFilter, setSelectedFilter] = useState<'ALL' | 'INCOMING' | 'OUTGOING' | 'MISSED'>('ALL');
  const [simNicknames, setSimNicknames] = useState<SimNicknameMap>(DEFAULT_SIM_MAPPING);

  // Modals & Interactivity
  const [activeDispositionCall, setActiveDispositionCall] = useState<CallLogItem | null>(null);
  const [isAdminModalOpen, setIsAdminModalOpen] = useState<boolean>(false);
  const [isAdminUnlocked, setIsAdminUnlocked] = useState<boolean>(false);
  const [pinInput, setPinInput] = useState<string>('');
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
  const [buildInfo, setBuildInfo] = useState<{ note: string; versionName: string; versionCode: number; installedAt: number } | null>(null);
  const [showBuildCard, setShowBuildCard] = useState<boolean>(false);
  const [connTest, setConnTest] = useState<{ busy: boolean; ok?: boolean; message?: string }>({ busy: false });
  // Read by the AppState listener, which must always see live values rather than a stale closure.
  const wizardRef = React.useRef<{ on: boolean; inFlight: string; attempted: Set<string> }>({ on: false, inFlight: '', attempted: new Set() });

  // Admin Config
  const [syncEndpoint, setSyncEndpoint] = useState<string>('https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php');
  const [endpointInput, setEndpointInput] = useState<string>('https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php');
  const [sim1Input, setSim1Input] = useState<string>('');
  const [sim2Input, setSim2Input] = useState<string>('');
  const [systemLogs, setSystemLogs] = useState<string[]>([]);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setSystemLogs((prev) => [`[${time}] ${msg}`, ...prev.slice(0, 24)]);
  };

  // Formatters
  /** Same as the dashboard: '45s' under a minute, '02:04' from a minute, '1:02:04' from an hour. */
  const formatDuration = (seconds: number): string => {
    const t = Math.max(0, Math.round(Number(seconds) || 0));
    if (t < 60) return `${t}s`;
    const two = (n: number) => String(n).padStart(2, '0');
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const r = t % 60;
    return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
  };

  const formatTotalTalkTime = (totalSeconds: number): string => {
    if (!totalSeconds || totalSeconds <= 0 || isNaN(totalSeconds)) return '0m 0s';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatRelativeTime = (timestampMs: number): string => {
    if (!timestampMs || isNaN(timestampMs)) return 'Recently';
    const now = Date.now();
    const diffSec = Math.floor((now - timestampMs) / 1000);

    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} mins ago`;

    const date = new Date(timestampMs);
    if (isNaN(date.getTime())) return 'Recently';

    const today = new Date();
    const isToday =
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();

    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (isToday) {
      return `Today, ${timeStr}`;
    }

    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    const isYesterday =
      date.getDate() === yesterday.getDate() &&
      date.getMonth() === yesterday.getMonth() &&
      date.getFullYear() === yesterday.getFullYear();

    if (isYesterday) {
      return `Yesterday, ${timeStr}`;
    }

    return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + `, ${timeStr}`;
  };

  const getSimLabel = (simIdRaw: string): string => {
    // The native side sends "SIM 1", "SIM 2" or "Unknown SIM" — already resolved, never a guess.
    if (!simIdRaw) return 'Unknown SIM';
    if (simNicknames[simIdRaw]) return simNicknames[simIdRaw];
    return simIdRaw;
  };

  const withTimeout = <T,>(promise: Promise<T>, ms = 1500, fallback: T): Promise<T> => {
    return Promise.race([
      promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
    ]);
  };

  // Asynchronous fetchSystemData function calling Native CallBridge
  const fetchSystemData = useCallback(async () => {
    try {
      if (!CallBridge) {
        addLog('CallBridge native module not linked.');
        setLoading(false);
        return;
      }

      const trackingPromise: Promise<any> = CallBridge.getTrackingStatus
        ? withTimeout<any>(CallBridge.getTrackingStatus().catch(() => null), 1500, null)
        : Promise.resolve(null);

      const batteryPromise = CallBridge.isBatteryOptimizationIgnored
        ? withTimeout(CallBridge.isBatteryOptimizationIgnored().catch(() => true), 1500, true)
        : Promise.resolve(true);

      const queuePromise = CallBridge.getPendingQueueCount
        ? withTimeout(CallBridge.getPendingQueueCount().catch(() => 0), 1500, 0)
        : Promise.resolve(0);

      const callsPromise = CallBridge.getRecentCalls
        ? withTimeout(CallBridge.getRecentCalls().catch(() => []), 1500, [])
        : Promise.resolve([]);

      const nicknamesPromise = CallBridge.getSimNicknames
        ? withTimeout(CallBridge.getSimNicknames().catch(() => '{}'), 1500, '{}')
        : Promise.resolve('{}');

      const [statusRes, batteryRes, queueRes, rawLogsRes, nicknameJson] = await Promise.all([
        trackingPromise,
        batteryPromise,
        queuePromise,
        callsPromise,
        nicknamesPromise,
      ]);

      if (statusRes) {
        setPermissionsGranted(!!statusRes.permissionsGranted);
        if (statusRes.syncEndpoint) {
          setSyncEndpoint(statusRes.syncEndpoint);
          setEndpointInput(statusRes.syncEndpoint);
        }
        if (typeof statusRes.overlayGranted === 'boolean') setOverlayGranted(statusRes.overlayGranted);
        if (typeof statusRes.popupEnabled === 'boolean') setPopupEnabled(statusRes.popupEnabled);
        if (typeof statusRes.popupForMissed === 'boolean') setPopupForMissed(statusRes.popupForMissed);
        if (typeof statusRes.popupTimeoutSec === 'number') setPopupTimeout(statusRes.popupTimeoutSec);
      }

      if (CallBridge?.getPopupReadiness) {
        try {
          setReadiness(await withTimeout<any>(CallBridge.getPopupReadiness().catch(() => null), 1500, null));
        } catch (_) {}
      }

      if (CallBridge?.getSetupState) {
        try {
          const st = await withTimeout<any>(CallBridge.getSetupState().catch(() => null), 2000, null);
          if (st) setSetup(st);
        } catch (_) {}
      }

      if (CallBridge?.getUssdSettings) {
        try {
          setUssd(await withTimeout<any>(CallBridge.getUssdSettings().catch(() => null), 1500, null));
        } catch (_) {}
      }

      if (CallBridge?.getSimDiagnostics) {
        try {
          const diagJson = await withTimeout(CallBridge.getSimDiagnostics().catch(() => '{}'), 1500, '{}');
          setSimDiag(JSON.parse(diagJson || '{}'));
        } catch (_) {}
      }

      if (typeof batteryRes === 'boolean') {
        setBatteryOptIgnored(batteryRes);
      }

      if (typeof queueRes === 'number') {
        setPendingQueueCount(queueRes);
      }

      if (nicknameJson && nicknameJson !== '{}') {
        try {
          const parsed = JSON.parse(nicknameJson);
          setSimNicknames((prev) => ({ ...prev, ...parsed }));
        } catch (_) {}
      }

      if (rawLogsRes && Array.isArray(rawLogsRes)) {
        setCallLogs((prevLogs) => {
          const outcomeMap: { [key: string]: string } = {};
          if (Array.isArray(prevLogs)) {
            prevLogs.forEach((item) => {
              if (item && item.outcome) outcomeMap[item.idempotencyKey] = item.outcome;
            });
          }
// code is test
          const merged = rawLogsRes.map((item: CallLogItem) => ({
            ...item,
            synced: true,
            outcome: outcomeMap[item.idempotencyKey] || item.outcome,
          }));

          return merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
        addLog(`Fetched ${rawLogsRes.length} live calls from device.`);
      }
    } catch (err: any) {
      addLog(`Fetch error: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /* The popup is the whole point of the app, so an install that cannot show it should not be able
     to go unnoticed: the setup sheet opens itself once per launch until it is sorted. */
  const setupPrompted = React.useRef(false);
  useEffect(() => {
    if (!setup || setupPrompted.current) return;
    setupPrompted.current = true;
    if (setup.steps.some((x) => x.required && x.status === 'todo')) {
      const t = setTimeout(() => setIsPopupSetupOpen(true), 600);
      return () => clearTimeout(t);
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
      if (searchQuery) { setSearchQuery(''); return true; }
      if (selectedFilter !== 'ALL') { setSelectedFilter('ALL'); return true; }
      return false;     // nothing open: let Android leave the app
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [activeDispositionCall, askConfirm, isPopupSetupOpen, isSimModalOpen, isAdminModalOpen, searchQuery, selectedFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (async () => {
      try {
        const info = await CallBridge?.getBuildInfo?.();
        if (info) {
          setBuildInfo(info);
          if (String(info.note || '').trim()) setShowBuildCard(true);
        }
      } catch (_) {}
    })();
  }, []);

  // AppState Listener
  useEffect(() => {
    fetchSystemData();

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        addLog('App returned to foreground: refreshing calls...');
        fetchSystemData();
      }
    });

    return () => {
      subscription.remove();
    };
  }, [fetchSystemData]);

  const handleManualRefresh = () => {
    addLog('Manual refresh triggered.');
    setLoading(true);
    fetchSystemData();
  };

  // Request Permissions
  const handleRequestPermissions = async () => {
    try {
      if (CallBridge?.requestPermissions) {
        await CallBridge.requestPermissions();
        addLog('Prompted runtime permissions.');
        setTimeout(fetchSystemData, 1000);
      } else {
        Alert.alert('Permission Request', 'Please grant READ_CALL_LOG permissions in Android settings.');
      }
    } catch (err: any) {
      addLog(`Permission error: ${err.message || err}`);
    }
  };

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
    }
  };

  // Xiaomi, Realme/Oppo, Vivo and Honor each hide their own pop-up and autostart switches in
  // their own security app; the native side knows where they are on this make of phone.
  const openOem = async (kind: 'popup' | 'autostart' | 'notifications') => {
    try {
      const ok = await CallBridge?.openOemSetting?.(kind);
      addLog(ok ? `Opened the ${kind} settings screen.` : `No ${kind} settings screen on this phone.`);
      if (!ok) Alert.alert('Open Settings manually', readiness?.oemSteps || 'Allow "Display over other apps" for CallIQ in Settings.');
      setTimeout(fetchSystemData, 2000);
    } catch (err: any) {
      addLog(`OEM settings error: ${err.message || err}`);
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
      Alert.alert('All set', 'Everything this phone needs is already on.');
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
  const stepReturnRef = React.useRef<(key: string) => void>(() => {});
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
    setUssd((u) => (u ? { ...u, sims: u.sims.map((s) => (s.slot === slot ? { ...s, code } : s)) } : u));
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

  const handleTestPopup = async () => {
    try {
      if (!CallBridge?.showPopupForLastCall) return;
      const shown = await CallBridge.showPopupForLastCall();
      if (shown) {
        addLog('Test popup shown for the most recent call.');
      } else {
        Alert.alert('No recent call', 'Make or receive a call first — the popup shows the last call in the log.');
      }
    } catch (err: any) {
      addLog(`Test popup error: ${err.message || err}`);
    }
  };

  // Battery Exemption Handler
  const handleRequestBatteryExemption = async () => {
    try {
      if (CallBridge?.requestIgnoreBatteryOptimizations) {
        await CallBridge.requestIgnoreBatteryOptimizations();
        addLog('Opened battery optimization settings.');
        setTimeout(fetchSystemData, 1500);
      }
    } catch (err: any) {
      addLog(`Battery settings error: ${err.message || err}`);
    }
  };

  // Force Sync Flush
  const handleForceFlushQueue = async () => {
    setSyncing(true);
    addLog('⚡ Force Flush triggered: Enqueuing WorkManager sync...');
    try {
      if (CallBridge?.triggerManualSync) {
        const res = await CallBridge.triggerManualSync();
        addLog(`WorkManager flush: ${res ? res.message : 'OK'}`);
        Alert.alert('Queue Flushed', 'WorkManager background task scheduled.');
      }
      await fetchSystemData();
    } catch (err: any) {
      addLog(`Flush error: ${err.message || err}`);
      Alert.alert('Sync Error', err.message || 'Failed to trigger flush.');
    } finally {
      setSyncing(false);
    }
  };

  // Save Disposition Outcome
  const handleSelectOutcome = async (outcomeLabel: string) => {
    if (!activeDispositionCall) return;

    setCallLogs((prev) =>
      prev.map((item) =>
        item && item.idempotencyKey === activeDispositionCall.idempotencyKey
          ? { ...item, outcome: outcomeLabel }
          : item
      )
    );

    addLog(`Tagged ${activeDispositionCall.number} as "${outcomeLabel}"`);

    try {
      if (CallBridge?.syncCallOutcome) {
        await CallBridge.syncCallOutcome(
          activeDispositionCall.number,
          activeDispositionCall.callType,
          activeDispositionCall.duration,
          activeDispositionCall.simId,
          activeDispositionCall.timestamp,
          activeDispositionCall.idempotencyKey,
          outcomeLabel
        );
      }
    } catch (err: any) {
      addLog(`Outcome sync notice: ${err.message || err}`);
    }

    setActiveDispositionCall(null);
  };

  // SIM Nicknames Saver
  const handleSaveSimNicknames = async () => {
    const updatedMap: SimNicknameMap = {
      ...simNicknames,
      'SIM 1': sim1Input.trim() || simNicknames['SIM 1'] || 'SIM 1: EdTech Inbound Leads',
      'SIM 2': sim2Input.trim() || simNicknames['SIM 2'] || 'SIM 2: Support & Admissions',
    };

    setSimNicknames(updatedMap);
    try {
      if (CallBridge?.saveSimNicknames) {
        await CallBridge.saveSimNicknames(JSON.stringify(updatedMap));
        addLog('Saved custom SIM nicknames to native preferences.');
      }
    } catch (err: any) {
      addLog(`Nickname save error: ${err.message || err}`);
    }
    setIsSimModalOpen(false);
  };

  // Admin PIN Verification
  const handleVerifyPin = () => {
    if (pinInput === '1234' || pinInput === '0000') {
      setIsAdminUnlocked(true);
      setPinInput('');
      addLog('Admin settings unlocked.');
    } else {
      Alert.alert('Access Denied', 'Invalid 4-digit Admin PIN. Default is 1234.');
    }
  };

  // Save Endpoint
  const handleSaveEndpoint = async () => {
    if (!endpointInput.trim()) {
      Alert.alert('Validation Error', 'Endpoint URL cannot be empty.');
      return;
    }

    try {
      if (CallBridge?.setSyncEndpoint) {
        await CallBridge.setSyncEndpoint(endpointInput.trim());
        setSyncEndpoint(endpointInput.trim());
        addLog(`Updated sync endpoint to: ${endpointInput.trim()}`);
        Alert.alert('Endpoint Saved', 'Remote server URL updated.');
      }
    } catch (err: any) {
      addLog(`Endpoint error: ${err.message || err}`);
    }
  };

  // Dynamically Calculated KPI Metrics
  const todayStartMs = new Date().setHours(0, 0, 0, 0);
  const todayCalls = useMemo(
    () => callLogs.filter((c) => c && c.timestamp && c.timestamp >= todayStartMs),
    [callLogs, todayStartMs]
  );
  const todayTotalDials = todayCalls.length;
  const todayTalkTimeSeconds = useMemo(
    () => todayCalls.reduce((acc, curr) => acc + (curr && curr.duration ? curr.duration : 0), 0),
    [todayCalls]
  );

  const connectionRateStr = useMemo(() => {
    if (!todayCalls || todayCalls.length === 0) return '100%';
    const connectedCount = todayCalls.filter(
      (c) => c && (c.duration > 0 || (c.callType !== 'MISSED' && c.callType !== 'REJECTED'))
    ).length;
    return `${Math.round((connectedCount / todayCalls.length) * 100)}%`;
  }, [todayCalls]);

  // Filtered Calls List
  const filteredCalls = useMemo(() => {
    if (!callLogs || !Array.isArray(callLogs)) return [];
    const list = callLogs.filter((item) => {
      if (!item) return false;
      // 1. Type Filter
      if (selectedFilter !== 'ALL') {
        if (selectedFilter === 'MISSED') {
          if (item.callType !== 'MISSED' && item.callType !== 'REJECTED') return false;
        } else if (item.callType !== selectedFilter) {
          return false;
        }
      }

      // 2. Search Query
      if (searchQuery && searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const numMatch = item.number ? item.number.toLowerCase().includes(query) : false;
        const outcomeMatch = item.outcome ? item.outcome.toLowerCase().includes(query) : false;
        return numMatch || outcomeMatch;
      }

      return true;
    });

    return list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  }, [callLogs, selectedFilter, searchQuery]);

  // Call Type Details
  const getCallTypeDetails = (type: string) => {
    switch (type ? type.toUpperCase() : '') {
      case 'INCOMING':
        return { label: 'INCOMING', icon: '↙', color: '#059669', bg: '#D1FAE5' };
      case 'OUTGOING':
        return { label: 'OUTGOING', icon: '↗', color: '#2563EB', bg: '#DBEAFE' };
      case 'MISSED':
        return { label: 'MISSED', icon: '✕', color: '#DC2626', bg: '#FEE2E2' };
      case 'REJECTED':
        return { label: 'REJECTED', icon: '⊘', color: '#475569', bg: '#F1F5F9' };
      default:
        return { label: type || 'CALL', icon: '•', color: '#64748B', bg: '#F1F5F9' };
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0F172A" />

      {/* Header Bar */}
      <View style={styles.headerBar}>
        <View style={styles.headerLeft}>
          <Text style={styles.brandTitle}>CallIQ Enterprise</Text>
          <Text style={styles.agentSub}>Agent Rahul 12:34 • Counselor Unit 01</Text>
        </View>

        <View style={styles.headerRightRow}>
          {/* Status Pill */}
          <View
            style={[
              styles.statusPill,
              { backgroundColor: pendingQueueCount > 0 ? '#78350F' : '#064E3B' },
            ]}
          >
            <View
              style={[
                styles.statusDot,
                { backgroundColor: pendingQueueCount > 0 ? '#F59E0B' : '#10B981' },
              ]}
            />
            <Text
              style={[
                styles.statusPillText,
                { color: pendingQueueCount > 0 ? '#FDE68A' : '#A7F3D0' },
              ]}
            >
              {pendingQueueCount > 0 ? `${pendingQueueCount} Queued` : 'Live Syncing'}
            </Text>
          </View>

          {/* Admin Gear Button */}
          <Pressable
            style={({ pressed }) => [styles.gearBtn, pressed && { opacity: 0.6 }]}
            onPress={() => setIsAdminModalOpen(true)}
            android_ripple={{ color: '#334155', borderless: true }}
          >
            <Text style={styles.gearBtnText}>⚙</Text>
          </Pressable>
        </View>
      </View>

      {/* Direct Native ScrollView */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollBody}
        keyboardShouldPersistTaps="always"
      >
        {/* Everything this phone still needs, from one list that knows this Android version and
            this maker — replaces the separate popup / battery / permission warnings. */}
        {setup && setup.steps.some((x) => x.required && !x.ok) && (() => {
          const off = setup.steps.filter((x) => x.required && x.status === 'todo');
          const unsure = setup.steps.filter((x) => x.required && x.status === 'unknown');
          return (
            <View style={styles.popupWarningCard}>
              <View style={{ flex: 1 }}>
                <Text style={styles.popupWarningTitle}>
                  {off.length
                    ? `⚠️ ${off.length} setting${off.length === 1 ? '' : 's'} still off`
                    : `☑️ ${unsure.length} to confirm`}
                </Text>
                <Text style={styles.popupWarningDesc}>
                  {off.length
                    ? `${off.map((x) => x.title).join(', ')}. Until ${off.length === 1 ? 'it is' : 'they are'} on, calls can be missed and the popup may not appear.`
                    : `${unsure.map((x) => x.title).join(', ')} — this phone cannot report ${unsure.length === 1 ? 'it' : 'them'}, so confirm once.`}
                </Text>
              </View>
              <Pressable
                style={({ pressed }: { pressed: boolean }) => [styles.popupFixBtn, pressed && { opacity: 0.7 }]}
                onPress={startWizard}
              >
                <Text style={styles.popupFixBtnText}>Allow all</Text>
              </Pressable>
            </View>
          );
        })()}

        {/* Calls that cannot reach the panel must not fail silently. */}
        {!!setup?.syncError && (
          <View style={styles.permCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.permTitle}>Calls are not uploading</Text>
              <Text style={styles.permDesc}>
                {setup.syncError}{pendingQueueCount > 0 ? ` — ${pendingQueueCount} waiting on this phone` : ''}. They upload by themselves once this is fixed.
              </Text>
            </View>
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [styles.permBtn, pressed && { opacity: 0.7 }]}
              onPress={() => { setIsPopupSetupOpen(true); handleTestConnection(); }}
            >
              <Text style={styles.permBtnText}>Test</Text>
            </Pressable>
          </View>
        )}

        {/* Top KPI Cards */}
        <View style={styles.kpiGridContainer}>
          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>TOTAL DIALS</Text>
            <Text style={styles.kpiValue}>{todayTotalDials}</Text>
            <Text style={styles.kpiSub}>Today's Calls</Text>
          </View>

          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>TALK TIME</Text>
            <Text style={styles.kpiValue}>{formatTotalTalkTime(todayTalkTimeSeconds)}</Text>
            <Text style={styles.kpiSub}>Active Duration</Text>
          </View>

          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>CONN. RATE</Text>
            <Text style={[styles.kpiValue, { color: '#059669' }]}>{connectionRateStr}</Text>
            <Text style={styles.kpiSub}>Answer Ratio</Text>
          </View>

          <View style={styles.kpiCard}>
            <Text style={styles.kpiLabel}>PENDING QUEUE</Text>
            <Text
              style={[
                styles.kpiValue,
                { color: pendingQueueCount > 0 ? '#D97706' : '#2563EB' },
              ]}
            >
              {pendingQueueCount}
            </Text>
            <Pressable onPress={handleForceFlushQueue} disabled={syncing}>
              <Text style={styles.kpiActionLink}>{syncing ? 'Syncing...' : 'Flush ⚡'}</Text>
            </Pressable>
          </View>
        </View>

        {/* Dual-SIM Active Mapping Card */}
        <View style={styles.simBarCard}>
          <View style={styles.simBarRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.simBarTitle}>Dual-SIM Active Mapping</Text>
              <Text style={styles.simBarSub} numberOfLines={1}>
                {getSimLabel('SIM 1')} | {getSimLabel('SIM 2')}
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.simEditBtn, pressed && { opacity: 0.7 }]}
              onPress={() => setIsSimModalOpen(true)}
            >
              <Text style={styles.simEditBtnText}>Edit Nicknames ⚙</Text>
            </Pressable>
          </View>
        </View>

        {/* Search & Filter Bar */}
        <View style={styles.searchContainer}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search number, outcome, or SIM..."
            placeholderTextColor="#94A3B8"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')}>
              <Text style={styles.clearSearchText}>✕</Text>
            </Pressable>
          )}
        </View>

        {/* Filter Tabs */}
        <View style={styles.filterTabRow}>
          {(['ALL', 'INCOMING', 'OUTGOING', 'MISSED'] as const).map((tab) => {
            const active = selectedFilter === tab;
            return (
              <Pressable
                key={tab}
                style={({ pressed }) => [
                  styles.filterTab,
                  active && styles.filterTabActive,
                  pressed && { opacity: 0.8 },
                ]}
                onPress={() => setSelectedFilter(tab)}
              >
                <Text style={[styles.filterTabText, active && styles.filterTabTextActive]}>
                  {tab}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Call Feed Header */}
        <View style={styles.feedHeaderRow}>
          <Text style={styles.sectionHeaderTitle}>
            LIVE DEVICE CALL FEED ({filteredCalls.length})
          </Text>
          <Pressable onPress={handleManualRefresh} disabled={loading}>
            <Text style={styles.refreshLink}>{loading ? 'Refreshing...' : '🔄 Refresh Feed'}</Text>
          </Pressable>
        </View>

        {/* Live Call Feed Cards List */}
        {loading ? (
          <ActivityIndicator color="#4F46E5" style={{ marginVertical: 30 }} />
        ) : filteredCalls.length === 0 ? (
          <View style={styles.emptyFeedCard}>
            <Text style={styles.emptyFeedTitle}>No calls found</Text>
            <Text style={styles.emptyFeedSub}>
              Recent calls logged on this device will automatically populate here.
            </Text>
          </View>
        ) : (
          filteredCalls.map((item) => {
            if (!item) return null;
            const typeInfo = getCallTypeDetails(item.callType);
            return (
              <View key={item.idempotencyKey || `${item.number}_${item.timestamp}`} style={styles.callCard}>
                <View style={styles.callCardHeader}>
                  <View style={styles.callCardLeft}>
                    <View style={[styles.typeBadge, { backgroundColor: typeInfo.bg }]}>
                      <Text style={[styles.typeBadgeText, { color: typeInfo.color }]}>
                        {typeInfo.icon} {typeInfo.label}
                      </Text>
                    </View>
                    <Text style={styles.callNumber}>{item.number}</Text>
                  </View>
                  <Text style={styles.callTime}>{formatRelativeTime(item.timestamp)}</Text>
                </View>

                <View style={styles.callCardBody}>
                  <Text style={styles.callMeta}>
                    <Text style={item.simSlot ? styles.simOk : styles.simUnknown}>{getSimLabel(item.simId)}</Text>
                    {item.simCarrier ? ` (${item.simCarrier})` : ''} • Duration: {formatDuration(item.duration)}
                  </Text>
                  {!item.simSlot && !!item.simSource && (
                    <Text style={styles.simHint}>SIM {SIM_SOURCE_TEXT[item.simSource] || item.simSource}</Text>
                  )}
                  <View style={styles.syncIndicatorRow}>
                    <Text
                      style={[
                        styles.syncIndicatorText,
                        { color: item.synced ? '#059669' : '#D97706' },
                      ]}
                    >
                      {item.synced ? '✓ Synced' : '⏳ Queued'}
                    </Text>
                  </View>
                </View>

                {/* Post-Call Disposition Action */}
                <View style={styles.callCardFooter}>
                  {item.outcome ? (
                    <Pressable
                      style={({ pressed }) => [styles.outcomeChip, pressed && { opacity: 0.7 }]}
                      onPress={() => setActiveDispositionCall(item)}
                    >
                      <Text style={styles.outcomeChipText}>✓ {item.outcome}</Text>
                      <Text style={styles.outcomeChipEdit}>Edit</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      style={({ pressed }) => [styles.logOutcomeBtn, pressed && { opacity: 0.7 }]}
                      onPress={() => setActiveDispositionCall(item)}
                    >
                      <Text style={styles.logOutcomeBtnText}>+ Tag Call Outcome</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      {/* Post-Call Disposition Modal */}
      <Modal visible={activeDispositionCall !== null} transparent animationType="slide" onRequestClose={() => setActiveDispositionCall(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View>
                <Text style={styles.modalTitle}>Tag Call Disposition</Text>
                <Text style={styles.modalSub}>{activeDispositionCall?.number}</Text>
              </View>
              <Pressable onPress={() => setActiveDispositionCall(null)}>
                <Text style={styles.closeModalText}>✕</Text>
              </Pressable>
            </View>

            <Text style={styles.dispositionPrompt}>1-Tap Outcome Selection:</Text>

            {DISPOSITION_OPTIONS.map((opt) => (
              <Pressable
                key={opt.label}
                style={({ pressed }) => [
                  styles.dispositionOptionBtn,
                  pressed && { opacity: 0.7 },
                ]}
                onPress={() => handleSelectOutcome(opt.label)}
              >
                <Text style={[styles.dispositionIcon, { color: opt.color }]}>{opt.icon}</Text>
                <Text style={styles.dispositionOptionText}>{opt.label}</Text>
              </Pressable>
            ))}

            <Pressable
              style={styles.modalCancelBtn}
              onPress={() => setActiveDispositionCall(null)}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* "This is the latest build" — whatever was in BUILD_NOTE.txt when this APK was built */}
      <Modal visible={showBuildCard && !!buildInfo} transparent animationType="fade" onRequestClose={() => setShowBuildCard(false)}>
        <Pressable style={styles.buildScrim} onPress={() => setShowBuildCard(false)}>
          <Pressable style={styles.buildCard} onPress={() => {}}>
            <Text style={styles.buildBadge}>✓ LATEST BUILD INSTALLED</Text>
            <Text style={styles.buildNote}>{buildInfo?.note}</Text>
            <View style={styles.buildMetaRow}>
              <Text style={styles.buildMeta}>
                v{buildInfo?.versionName} ({buildInfo?.versionCode})
              </Text>
              <Text style={styles.buildMeta}>
                installed {buildInfo?.installedAt
                  ? new Date(buildInfo.installedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
                  : '—'}
              </Text>
            </View>
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [styles.buildOk, pressed && { opacity: 0.85 }]}
              onPress={() => setShowBuildCard(false)}
            >
              <Text style={styles.buildOkText}>OK</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Phone setup — everything this phone needs, and one tap to allow it all */}
      <Modal visible={isPopupSetupOpen} transparent animationType="slide" onRequestClose={closeSetup}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Phone setup</Text>
                <Text style={styles.modalSub}>
                  {setup
                    ? `${setup.model} · Android ${setup.android} — only what this phone needs.`
                    : 'Checking this phone…'}
                </Text>
              </View>
              <Pressable onPress={closeSetup} hitSlop={12}>
                <Text style={styles.closeModalText}>✕</Text>
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 540 }} keyboardShouldPersistTaps="handled">
              {setup && typeof setup.monitorEnabled === 'boolean' && (
                <Pressable style={styles.settingRow} onPress={() => toggleMonitor(!setup.monitorEnabled)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingTitle}>
                      Keep CallIQ running <Text style={styles.settingDesc}>· recommended</Text>
                    </Text>
                    <Text style={styles.settingDesc}>
                      Stops Android pausing the app between calls, so every call — and every live call — reaches the
                      dashboard. Shows a quiet “CallIQ is tracking calls” notification.
                    </Text>
                  </View>
                  <View style={[styles.toggle, setup.monitorEnabled && styles.toggleOn]}>
                    <View style={[styles.toggleKnob, setup.monitorEnabled && styles.toggleKnobOn]} />
                  </View>
                </Pressable>
              )}

              {/* The one button */}
              {setup && setup.steps.some((x) => !x.ok) && !wizardOn && !askConfirm && (
                <Pressable
                  style={({ pressed }: { pressed: boolean }) => [styles.allowAllBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] }]}
                  onPress={startWizard}
                >
                  <Text style={styles.allowAllText}>Allow all permissions</Text>
                  <Text style={styles.allowAllSub}>
                    {setup.steps.filter((x) => !x.ok).length} step{setup.steps.filter((x) => !x.ok).length === 1 ? '' : 's'} · the app moves to the next one by itself
                  </Text>
                </Pressable>
              )}
              {setup && setup.steps.every((x) => x.ok) && (
                <View style={styles.allSetCard}>
                  <Text style={styles.allSetTitle}>✓ Everything is on</Text>
                  <Text style={styles.allSetSub}>Calls upload by themselves, and the popup appears after every call.</Text>
                </View>
              )}

              {/* The step in progress */}
              {wizardOn && !askConfirm && (() => {
                const cur = setup?.steps.find((x) => x.key === wizardKey);
                if (!cur) return null;
                return (
                  <View style={styles.wizardCard}>
                    <Text style={styles.wizardStepNo}>
                      STEP {Math.min(wizardRef.current.attempted.size, Math.max(wizardTotal, 1))} OF {Math.max(wizardTotal, 1)}
                    </Text>
                    <Text style={styles.wizardTitle}>{cur.title}</Text>
                    <Text style={styles.wizardHow}>{cur.how}</Text>
                    <Text style={styles.settingDesc}>
                      {cur.kind === 'dialog'
                        ? 'Answer on the screen that just opened.'
                        : cur.kind === 'screen'
                          ? 'Flip the switch — CallIQ comes back by itself. If it does not, press Back.'
                          : 'This phone does not tell apps when this is on. Flip it, then press Back.'}
                    </Text>
                    <View style={styles.wizardBtnRow}>
                      <Pressable style={styles.stepBtn} onPress={() => runStep(cur)}>
                        <Text style={styles.stepBtnText}>Open again</Text>
                      </Pressable>
                      <Pressable style={styles.ghostBtn} onPress={() => onStepDone(cur.key, { noAsk: true })}>
                        <Text style={styles.ghostBtnText}>Skip</Text>
                      </Pressable>
                      <Pressable style={styles.ghostBtn} onPress={() => finishWizard(setup)}>
                        <Text style={styles.ghostBtnText}>Stop</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })()}

              {/* A switch the phone cannot read back */}
              {askConfirm && (
                <View style={[styles.wizardCard, styles.wizardCardAsk]}>
                  <Text style={styles.wizardTitle}>Is “{askConfirm.title}” on now?</Text>
                  <Text style={styles.wizardHow}>{askConfirm.how}</Text>
                  <Text style={styles.settingDesc}>
                    {setup?.manufacturer || 'This'} phones do not let apps read this switch, so the app takes your word for it — the panel shows it as confirmed.
                  </Text>
                  <View style={styles.wizardBtnRow}>
                    <Pressable style={styles.stepBtn} onPress={() => answerConfirm(true)}>
                      <Text style={styles.stepBtnText}>Yes, it's on</Text>
                    </Pressable>
                    <Pressable style={styles.ghostBtn} onPress={() => { const st = askConfirm; setAskConfirm(null); runStep(st); }}>
                      <Text style={styles.ghostBtnText}>Open again</Text>
                    </Pressable>
                    <Pressable style={styles.ghostBtn} onPress={() => answerConfirm(false)}>
                      <Text style={styles.ghostBtnText}>Not yet</Text>
                    </Pressable>
                  </View>
                </View>
              )}

              {/* The checklist */}
              {!setup && <ActivityIndicator style={{ marginVertical: 24 }} color="#4F46E5" />}
              {(setup?.steps || []).map((step) => (
                <View key={step.key} style={[styles.stepRow, wizardOn && wizardKey === step.key && styles.stepRowActive]}>
                  <View style={[
                    styles.stepBadge,
                    step.ok && styles.stepBadgeOk,
                    step.status === 'todo' && styles.stepBadgeMissing,
                    step.status === 'unknown' && styles.stepBadgeUnknown,
                  ]}>
                    <Text style={[
                      styles.stepBadgeText,
                      step.ok && { color: '#047857' },
                      step.status === 'todo' && { color: '#B91C1C' },
                      step.status === 'unknown' && { color: '#B45309' },
                    ]}>
                      {step.ok ? '✓' : step.status === 'todo' ? '!' : '?'}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingTitle}>
                      {step.title}
                      {!step.required && <Text style={styles.settingDesc}>  · recommended</Text>}
                      {step.status === 'confirmed' && <Text style={styles.settingDesc}>  · you confirmed</Text>}
                      {step.status === 'unknown' && <Text style={styles.settingDesc}>  · not confirmed</Text>}
                    </Text>
                    <Text style={styles.settingDesc}>{step.ok ? step.why : `${step.why} ${step.how}`}</Text>
                  </View>
                  {!step.ok && !wizardOn && !askConfirm && (
                    <View style={{ gap: 6, alignItems: 'stretch' }}>
                      <Pressable style={({ pressed }: { pressed: boolean }) => [styles.stepBtn, pressed && { opacity: 0.7 }]} onPress={() => runSingle(step)}>
                        <Text style={styles.stepBtnText}>{step.kind === 'dialog' ? 'Allow' : 'Open'}</Text>
                      </Pressable>
                      {step.status === 'unknown' && (
                        <Pressable style={({ pressed }: { pressed: boolean }) => [styles.ghostBtn, pressed && { opacity: 0.7 }]} onPress={() => confirmDirect(step)}>
                          <Text style={styles.ghostBtnText}>It's on</Text>
                        </Pressable>
                      )}
                    </View>
                  )}
                </View>
              ))}

              {/* Proof, not promises */}
              {setup && (
                <View style={styles.healthBox}>
                  <Text style={styles.noteBoxTitle}>Is it working?</Text>
                  {typeof setup.monitorEnabled === 'boolean' && (
                    <HealthRow
                      label="Kept running between calls"
                      value={setup.monitorRunning ? 'Yes' : setup.monitorEnabled ? 'Not yet — close and reopen CallIQ' : 'Switched off'}
                      bad={!setup.monitorRunning}
                    />
                  )}
                  <HealthRow
                    label="Calls last uploaded"
                    value={setup.syncError ? `Failing — ${setup.syncError}` : agoText(setup.syncOkAt)}
                    bad={!!setup.syncError}
                  />
                  <HealthRow
                    label="Ran by itself in the background"
                    value={setup.bgRunAt ? agoText(setup.bgRunAt) : 'not yet — check again in 15 min'}
                    bad={!!setup.bgRunAt && Date.now() - setup.bgRunAt > 6 * 3600 * 1000}
                  />
                  <HealthRow
                    label="Setup reported to the panel"
                    value={setup.checkinError ? `Failing — ${setup.checkinError}` : agoText(setup.checkinAt)}
                    bad={!!setup.checkinError}
                  />
                  <Pressable
                    style={({ pressed }: { pressed: boolean }) => [styles.stepBtn, { alignSelf: 'flex-start', marginTop: 10 }, (pressed || connTest.busy) && { opacity: 0.7 }]}
                    onPress={handleTestConnection}
                    disabled={connTest.busy}
                  >
                    <Text style={styles.stepBtnText}>{connTest.busy ? 'Testing…' : 'Test connection'}</Text>
                  </Pressable>
                  {!!connTest.message && (
                    <Text style={[styles.settingDesc, { marginTop: 6, color: connTest.ok ? '#047857' : '#B91C1C' }]}>
                      {connTest.message}
                    </Text>
                  )}
                </View>
              )}

              <Pressable style={styles.modalSaveBtn} onPress={handleSimulateCallEnd}>
                <Text style={styles.modalSaveText}>▶ Test the popup now</Text>
              </Pressable>
              <Text style={styles.settingDesc}>
                This runs exactly what a real hang-up runs. If the card appears here, it appears after calls.
              </Text>

              {!!readiness?.lastNote && (
                <View style={styles.noteBox}>
                  <Text style={styles.noteBoxTitle}>Last call</Text>
                  <Text style={styles.noteBoxText}>{readiness.lastNote}</Text>
                </View>
              )}

              <Pressable style={styles.modalCancelBtn} onPress={() => { closeSetup(); fetchSystemData(); }}>
                <Text style={styles.modalCancelText}>Done</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Configure SIM Nicknames Modal */}
      <Modal visible={isSimModalOpen} transparent animationType="fade" onRequestClose={() => setIsSimModalOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Configure Friendly SIM Labels</Text>
            <Text style={styles.modalSub}>Nicknames are transmitted alongside call logs to the CRM backend.</Text>

            <Text style={styles.inputLabel}>SIM 1 Label (Slot 1)</Text>
            <TextInput
              style={styles.modalInput}
              value={sim1Input}
              onChangeText={setSim1Input}
              placeholder={simNicknames['SIM 1'] || 'SIM 1: EdTech Inbound Leads'}
              placeholderTextColor="#94A3B8"
            />

            <Text style={styles.inputLabel}>SIM 2 Label (Slot 2)</Text>
            <TextInput
              style={styles.modalInput}
              value={sim2Input}
              onChangeText={setSim2Input}
              placeholder={simNicknames['SIM 2'] || 'SIM 2: Support & Admissions'}
              placeholderTextColor="#94A3B8"
            />

            <View style={styles.modalBtnRow}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => setIsSimModalOpen(false)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={styles.modalSaveBtn}
                onPress={handleSaveSimNicknames}
              >
                <Text style={styles.modalSaveText}>Save Labels</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Admin Lock & Settings Modal */}
      <Modal visible={isAdminModalOpen} transparent animationType="slide" onRequestClose={() => setIsAdminModalOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <Text style={styles.modalTitle}>Admin &amp; System Settings</Text>
              <Pressable onPress={() => setIsAdminModalOpen(false)}>
                <Text style={styles.closeModalText}>✕</Text>
              </Pressable>
            </View>

            {!isAdminUnlocked ? (
              <View style={styles.pinContainer}>
                <Text style={styles.pinTitle}>🔒 Enter Admin Security PIN</Text>
                <Text style={styles.pinSub}>Settings and endpoint configuration require authorization.</Text>

                <TextInput
                  style={styles.pinInput}
                  value={pinInput}
                  onChangeText={setPinInput}
                  placeholder="Enter 4-digit PIN (1234)"
                  placeholderTextColor="#94A3B8"
                  keyboardType="number-pad"
                  secureTextEntry
                  maxLength={4}
                />

                <Pressable
                  style={styles.pinSubmitBtn}
                  onPress={handleVerifyPin}
                >
                  <Text style={styles.pinSubmitText}>Unlock Settings</Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ maxHeight: 420 }}>
                <Text style={styles.inputLabel}>CRM Call Log Endpoint URL</Text>
                <TextInput
                  style={styles.modalInput}
                  value={endpointInput}
                  onChangeText={setEndpointInput}
                  placeholder="https://cit3.internshipstudio.com/admin/react-api/api/caller-iq/log_call.php"
                  placeholderTextColor="#94A3B8"
                  autoCapitalize="none"
                />
                <Pressable
                  style={styles.modalSaveBtn}
                  onPress={handleSaveEndpoint}
                >
                  <Text style={styles.modalSaveText}>Save Endpoint</Text>
                </Pressable>

                <Pressable
                  style={styles.diagActionBtn}
                  onPress={handleForceFlushQueue}
                >
                  <Text style={styles.diagActionBtnText}>⚡ Force Flush WorkManager Queue</Text>
                </Pressable>

                {/* ── Post-call popup ── */}
                <Text style={[styles.inputLabel, { marginTop: 18 }]}>Post-Call Popup</Text>
                <Pressable
                  style={styles.settingRow}
                  onPress={() => savePopupSettings(!popupEnabled, popupForMissed, popupTimeout)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingTitle}>Ask for the outcome after every call</Text>
                    <Text style={styles.settingDesc}>
                      {overlayGranted
                        ? 'Shows over whatever is on screen when the call ends.'
                        : 'Needs "Display over other apps" — a notification is used until then.'}
                    </Text>
                  </View>
                  <View style={[styles.toggle, popupEnabled && styles.toggleOn]}>
                    <View style={[styles.toggleKnob, popupEnabled && styles.toggleKnobOn]} />
                  </View>
                </Pressable>

                <Pressable
                  style={styles.settingRow}
                  onPress={() => savePopupSettings(popupEnabled, !popupForMissed, popupTimeout)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingTitle}>Also ask after missed &amp; rejected calls</Text>
                    <Text style={styles.settingDesc}>Useful for scheduling a callback straight away.</Text>
                  </View>
                  <View style={[styles.toggle, popupForMissed && styles.toggleOn]}>
                    <View style={[styles.toggleKnob, popupForMissed && styles.toggleKnobOn]} />
                  </View>
                </Pressable>

                <Text style={styles.settingTitle}>Closes itself after</Text>
                <View style={styles.chipRow}>
                  {[20, 30, 45, 60, 120].map((sec) => (
                    <Pressable
                      key={sec}
                      style={[styles.choiceChip, popupTimeout === sec && styles.choiceChipOn]}
                      onPress={() => savePopupSettings(popupEnabled, popupForMissed, sec)}
                    >
                      <Text style={[styles.choiceChipText, popupTimeout === sec && styles.choiceChipTextOn]}>{sec}s</Text>
                    </Pressable>
                  ))}
                </View>

                <View style={{ flexDirection: 'row', marginTop: 10 }}>
                  {!overlayGranted && (
                    <Pressable style={[styles.diagActionBtn, { flex: 1, marginRight: 8 }]} onPress={handleEnableOverlay}>
                      <Text style={styles.diagActionBtnText}>Allow display over apps</Text>
                    </Pressable>
                  )}
                  <Pressable style={[styles.diagActionBtn, { flex: 1 }]} onPress={handleTestPopup}>
                    <Text style={styles.diagActionBtnText}>👁 Preview popup</Text>
                  </Pressable>
                </View>

                {/* ── SIM detection ── */}
                <Text style={[styles.inputLabel, { marginTop: 18 }]}>SIM Detection</Text>
                {(simDiag.sims || []).length === 0 ? (
                  <Text style={styles.settingDesc}>
                    No SIMs reported. Grant the Phone permission so calls can be matched to a SIM.
                  </Text>
                ) : (
                  (simDiag.sims || []).map((s) => (
                    <View key={s.slot} style={styles.simDiagRow}>
                      <Text style={styles.simDiagSlot}>SIM {s.slot}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingTitle}>{s.carrier || s.displayName || `Slot ${s.slot}`}</Text>
                        <Text style={styles.settingDesc}>
                          sub id {s.subscriptionId}
                          {s.number ? ` • ${s.number}` : ''}
                          {simNicknames[`SIM ${s.slot}`] ? ` • ${simNicknames[`SIM ${s.slot}`]}` : ''}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
                {!!simDiag.liveSlot && (
                  <Text style={styles.settingDesc}>Last call was placed on SIM {simDiag.liveSlot}.</Text>
                )}
                <Text style={styles.settingDesc}>
                  {Object.keys(simDiag.learned || {}).length} phone account
                  {Object.keys(simDiag.learned || {}).length === 1 ? '' : 's'} learned from this phone's call log.
                  The feed above shows how each call was matched.
                </Text>

                {/* ── SIM balance (USSD) ── */}
                <Text style={[styles.inputLabel, { marginTop: 18 }]}>SIM Balance &amp; Validity</Text>
                {!ussd?.supported ? (
                  <Text style={styles.settingDesc}>This phone is too old for automatic balance checks (needs Android 8).</Text>
                ) : (
                  <>
                    <Pressable style={styles.settingRow} onPress={() => toggleUssd(!ussd.enabled)}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.settingTitle}>Check each SIM once a day</Text>
                        <Text style={styles.settingDesc}>
                          Runs the operator's own code (like *121#) in the background and sends the reply to the
                          dashboard. Android tells apps nothing about a balance, so this is the only way to read it.
                        </Text>
                      </View>
                      <View style={[styles.toggle, ussd.enabled && styles.toggleOn]}>
                        <View style={[styles.toggleKnob, ussd.enabled && styles.toggleKnobOn]} />
                      </View>
                    </Pressable>

                    {!ussd.callPermission && (
                      <Text style={styles.settingDesc}>
                        The Phone-calls permission is needed — the check runs on the line. Tap “Check now” and allow it.
                      </Text>
                    )}

                    {(ussd.sims || []).map((s) => (
                      <View key={s.slot} style={styles.simDiagRow}>
                        <Text style={styles.simDiagSlot}>SIM {s.slot}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.settingTitle}>{s.carrier || `Slot ${s.slot}`}</Text>
                          <TextInput
                            style={[styles.modalInput, { marginTop: 6 }]}
                            value={s.code}
                            onChangeText={(v) => saveUssdCode(s.slot, v)}
                            placeholder="*121#"
                            placeholderTextColor="#94A3B8"
                            autoCapitalize="none"
                          />
                          {!!s.lastReply && <Text style={styles.settingDesc}>Last reply: {s.lastReply}</Text>}
                        </View>
                        <Pressable
                          style={({ pressed }: { pressed: boolean }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}
                          onPress={() => checkBalanceNow(s.slot)}
                          disabled={checkingSlot === s.slot}
                        >
                          <Text style={styles.stepBtnText}>{checkingSlot === s.slot ? '…' : 'Check now'}</Text>
                        </Pressable>
                      </View>
                    ))}
                    <Text style={styles.settingDesc}>
                      Codes that answer with a menu (“reply 1 for balance”) cannot be read automatically — only
                      one-shot codes. Jio answers little over USSD; record those by hand in the dashboard.
                    </Text>
                  </>
                )}

                <Text style={[styles.inputLabel, { marginTop: 18 }]}>Live System Console Logs</Text>
                <View style={styles.logBox}>
                  {systemLogs.length === 0 ? (
                    <Text style={{ color: '#64748B', fontSize: 11 }}>No system events logged.</Text>
                  ) : (
                    systemLogs.map((log, idx) => (
                      <Text key={idx} style={styles.logText}>
                        {log}
                      </Text>
                    ))
                  )}
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  // Latest-build card
  buildScrim: { flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.55)', justifyContent: 'center', padding: 24 },
  buildCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    padding: 22,
    borderTopWidth: 5,
    borderTopColor: '#10B981',
    elevation: 10,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  buildBadge: { fontSize: 11, fontWeight: '800', color: '#047857', letterSpacing: 0.8 },
  buildNote: { fontSize: 20, fontWeight: '800', color: '#0F172A', marginTop: 10, lineHeight: 27 },
  buildMetaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14, flexWrap: 'wrap', gap: 6 },
  buildMeta: { fontSize: 12, color: '#64748B', fontWeight: '600' },
  buildOk: { backgroundColor: '#10B981', borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 18 },
  buildOkText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  // Phone setup
  allowAllBtn: {
    backgroundColor: '#4F46E5',
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 14,
    alignItems: 'center',
    elevation: 3,
    shadowColor: '#4F46E5',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  allowAllText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  allowAllSub: { color: '#E0E7FF', fontSize: 11.5, marginTop: 3 },
  allSetCard: { backgroundColor: '#ECFDF5', borderRadius: 12, padding: 14, marginBottom: 14 },
  allSetTitle: { color: '#047857', fontSize: 15, fontWeight: '800' },
  allSetSub: { color: '#065F46', fontSize: 12, marginTop: 3 },
  wizardCard: {
    backgroundColor: '#EEF2FF',
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: '#C7D2FE',
  },
  wizardCardAsk: { backgroundColor: '#FFFBEB', borderColor: '#FDE68A' },
  wizardStepNo: { fontSize: 10.5, fontWeight: '800', color: '#6366F1', letterSpacing: 0.6 },
  wizardTitle: { fontSize: 16, fontWeight: '800', color: '#0F172A', marginTop: 4 },
  wizardHow: { fontSize: 13, color: '#1E293B', marginTop: 6, marginBottom: 6, lineHeight: 19 },
  wizardBtnRow: { flexDirection: 'row', gap: 8, marginTop: 12, flexWrap: 'wrap' },
  ghostBtn: {
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  ghostBtnText: { color: '#334155', fontWeight: '700', fontSize: 11 },
  stepRowActive: { backgroundColor: '#EEF2FF', borderRadius: 10 },
  stepBadgeUnknown: { backgroundColor: '#FFFBEB' },
  healthBox: { backgroundColor: '#F8FAFC', borderRadius: 12, padding: 12, marginTop: 10, marginBottom: 14, borderWidth: 1, borderColor: '#E2E8F0' },
  healthRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 5 },
  healthLabel: { fontSize: 12, color: '#64748B', flexShrink: 0 },
  healthValue: { fontSize: 12, color: '#0F172A', fontWeight: '700', flex: 1, textAlign: 'right' },

  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  headerBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#0F172A',
  },
  headerLeft: {
    flex: 1,
  },
  brandTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  agentSub: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  headerRightRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 16,
    marginRight: 8,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '800',
  },
  gearBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearBtnText: {
    color: '#94A3B8',
    fontSize: 18,
  },
  scrollBody: {
    padding: 16,
  },
  batteryWarningCard: {
    backgroundColor: '#FEF3C7',
    borderColor: '#F59E0B',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  batteryWarningTitle: {
    color: '#B45309',
    fontWeight: '700',
    fontSize: 13,
  },
  batteryWarningDesc: {
    color: '#92400E',
    fontSize: 11,
    marginTop: 2,
  },
  batteryFixBtn: {
    backgroundColor: '#D97706',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 10,
  },
  batteryFixBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
  },
  /* Post-call popup prompt */
  popupWarningCard: {
    backgroundColor: '#EEF2FF',
    borderColor: '#818CF8',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  popupWarningTitle: {
    color: '#3730A3',
    fontWeight: '700',
    fontSize: 13,
  },
  popupWarningDesc: {
    color: '#4338CA',
    fontSize: 11,
    marginTop: 2,
  },
  popupFixBtn: {
    backgroundColor: '#4F46E5',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 6,
    marginLeft: 10,
  },
  popupFixBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
  },
  /* Settings rows in the admin sheet */
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  settingTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0F172A',
  },
  settingDesc: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  toggle: {
    width: 40,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#CBD5E1',
    padding: 2,
    marginLeft: 10,
    justifyContent: 'center',
  },
  toggleOn: {
    backgroundColor: '#4F46E5',
  },
  toggleKnob: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#FFFFFF',
  },
  toggleKnobOn: {
    alignSelf: 'flex-end',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: 8,
  },
  choiceChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    backgroundColor: '#FFFFFF',
    marginRight: 6,
    marginBottom: 6,
  },
  choiceChipOn: {
    backgroundColor: '#EEF2FF',
    borderColor: '#818CF8',
  },
  choiceChipText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
  },
  choiceChipTextOn: {
    color: '#4338CA',
  },
  simDiagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 6,
  },
  simDiagSlot: {
    fontSize: 11,
    fontWeight: '800',
    color: '#4338CA',
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 10,
  },
  simOk: {
    color: '#0F172A',
    fontWeight: '700',
  },
  simUnknown: {
    color: '#B45309',
    fontWeight: '700',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#E2E8F0',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 1,
  },
  stepBadgeOk: { backgroundColor: '#D1FAE5' },
  stepBadgeMissing: { backgroundColor: '#FEE2E2' },
  stepBadgeText: { fontSize: 12, fontWeight: '800', color: '#475569' },
  stepBtn: {
    backgroundColor: '#4F46E5',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 7,
    marginLeft: 10,
  },
  stepBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 11 },
  noteBox: {
    backgroundColor: '#F1F5F9',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  noteBoxTitle: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.5,
    color: '#64748B',
    textTransform: 'uppercase',
  },
  noteBoxText: { fontSize: 12, color: '#334155', marginTop: 3 },
  simHint: {
    fontSize: 10,
    color: '#94A3B8',
    marginTop: 2,
  },
  permCard: {
    backgroundColor: '#FFEDD5',
    borderColor: '#EA580C',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  permTitle: {
    color: '#9A3412',
    fontWeight: '700',
    fontSize: 13,
  },
  permDesc: {
    color: '#C2410C',
    fontSize: 11,
    marginTop: 2,
  },
  permBtn: {
    backgroundColor: '#EA580C',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginLeft: 10,
  },
  permBtnText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 11,
  },
  kpiGridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  kpiCard: {
    width: '48.5%',
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  kpiLabel: {
    fontSize: 9,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  kpiValue: {
    fontSize: 20,
    fontWeight: '800',
    color: '#0F172A',
    marginVertical: 4,
  },
  kpiSub: {
    fontSize: 10,
    color: '#94A3B8',
  },
  kpiActionLink: {
    fontSize: 11,
    fontWeight: '700',
    color: '#2563EB',
    marginTop: 2,
  },
  simBarCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  simBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  simBarTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: '#0F172A',
  },
  simBarSub: {
    fontSize: 11,
    color: '#64748B',
    marginTop: 2,
  },
  simEditBtn: {
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  simEditBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#4F46E5',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  searchIcon: {
    fontSize: 14,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
  },
  clearSearchText: {
    color: '#94A3B8',
    fontSize: 14,
    fontWeight: '700',
    padding: 4,
  },
  filterTabRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  filterTab: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    backgroundColor: '#E2E8F0',
    borderRadius: 8,
    marginRight: 6,
  },
  filterTabActive: {
    backgroundColor: '#4F46E5',
  },
  filterTabText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },
  filterTabTextActive: {
    color: '#FFFFFF',
  },
  feedHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  sectionHeaderTitle: {
    fontSize: 11,
    fontWeight: '800',
    color: '#64748B',
    letterSpacing: 0.5,
  },
  refreshLink: {
    fontSize: 12,
    color: '#4F46E5',
    fontWeight: '700',
  },
  emptyFeedCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 24,
    alignItems: 'center',
  },
  emptyFeedTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#475569',
  },
  emptyFeedSub: {
    fontSize: 12,
    color: '#94A3B8',
    marginTop: 4,
  },
  callCard: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  callCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  callCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  typeBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    marginRight: 8,
  },
  typeBadgeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  callNumber: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  callTime: {
    fontSize: 11,
    color: '#94A3B8',
  },
  callCardBody: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  callMeta: {
    fontSize: 12,
    color: '#64748B',
  },
  syncIndicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  syncIndicatorText: {
    fontSize: 11,
    fontWeight: '700',
  },
  callCardFooter: {
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingTop: 8,
    alignItems: 'flex-start',
  },
  logOutcomeBtn: {
    backgroundColor: '#EEF2FF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  logOutcomeBtnText: {
    color: '#4F46E5',
    fontSize: 12,
    fontWeight: '700',
  },
  outcomeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ECFDF5',
    borderColor: '#A7F3D0',
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  outcomeChipText: {
    color: '#047857',
    fontSize: 12,
    fontWeight: '700',
    marginRight: 6,
  },
  outcomeChipEdit: {
    color: '#9CA3AF',
    fontSize: 10,
    fontWeight: '600',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0F172A',
  },
  modalSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 2,
  },
  closeModalText: {
    color: '#64748B',
    fontSize: 20,
    fontWeight: '700',
  },
  dispositionPrompt: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 12,
    marginTop: 6,
  },
  dispositionOptionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderColor: '#E2E8F0',
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  dispositionIcon: {
    fontSize: 16,
    marginRight: 12,
  },
  dispositionOptionText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0F172A',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
    marginTop: 10,
  },
  modalInput: {
    backgroundColor: '#F8FAFC',
    borderColor: '#CBD5E1',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: '#0F172A',
  },
  modalBtnRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  modalCancelBtn: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  modalCancelText: {
    color: '#64748B',
    fontWeight: '700',
    fontSize: 13,
  },
  modalSaveBtn: {
    backgroundColor: '#4F46E5',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  modalSaveText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  pinContainer: {
    paddingVertical: 10,
  },
  pinTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0F172A',
  },
  pinSub: {
    fontSize: 12,
    color: '#64748B',
    marginTop: 4,
    marginBottom: 14,
  },
  pinInput: {
    backgroundColor: '#F8FAFC',
    borderColor: '#CBD5E1',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    textAlign: 'center',
    letterSpacing: 4,
    color: '#0F172A',
  },
  pinSubmitBtn: {
    backgroundColor: '#0F172A',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 14,
  },
  pinSubmitText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },
  diagActionBtn: {
    backgroundColor: '#1E293B',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 12,
  },
  diagActionBtnText: {
    color: '#F8FAFC',
    fontWeight: '700',
    fontSize: 12,
  },
  logBox: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    padding: 10,
    maxHeight: 160,
    marginTop: 8,
  },
  logText: {
    color: '#A7F3D0',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  },
});

export default App;