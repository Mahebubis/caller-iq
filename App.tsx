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
  const formatDuration = (seconds: number): string => {
    if (!seconds || seconds <= 0 || isNaN(seconds)) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const mm = m < 10 ? `0${m}` : `${m}`;
    const ss = s < 10 ? `0${s}` : `${s}`;
    return `${mm}:${ss}`;
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
    if (!readiness || setupPrompted.current) return;
    if (!readiness.overlay || !readiness.callLog) {
      setupPrompted.current = true;
      const t = setTimeout(() => setIsPopupSetupOpen(true), 600);
      return () => clearTimeout(t);
    }
    setupPrompted.current = true;
    return undefined;
  }, [readiness]);

  /*
   * Android's back button should close what is open — a sheet, a dialog — and only leave the app
   * when nothing is. Without this every back press quits mid-task, which on a phone feels broken.
   */
  useEffect(() => {
    const onBack = () => {
      if (activeDispositionCall) { setActiveDispositionCall(null); return true; }
      if (isPopupSetupOpen) { setIsPopupSetupOpen(false); return true; }
      if (isSimModalOpen) { setIsSimModalOpen(false); return true; }
      if (isAdminModalOpen) { setIsAdminModalOpen(false); return true; }
      if (searchQuery) { setSearchQuery(''); return true; }
      if (selectedFilter !== 'ALL') { setSelectedFilter('ALL'); return true; }
      return false;     // nothing open: let Android leave the app
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [activeDispositionCall, isPopupSetupOpen, isSimModalOpen, isAdminModalOpen, searchQuery, selectedFilter]);

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

  /* What still stands between a hung-up call and the popup. "Display over other apps" is the only
     hard requirement; the rest decide whether it keeps working once the app is out of sight. */
  const readinessSteps = useMemo(() => {
    if (!readiness) return [];
    return [
      {
        key: 'callLog',
        ok: readiness.callLog,
        title: 'Call log & Phone permission',
        desc: 'Lets the app see that a call happened, and which SIM it used.',
        action: handleRequestPermissions,
        cta: 'Allow',
        required: true,
      },
      {
        key: 'overlay',
        ok: readiness.overlay,
        title: 'Display over other apps',
        desc: 'Android blocks every popup over the dialer without this. This is the one that matters.',
        action: handleEnableOverlay,
        cta: 'Allow',
        required: true,
      },
      ...(readiness.needsOemSteps ? [{
        key: 'oemPopup',
        ok: null as boolean | null,
        title: `${readiness.manufacturer}: background pop-ups`,
        desc: readiness.oemSteps,
        action: () => openOem('popup'),
        cta: 'Open',
        required: true,
      }, {
        key: 'oemAutostart',
        ok: null as boolean | null,
        title: `${readiness.manufacturer}: autostart`,
        desc: 'Without autostart this phone stops waking the app once it is swiped away, so no call is noticed at all.',
        action: () => openOem('autostart'),
        cta: 'Open',
        required: true,
      }] : []),
      {
        key: 'battery',
        ok: readiness.battery,
        title: 'Unrestricted battery',
        desc: 'Stops Android pausing the app between calls.',
        action: handleRequestBatteryExemption,
        cta: 'Fix',
        required: false,
      },
      {
        key: 'notifications',
        ok: readiness.notifications,
        title: 'Notifications',
        desc: 'The fallback prompt when the popup itself cannot be drawn.',
        action: () => openOem('notifications'),
        cta: 'Allow',
        required: false,
      },
    ];
  }, [readiness]);

  // Steps the phone can actually verify. The OEM ones cannot be read back, so they are never
  // counted as done — they are shown as "check once".
  const missingSteps = readinessSteps.filter((s) => s.ok === false).length;
  const popupReady = !!readiness && readiness.overlay && readiness.callLog && !readiness.needsOemSteps;

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
        {/* The popup cannot appear until Android (and, on some makes, the phone's own security
            app) allows it. Rather than failing silently, say exactly what is still missing. */}
        {popupEnabled && readiness && !popupReady && (
          <View style={styles.popupWarningCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.popupWarningTitle}>
                📋 Post-call popup is not ready{missingSteps > 0 ? ` — ${missingSteps} step${missingSteps === 1 ? '' : 's'} left` : ''}
              </Text>
              <Text style={styles.popupWarningDesc}>
                {!readiness.overlay
                  ? 'Android needs “Display over other apps” before anything can show over the dialer.'
                  : readiness.needsOemSteps
                    ? `${readiness.manufacturer} also has its own pop-up and autostart switches.`
                    : 'One or two settings still need allowing.'}
              </Text>
            </View>
            <Pressable
              style={({ pressed }: { pressed: boolean }) => [styles.popupFixBtn, pressed && { opacity: 0.7 }]}
              onPress={() => setIsPopupSetupOpen(true)}
            >
              <Text style={styles.popupFixBtnText}>Fix now</Text>
            </Pressable>
          </View>
        )}

        {/* OEM Battery Saver Warning Card */}
        {!batteryOptIgnored && (
          <View style={styles.batteryWarningCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.batteryWarningTitle}>⚠️ Unrestricted Battery Required</Text>
              <Text style={styles.batteryWarningDesc}>
                OEM battery optimization may suspend background receivers when idle.
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.batteryFixBtn, pressed && { opacity: 0.7 }]}
              onPress={handleRequestBatteryExemption}
            >
              <Text style={styles.batteryFixBtnText}>Fix Now</Text>
            </Pressable>
          </View>
        )}

        {/* Missing Permissions Banner */}
        {!permissionsGranted && (
          <View style={styles.permCard}>
            <View style={{ flex: 1 }}>
              <Text style={styles.permTitle}>Permissions Missing</Text>
              <Text style={styles.permDesc}>
                READ_CALL_LOG &amp; READ_PHONE_STATE permissions required to read device call logs.
              </Text>
            </View>
            <Pressable
              style={({ pressed }) => [styles.permBtn, pressed && { opacity: 0.7 }]}
              onPress={handleRequestPermissions}
            >
              <Text style={styles.permBtnText}>Enable</Text>
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
      <Modal visible={activeDispositionCall !== null} transparent animationType="slide">
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

      {/* Post-Call Popup Setup */}
      <Modal visible={isPopupSetupOpen} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Post-Call Popup Setup</Text>
                <Text style={styles.modalSub}>
                  Android only lets an app show a card over the dialer once these are allowed.
                </Text>
              </View>
              <Pressable onPress={() => setIsPopupSetupOpen(false)}>
                <Text style={styles.closeModalText}>✕</Text>
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 460 }}>
              {readinessSteps.map((step, idx) => (
                <View key={step.key} style={styles.stepRow}>
                  <View style={[
                    styles.stepBadge,
                    step.ok === true && styles.stepBadgeOk,
                    step.ok === false && styles.stepBadgeMissing,
                  ]}>
                    <Text style={[
                      styles.stepBadgeText,
                      step.ok === true && { color: '#047857' },
                      step.ok === false && { color: '#B91C1C' },
                    ]}>
                      {step.ok === true ? '✓' : step.ok === false ? '!' : idx + 1}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.settingTitle}>
                      {step.title}
                      {!step.required && <Text style={styles.settingDesc}>  · recommended</Text>}
                    </Text>
                    <Text style={styles.settingDesc}>{step.desc}</Text>
                  </View>
                  {step.ok !== true && (
                    <Pressable
                      style={({ pressed }: { pressed: boolean }) => [styles.stepBtn, pressed && { opacity: 0.7 }]}
                      onPress={step.action}
                    >
                      <Text style={styles.stepBtnText}>{step.cta}</Text>
                    </Pressable>
                  )}
                </View>
              ))}

              <Pressable style={styles.modalSaveBtn} onPress={handleSimulateCallEnd}>
                <Text style={styles.modalSaveText}>▶ Test it now</Text>
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

              <Pressable style={styles.modalCancelBtn} onPress={() => { setIsPopupSetupOpen(false); fetchSystemData(); }}>
                <Text style={styles.modalCancelText}>Done</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Configure SIM Nicknames Modal */}
      <Modal visible={isSimModalOpen} transparent animationType="fade">
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
      <Modal visible={isAdminModalOpen} transparent animationType="slide">
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