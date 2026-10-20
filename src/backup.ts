import { NativeModules } from 'react-native';
import { native } from './crm';

const { CallBridge } = NativeModules;

/*
 * Workspace backup. The calling lists, callbacks, deals and points live in the panel, so nothing
 * there is lost with a phone. What lives only on this phone — templates, pitch links, the bridge
 * address, Google Sheet links, tagged outcomes and the last copy of the lists — is snapshotted
 * every 60 seconds (kept on the phone) and can be exported as a .json file to Downloads, then
 * restored on this or another phone.
 */

const KEYS = [
  'sms_templates_v1', 'wa_template_v1', 'wa_bridge_v1', 'sales_links_v1', 'sheet_links_v1',
  'counselor_name', 'call_outcomes_v1', 'theme_pref', 'imports_lists_v1',
];
const CACHE_SNAPSHOT = 'workspace_snapshot_v1';

export interface Snapshot { app: 'Caller IQ'; version: 1; at: number; data: { [key: string]: string } }

export const takeSnapshot = async (): Promise<Snapshot> => {
  const data: { [key: string]: string } = {};
  for (const k of KEYS) {
    try {
      const v = await CallBridge?.loadUiCache?.(k);
      if (v) data[k] = v;
    } catch (_) {}
  }
  return { app: 'Caller IQ', version: 1, at: Date.now(), data };
};

/** The 60-second autosave: only written when something changed. */
let lastJson = '';
export const autosave = async (): Promise<number> => {
  const snap = await takeSnapshot();
  const json = JSON.stringify(snap.data);
  if (json !== lastJson) {
    lastJson = json;
    CallBridge?.saveUiCache?.(CACHE_SNAPSHOT, JSON.stringify(snap));
  }
  return snap.at;
};

export const lastSnapshotAt = async (): Promise<number> => {
  try {
    const raw = await CallBridge?.loadUiCache?.(CACHE_SNAPSHOT);
    return raw ? Number(JSON.parse(raw).at) || 0 : 0;
  } catch (_) {
    return 0;
  }
};

export const exportBackup = async (extra?: any): Promise<string> => {
  const snap = await takeSnapshot();
  const body = JSON.stringify({ ...snap, extra: extra || null }, null, 2);
  return native.saveDownload(`calliq_backup_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, 'application/json', body);
};

/** Restores a backup picked from the phone; how many settings came back. */
export const importBackup = async (): Promise<number | null> => {
  const f = await native.pickTextFile();
  if (!f) return null;
  let snap: Snapshot;
  try {
    snap = JSON.parse(f.text);
  } catch (_) {
    throw new Error('That is not a Caller IQ backup file');
  }
  if (snap?.app !== 'Caller IQ' || !snap.data || typeof snap.data !== 'object') throw new Error('That is not a Caller IQ backup file');
  let n = 0;
  for (const [k, v] of Object.entries(snap.data)) {
    if (!KEYS.includes(k) || typeof v !== 'string') continue;
    await CallBridge?.saveUiCache?.(k, v);
    n++;
  }
  lastJson = '';
  return n;
};
