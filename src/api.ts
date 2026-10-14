import { NativeModules } from 'react-native';

const { CallBridge } = NativeModules;

/*
 * Reading from the panel's api/caller-iq/ folder (imports.php, callbacks.php…).
 *
 * The phone cannot log in, so it identifies itself with the shared app key plus its device id
 * (CALLER_IQ_APP_KEY in ciq_lib.php); the panel checks the key and allows the app only its own
 * few actions. The folder follows the sync endpoint, so pointing the app at another server moves
 * these with it.
 */

export type PanelErrorKind = 'offline' | 'timeout' | 'missing' | 'outdated' | 'denied' | 'server' | 'setup';

/** An error worth showing as it is, plus what kind it is so a screen can pick the right icon. */
export class PanelError extends Error {
  kind: PanelErrorKind;
  constructor(message: string, kind: PanelErrorKind) {
    super(message);
    this.kind = kind;
  }
}

export const errorKind = (e: any): PanelErrorKind => (e instanceof PanelError ? e.kind : 'server');

let conn: { dir: string; deviceId: string; appKey: string; from: string } | null = null;

const getConn = async (syncEndpoint: string) => {
  if (conn && conn.from === syncEndpoint) return conn;
  let url = (syncEndpoint || '').replace('log_call.php', 'imports.php');
  let deviceId = '';
  let appKey = '';
  try {
    const st = await CallBridge?.getSetupState?.();
    if (st) {
      deviceId = st.deviceId || '';
      appKey = st.appKey || '';
      if (st.importsUrl) url = st.importsUrl;
    }
  } catch (_) {}
  if (!deviceId) throw new PanelError('This phone has no device id yet — open Phone setup once, then try again.', 'setup');
  conn = { dir: url.replace(/[^/]*$/, ''), deviceId, appKey, from: syncEndpoint };
  return conn;
};

/** This phone's device id, once any panel request has run. */
export const panelDevice = () => conn?.deviceId || '';

export const panelAsk = async (file: string, body: any, syncEndpoint: string, timeoutMs = 25000): Promise<any> => {
  const c = await getConn(syncEndpoint);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(c.dir + file, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CallIQ-App-Key': c.appKey },
      body: JSON.stringify({ ...body, device_id: c.deviceId, app_key: c.appKey }),
      signal: ctl.signal,
    });
  } catch (e: any) {
    throw e?.name === 'AbortError'
      ? new PanelError('The panel took too long to answer. Check the connection and try again.', 'timeout')
      : new PanelError('No internet connection — showing the last saved copy.', 'offline');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch (_) {}
  // The panel's router answers a missing file with "Endpoint not found"; a 404 from the file itself
  // (a list that was deleted, say) carries its own message and falls through below.
  if (res.status === 404 && (!json || /endpoint not found/i.test(String(json.message || '')))) throw new PanelError(`${file} is not on the server yet — the admin needs to upload it to api/caller-iq/.`, 'missing');
  if (res.status === 401) {
    // The phone always sends the app key, so "log in first" means the server still runs a copy of
    // this file from before phones were allowed to read it.
    throw new PanelError(`The server's ${file} is an older version that only admins can open. Ask the admin to upload the latest ${file} (and ciq_lib.php) to api/caller-iq/.`, 'outdated');
  }
  if (res.status === 403) {
    throw new PanelError(json?.message || 'The panel did not accept this phone. Ask the admin to check the app key.', 'denied');
  }
  if (!res.ok || !json) throw new PanelError(json?.message || `The panel answered HTTP ${res.status}.`, 'server');
  if (!json.success) throw new PanelError(json.message || 'The panel refused the request.', 'server');
  return json.data || {};
};
