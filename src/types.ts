/* Shapes that cross the native bridge (CallBridgeModule.kt) and are shared between screens. */

export interface CallLogItem {
  number: string;
  callType: 'INCOMING' | 'OUTGOING' | 'MISSED' | 'REJECTED' | string;
  duration: number;      // seconds
  timestamp: number;     // ms
  simId: string;
  simSlot?: number;      // 1 or 2; 0 when the SIM could not be identified
  simCarrier?: string;
  simSource?: string;    // how the SIM was worked out — see SimResolver.kt
  rawSimId?: string;     // the phone account id the call log actually stored
  idempotencyKey: string;
  outcome?: string;      // disposition tag
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

export interface SimNicknameMap {
  [key: string]: string;
}

export interface BuildInfo {
  note: string;
  versionName: string;
  versionCode: number;
  installedAt: number;
}

/** Plain-English explanation of how a call's SIM was identified. */
export const SIM_SOURCE_TEXT: { [key: string]: string } = {
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

/** Callback attempts per contact before it is flagged and the auto-dialer passes over it. */
export const MAX_ATTEMPTS = 3;

/** A contact someone is setting a callback time for, from any screen. */
export interface ScheduleTarget {
  number: string;
  name?: string;
  segment?: string;
  dueAt?: number;     // the time already set, if any
  note?: string;
}

/** A contact a counselor is texting after an unanswered call. */
export interface SmsTarget {
  number: string;
  name?: string;
  segment?: string;
}
