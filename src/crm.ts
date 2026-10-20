import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { panelAsk } from './api';

/*
 * The sales side of a contact, kept in the panel (crm.php) so the whole team sees it: deal stage,
 * BANT qualification, buyer sentiment and the heat score worked out from them, why a lead was
 * lost, an offer hold timer, WhatsApp replies and DND. Plus the timeline, voice notes, points and
 * analytics. The phone's own pieces (file picker, speech to text, voice recorder, downloads) are
 * in CrmBridgeModule.kt.
 */

const { CrmBridge } = NativeModules;

export type Stage = 'new' | 'contacted' | 'interested' | 'qualified' | 'converted' | 'lost';
export type Sentiment = '' | 'hot' | 'price' | 'comparing' | 'cold';
export type LostReason = '' | 'price' | 'timing' | 'competitor' | 'unreachable' | 'other';

export const STAGES: { key: Stage; label: string; color: 'muted' | 'blue' | 'violet' | 'orange' | 'success' | 'danger' }[] = [
  { key: 'new', label: 'New', color: 'muted' },
  { key: 'contacted', label: 'Contacted', color: 'blue' },
  { key: 'interested', label: 'Interested', color: 'violet' },
  { key: 'qualified', label: 'Qualified', color: 'orange' },
  { key: 'converted', label: 'Converted', color: 'success' },
  { key: 'lost', label: 'Not interested', color: 'danger' },
];
export const SENTIMENTS: { key: Exclude<Sentiment, ''>; label: string }[] = [
  { key: 'hot', label: '🔥 Hot lead' },
  { key: 'price', label: '🤔 Price sensitive' },
  { key: 'comparing', label: '⏳ Comparing' },
  { key: 'cold', label: '❄️ Cold' },
];
export const LOST_REASONS: { key: Exclude<LostReason, ''>; label: string }[] = [
  { key: 'price', label: 'Price' },
  { key: 'timing', label: 'Timing' },
  { key: 'competitor', label: 'Competitor' },
  { key: 'unreachable', label: 'Unreachable' },
  { key: 'other', label: 'Other' },
];
export const BANT: { bit: number; key: string; label: string }[] = [
  { bit: 1, key: 'B', label: 'Budget' },
  { bit: 2, key: 'A', label: 'Authority' },
  { bit: 4, key: 'N', label: 'Need' },
  { bit: 8, key: 'T', label: 'Timeline' },
];
export const bantPct = (bant: number) => BANT.reduce((a, b) => a + (bant & b.bit ? 25 : 0), 0);
/** Same formula as crm_heat() in crm_lib.php: three fifths qualification, the rest sentiment. */
export const heatScore = (bant: number, sentiment: Sentiment) => {
  const s = ({ hot: 40, comparing: 20, price: 15, cold: 0, '': 10 } as { [k: string]: number })[sentiment] ?? 10;
  return Math.max(0, Math.min(100, Math.round(bantPct(bant) * 0.6 + s)));
};

export interface Meta {
  number_norm?: string;
  stage: Stage | '';
  sentiment: Sentiment;
  bant: number;
  heat: number;
  lost_reason: LostReason;
  competitor?: string;
  offer_until: string | null;
  dnd: number;
  replied_at: string | null;
  reply_text: string;
  reply_ack_at?: string | null;
  activity_at?: string | null;
}
export const EMPTY_META: Meta = { stage: '', sentiment: '', bant: 0, heat: 0, lost_reason: '', offer_until: null, dnd: 0, replied_at: null, reply_text: '' };

export interface Award { rule: string; points: number }
export interface TimelineItem { kind: string; text: string; at: string; by: string; id?: number; duration_ms?: number; opt_out?: number }

export interface Stats {
  today: number;
  week: number;
  total: number;
  by_rule: { [rule: string]: { n: number; points: number } };
  rank: { name: string; from: number; next: string; next_at: number };
  goal: number;
  rules: { [rule: string]: number };
  cleared_today: number;
}

export interface Reply { number: string; at: string; text: string; dnd: number; heat: number; name: string; segment: string }

export const RULE_LABEL: { [k: string]: string } = {
  attempt: 'Callbacks attempted', connected: 'Connected & logged', ontime: 'On-time callbacks',
  hot: 'Hot leads qualified', converted: 'Sales closed', referral: 'Referrals added', reply: 'WhatsApp replies',
  offer: 'Offers sent on calls',
};

/* Team settings (crm.php settings_get / settings_set): the plans the offer calculator prices, and
   the battle matrix shown when a lead mentions a competitor. */
export interface Plan { name: string; price: number; note?: string }
export interface Battle {
  criteria: string[];
  us: string[];
  competitors: { name: string; values: string[] }[];
}
export interface Agent { device_id: string; name: string; team?: string }
export const RANK_ICON: { [k: string]: string } = { Rookie: '🌱', Closer: '🎯', 'Callback Ninja': '🥷', Grandmaster: '👑' };

let endpoint = '';
/** The sync endpoint the panel lives at; App sets it once it has loaded. */
export const setCrmEndpoint = (e: string) => { endpoint = e; };
const ask = (body: any, timeoutMs = 20000) => panelAsk('crm.php', body, endpoint, timeoutMs);

export const crm = {
  meta: (numbers: string[]) => ask({ action: 'meta', numbers }).then((d) => (d.meta || {}) as { [n: string]: Meta }),
  metaSet: (number: string, patch: Partial<{ stage: Stage; sentiment: Sentiment; bant: number; lost_reason: LostReason; competitor: string; offer_hours: number; offer_clear: boolean; dnd: boolean; reply_ack: boolean }>) =>
    ask({ action: 'meta_set', number, ...patch }).then((d) => ({ meta: d.meta as Meta, awarded: (d.awarded || []) as Award[] })),
  timeline: (number: string) => ask({ action: 'timeline', number }).then((d) => ({ items: (d.items || []) as TimelineItem[], meta: d.meta as Meta | null })),
  noteAdd: (number: string, text: string, kind: 'note' | 'dictation' = 'note') => ask({ action: 'note_add', number, text, kind }),
  memoUpload: (number: string, b64: string, mime: string, durationMs: number) => ask({ action: 'memo_upload', number, b64, mime, duration_ms: Math.round(durationMs) }, 60000),
  memoGet: (id: number) => ask({ action: 'memo_get', id }, 60000) as Promise<{ b64: string; mime: string }>,
  pointsAdd: (rule: 'attempt' | 'connected' | 'ontime' | 'offer', ref: string, number?: string) =>
    ask({ action: 'points_add', rule, ref, number }).then((d) => Number(d.points) || 0),
  stats: () => ask({ action: 'stats' }) as Promise<Stats>,
  leaderboard: (range: 'today' | 'week' | 'month') => ask({ action: 'leaderboard', range }),
  analytics: (range: 'today' | 'week' | 'month', scope: 'me' | 'team') => ask({ action: 'analytics', range, scope }, 30000),
  rulesSet: (rules: { [k: string]: number }, goal: number) => ask({ action: 'rules_set', rules, goal }),
  waInbound: (items: { id: string; phone: string; text: string; at: number }[]) => ask({ action: 'wa_inbound', items }),
  feed: () => ask({ action: 'feed' }).then((d) => (d.replies || []) as Reply[]),
  settingsGet: (keys: ('plans' | 'battle' | 'wa_templates')[]) => ask({ action: 'settings_get', keys }).then((d) => (d.settings || {}) as { plans?: Plan[]; battle?: Battle }),
  settingsSet: (key: 'plans' | 'battle' | 'wa_templates', value: any) => ask({ action: 'settings_set', key, value }),
  /** The team's phones, to share leads out to (imports.php). */
  agents: () => panelAsk('imports.php', { action: 'agents' }, endpoint).then((d) => (d.agents || []) as Agent[]),
  /** Round robin: the people shared out equally between `agents` (row_ids, or everyone a filter shows). */
  assign: (importId: number, agents: string[], target: { row_ids: number[] } | { all: true; show?: string; q?: string; max?: number }, clear = false) =>
    panelAsk('imports.php', { action: 'assign', id: importId, agents, clear, ...target }, endpoint, 60000) as Promise<{ assigned: number; per_agent: { [d: string]: number } }>,
  referral: (from: string, importId: number, name: string, phone: string) =>
    ask({ action: 'referral', from, import_id: importId, name, phone }).then((d) => ({ rowId: Number(d.row_id), awarded: (d.awarded || []) as Award[] })),
};

/* ── phone features ── */

export const native = {
  available: !!CrmBridge,
  pickTextFile: (): Promise<{ name: string; text: string; bytes: number } | null> => CrmBridge.pickTextFile(),
  /** A PDF, image or audio file to attach to WhatsApp (≤ 16 MB). */
  pickMediaFile: (): Promise<{ name: string; mime: string; bytes: number; b64: string } | null> => CrmBridge.pickMediaFile(),
  recognizeSpeech: (lang: string, prompt: string): Promise<string> => CrmBridge.recognizeSpeech(lang, prompt),
  startMemo: async (): Promise<void> => {
    if (Platform.OS === 'android') {
      const ok = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
        title: 'Record a voice note',
        message: 'Caller IQ records a voice note only while you hold the record button on a contact.',
        buttonPositive: 'Allow',
      });
      if (ok !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow the microphone to record voice notes');
    }
    await CrmBridge.startMemo();
  },
  stopMemo: (): Promise<{ b64: string; mime: string; durationMs: number }> => CrmBridge.stopMemo(),
  cancelMemo: (): Promise<void> => CrmBridge.cancelMemo(),
  playAudio: (b64: string): Promise<number> => CrmBridge.playAudio(b64),
  stopAudio: (): Promise<void> => CrmBridge.stopAudio(),
  saveDownload: (name: string, mime: string, content: string): Promise<string> => CrmBridge.saveDownload(name, mime, content),
  events: CrmBridge ? new NativeEventEmitter(CrmBridge) : null,
};

/* ── numbers ── */

/**
 * The number scrubber: spaces, dashes, brackets and dots out; a leading 0 or +91 / 91 dropped, so
 * an Indian mobile comes out as its 10 digits. `ok` is false for anything else — "Needs review".
 */
export const scrubPhone = (raw: string): { digits: string; ok: boolean; e164: string } => {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  else if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
  const ok = d.length === 10 && /^[6-9]/.test(d);
  return { digits: d, ok, e164: ok ? `91${d}` : d };
};

/** "2 PM – 3 PM" from an hour of the day. */
export const hourWindow = (h: number | null | undefined) => {
  if (h == null || h < 0 || h > 23) return '';
  const f = (x: number) => `${((x + 11) % 12) + 1} ${x % 24 < 12 ? 'AM' : 'PM'}`;
  return `${f(h)} – ${f((h + 1) % 24)}`;
};

/** "18m", "2h 5m", "3d" — how long a lead has been waiting. */
export const waited = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
};

/** A CSV row, quoted where needed. */
export const csvRow = (cells: (string | number | null | undefined)[]) => cells.map((c) => {
  const v = c == null ? '' : String(c);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}).join(',');
