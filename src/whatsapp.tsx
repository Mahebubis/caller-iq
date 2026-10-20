import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, NativeModules, StyleProp, Text, TextStyle, ViewStyle } from 'react-native';
import { panelAsk, panelDevice } from './api';
import { crm, Reply } from './crm';
import { markMessaged } from './messaged';
import { defaultOf, DEFAULT_TEMPLATES, fillFor, loadTemplates, prepareTemplate, saveTemplates, WaTemplate } from './waTemplates';
import { useTheme } from './theme';
import { Icon, PulseDot, Tactile, useToast } from './ui';
import WhatsAppSheet from './sheets/WhatsAppSheet';
import CampaignSheet from './sheets/CampaignSheet';
import WaSendSheet from './sheets/WaSendSheet';
import TemplatesSheet from './sheets/TemplatesSheet';

const { CallBridge } = NativeModules;

/*
 * WhatsApp, through the bridge in whatsapp-bridge/ (a WhatsApp Web session on a computer the
 * phone can reach). One provider owns the connection for every screen: it remembers the bridge's
 * address and key, polls its status (quickly while a campaign runs or the QR is on screen, slowly
 * otherwise, never while the app is in the background), sends single messages, starts and steers
 * bulk campaigns, and logs every message that went out on the contact's row in the panel
 * (callbacks.php "sms_log", channel 'whatsapp') so "WhatsApp sent" shows for the whole team.
 *
 * With no bridge set up, or the bridge not connected, a single message falls back to opening
 * WhatsApp on this phone with the text ready to send.
 *
 * The bridge also reports events: replies from leads (forwarded to crm.php "wa_inbound", which
 * marks them "Replied - Priority", awards the points and flags opt-outs as DND) and reminders it
 * sent on schedule (logged like any other WhatsApp). Replies not yet acknowledged come back from
 * crm.php "feed" as alert cards for the Live Call Feed.
 */

export interface WaContact { id?: number; name?: string; phone: string; segment?: string }

export interface WaResult { id: number | null; phone: string; name: string; ok: boolean; error: string; at: number; text: string }

export interface WaCampaign {
  id: number;
  running: boolean;
  paused: boolean;
  cancelled: boolean;
  total: number;
  sent: number;
  failed: number;
  currentPhone: string | null;
  startedAt: number;
  finishedAt: number;
  nextAt: number;
  minDelaySec: number;
  maxDelaySec: number;
  batchSize?: number;
  cooldownSec?: number;
  cooling?: boolean;
  skippedDnd?: number;
  done: number;
  results: WaResult[];
  resultsFrom: number;
}

export interface WaStatus {
  connected: boolean;
  phase: 'starting' | 'qr' | 'authenticated' | 'ready' | 'disconnected' | 'error' | string;
  me: string;
  error: string;
  qrDataUrl: string | null;
  campaign: WaCampaign;
  events?: WaEvent[];
  evSeq?: number;
  drips?: WaDrip[];
}

/** Something the bridge saw: a reply ('in') or a scheduled message it sent ('sched'). */
export interface WaEvent {
  seq: number;
  type: 'in' | 'sched' | 'dial' | 'drip_stop';
  group?: string;
  step?: number;
  name?: string;
  segment?: string;
  at: number;
  id?: string;
  key?: string;
  phone: string;
  text: string;
  optOut?: boolean;
  ok?: boolean;
  error?: string;
  msgAt?: number;
}

/** A file picked on the phone, sent with the message as its caption (audio as a voice note if `voice`). */
export interface WaMedia { b64: string; mime: string; name: string; bytes?: number; voice?: boolean }
export interface SendOpts { mediaUrl?: string; how?: string; quiet?: boolean; media?: WaMedia | null }
export interface WaDrip { phone: string; left: number; nextAt: number }
export interface DialRequest { phone: string; name?: string; segment?: string; at: number }

export interface WaConfig { url: string; key: string }

interface WaApi {
  config: WaConfig;
  configured: boolean;
  status: WaStatus | null;
  /** Why the bridge could not be reached, when it could not. */
  bridgeError: string;
  saveConfig: (c: WaConfig) => Promise<void>;
  refresh: () => Promise<void>;
  /** Sends in the background when the bridge is connected, else opens WhatsApp on this phone. */
  sendOne: (c: WaContact, template?: string, opts?: SendOpts) => Promise<boolean>;
  startCampaign: (contacts: WaContact[], template: string, minDelaySec: number, maxDelaySec: number, spin: boolean, batchSize?: number, cooldownSec?: number, media?: WaMedia | null) => Promise<void>;
  control: (action: 'pause' | 'resume' | 'cancel') => Promise<void>;
  logout: () => Promise<void>;
  /** The default template's text (single sends use it). */
  template: string;
  /** The saved templates, shared by the team. */
  templates: WaTemplate[];
  setTemplates: (list: WaTemplate[]) => Promise<'team' | 'phone'>;
  /** The counselor's name, for {me}. */
  me: string;
  openStatus: () => void;
  openCampaign: (contacts: WaContact[]) => void;
  /** The templates manager. */
  openTemplates: () => void;
}

/** What rows on a list need: steady between status polls, so long lists don't redraw for them. */
interface WaSendApi {
  sendOne: WaApi['sendOne'];
  openCampaign: WaApi['openCampaign'];
  /** One WhatsApp to one person, choosing the template first. */
  openSend: (c: WaContact) => void;
  /** When this phone last sent the number a WhatsApp (before the panel has it), or 0. */
  sentAt: (phone: string) => number;
  /** A message the bridge sends at `at` (ms), even with this app closed; false without a bridge. */
  schedule: (key: string, c: WaContact, message: string, at: number) => Promise<boolean>;
  unschedule: (key: string) => void;
  /** Tells the bridge a number opted out (or back in), so bulk sends skip it. */
  setDnd: (phone: string, on: boolean) => void;
  /** Lead replies of the last day nobody has acknowledged yet. */
  replies: Reply[];
  ackReply: (number: string) => void;
  /** Goes up whenever replies were stored in the panel, so screens can re-read. */
  replyTick: number;
  /** Numbers with a follow-up drip still running (from the bridge), by their last 10 digits. */
  drips: { [last10: string]: WaDrip };
  /** Enrols people in the 3-step drip; false without a bridge. */
  startDrip: (contacts: WaContact[], steps: { afterMin: number; message: string }[]) => Promise<{ enrolled: number; blocked: number } | null>;
  stopDrip: (phone: string, why?: string) => void;
  /** A number pushed from the laptop dialer, waiting for one tap. */
  dialRequest: DialRequest | null;
  clearDial: () => void;
}

const CACHE_CONFIG = 'wa_bridge_v1';
const CACHE_LOGGED = 'wa_logged_v1';
const CACHE_EVENTS = 'wa_events_v1';
const POLL_IDLE_MS = 20 * 1000;
const POLL_FAST_MS = 2500;

const Ctx = createContext<WaApi | null>(null);
const SendCtx = createContext<WaSendApi | null>(null);
export const useWhatsApp = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWhatsApp outside WhatsAppProvider');
  return v;
};
export const useWaSend = () => {
  const v = useContext(SendCtx);
  if (!v) throw new Error('useWaSend outside WhatsAppProvider');
  return v;
};

/**
 * "192.168.1.5:3001", "192.168.1.5" or a pasted ".../api/whatsapp/status" → "http://192.168.1.5:3001".
 * A plain http address with no port gets the bridge's own 3001 (the address left without it timed out).
 */
export const BRIDGE_PORT = 3001;
export const normalizeBridgeUrl = (raw: string) => {
  let u = (raw || '').trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  u = u.replace(/\/api\/whatsapp(\/.*)?$/i, '');
  const m = u.match(/^(http:\/\/)([^/:]+)(\/.*)?$/i);
  if (m) u = `${m[1]}${m[2]}:${BRIDGE_PORT}${m[3] || ''}`;
  return u;
};

const firstName = (name?: string) => (name || '').trim().split(/\s+/)[0] || 'there';
/** The same placeholders the bridge fills in ({name} / [Name], {fullname}, {segment}, {phone}, {me}). */
export const fillWa = (text: string, c: WaContact, me = '') => fillFor(text, c, me);

/** Country code in front of a 10-digit Indian number, for wa.me links. */
const waDigits = (phone: string) => {
  let d = (phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? `91${d}` : d;
};
const last10 = (n: string) => (n || '').replace(/\D/g, '').slice(-10);

export function WhatsAppProvider({ syncEndpoint, addLog, me = '', children }: {
  syncEndpoint: string;
  addLog: (msg: string) => void;
  /** Who is sending, for {me}. */
  me?: string;
  children: React.ReactNode;
}) {
  const toast = useToast();
  const [config, setConfig] = useState<WaConfig>({ url: '', key: '' });
  const [status, setStatus] = useState<WaStatus | null>(null);
  const [bridgeError, setBridgeError] = useState<string>('');
  const [templates, setTemplatesState] = useState<WaTemplate[]>(DEFAULT_TEMPLATES);
  const template = defaultOf(templates).text;
  // Numbers (last 10 digits) this phone sent a WhatsApp, and when — shown until the panel has it.
  const [sent, setSent] = useState<{ [k: string]: number }>({});
  const markSent = useCallback((phones: string[]) => {
    markMessaged(phones);
    const at = Date.now();
    setSent((cur) => {
      const next = { ...cur };
      phones.forEach((p) => { const k = last10(p); if (k) next[k] = at; });
      return next;
    });
  }, []);
  const [statusOpen, setStatusOpen] = useState<boolean>(false);
  const [campaignFor, setCampaignFor] = useState<WaContact[] | null>(null);
  const [sendFor, setSendFor] = useState<WaContact | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState<boolean>(false);
  const [foreground, setForeground] = useState<boolean>(AppState.currentState === 'active');
  const [replies, setReplies] = useState<Reply[]>([]);
  const [replyTick, setReplyTick] = useState<number>(0);
  const [dialRequest, setDialRequest] = useState<DialRequest | null>(null);
  // The last bridge event this phone handled.
  const evSeq = useRef<number>(-1);
  const handling = useRef<boolean>(false);

  // What of the current campaign is already in the panel: { key: "<id>@<startedAt>", n }.
  const logged = useRef<{ key: string; n: number }>({ key: '', n: 0 });
  const logging = useRef<boolean>(false);
  const live = useRef<any>({});
  live.current = { config, syncEndpoint, template, me, connected: !!status?.connected };

  useEffect(() => {
    (async () => {
      try {
        const raw = await CallBridge?.loadUiCache?.(CACHE_CONFIG);
        if (raw) {
          const saved = JSON.parse(raw);
          setConfig({ ...saved, url: normalizeBridgeUrl(saved.url || '') });
        }
        loadTemplates().then(setTemplatesState).catch(() => {});
        const lg = await CallBridge?.loadUiCache?.(CACHE_LOGGED);
        if (lg) logged.current = JSON.parse(lg);
        const ev = await CallBridge?.loadUiCache?.(CACHE_EVENTS);
        evSeq.current = ev ? Number(ev) || 0 : -1;
      } catch (_) {}
    })();
    const sub = AppState.addEventListener('change', (st) => setForeground(st === 'active'));
    return () => sub.remove();
  }, []);

  const configured = !!config.url;

  const bridge = useCallback(async (path: string, body?: any, timeoutMs = 15000) => {
    const { url, key } = live.current.config as WaConfig;
    if (!url) throw new Error('Set up the WhatsApp bridge first');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${url}/api/whatsapp${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(key ? { 'X-Bridge-Key': key } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError'
        ? `No answer from ${url}. Check the computer is on the same Wi-Fi, the bridge is running, and the address ends in :${BRIDGE_PORT}.`
        : `Can't reach the WhatsApp bridge at ${url} — is it running on that computer?`);
    } finally {
      clearTimeout(timer);
    }
    let json: any = null;
    try { json = await res.json(); } catch (_) {}
    if (res.status === 401) throw new Error('The bridge key is wrong — check it in WhatsApp settings');
    if (!res.ok || !json) throw new Error(json?.error || `The WhatsApp bridge answered HTTP ${res.status}`);
    return json;
  }, []);

  /* Sends of the campaign this phone started that are not in the panel yet. Another phone's
     campaign on the same bridge is that phone's to log. */
  const logResults = useCallback(async (c: WaCampaign) => {
    const key = `${c.id}@${c.startedAt}`;
    if (logging.current || !c.id || logged.current.key !== key) return;
    const fresh = c.results.slice(Math.max(0, logged.current.n - c.resultsFrom));
    if (!fresh.length) return;
    logging.current = true;
    try {
      const ok = fresh.filter((r) => r.ok);
      for (let i = 0; i < ok.length; i += 500) {
        await panelAsk('callbacks.php', {
          action: 'sms_log', channel: 'whatsapp', template: 'WhatsApp campaign',
          items: ok.slice(i, i + 500).map((r) => ({ number: r.phone, body: r.text })),
        }, live.current.syncEndpoint);
      }
      logged.current = { key, n: c.resultsFrom + c.results.length };
      CallBridge?.saveUiCache?.(CACHE_LOGGED, JSON.stringify(logged.current));
      if (ok.length) markSent(ok.map((r) => r.phone));
    } catch (e: any) {
      addLog(`WhatsApp campaign: not logged in the panel yet — ${e?.message || e}`);
    } finally {
      logging.current = false;
    }
  }, [addLog, markSent]);

  const loadReplies = useCallback(() => {
    crm.feed().then(setReplies).catch(() => {});
  }, []);

  /* Replies go to the panel (once each — the panel ignores a message id it has); a reminder sent
     on schedule is logged by the phone that set it. */
  const handleEvents = useCallback(async (events: WaEvent[], seq: number) => {
    if (handling.current) return;
    // First contact with this bridge: start from now rather than replaying its whole history.
    if (evSeq.current < 0) {
      evSeq.current = seq;
      CallBridge?.saveUiCache?.(CACHE_EVENTS, String(seq));
      return;
    }
    const fresh = events.filter((e) => e.seq > evSeq.current);
    if (!fresh.length) return;
    handling.current = true;
    try {
      const ins = fresh.filter((e) => e.type === 'in' && e.id);
      if (ins.length) {
        await crm.waInbound(ins.map((e) => ({ id: e.id!, phone: e.phone, text: e.text, at: e.msgAt || e.at })));
        const optOut = ins.filter((e) => e.optOut).length;
        toast(ins.length === 1 ? `💬 WhatsApp reply from ${ins[0].phone.slice(-10)}${optOut ? ' — opted out (DND)' : ''}` : `💬 ${ins.length} new WhatsApp replies`);
        CallBridge?.playAlert?.().catch(() => {});
        setReplyTick((n) => n + 1);
        loadReplies();
      }
      const mine = fresh.filter((e) => e.type === 'sched' && e.ok && (e.key || '').startsWith(`${panelDevice()}:`));
      for (const kind of ['drip', 'other']) {
        const part = mine.filter((e) => ((e.group || '').startsWith('drip:') ? 'drip' : 'other') === kind);
        if (!part.length) continue;
        await panelAsk('callbacks.php', {
          action: 'sms_log', channel: 'whatsapp', template: kind === 'drip' ? 'Drip follow-up' : 'Scheduled reminder',
          items: part.map((e) => ({ number: e.phone, body: e.text })),
        }, live.current.syncEndpoint);
        markSent(part.map((e) => e.phone));
      }
      // A number pushed from the laptop: one tap away on this phone.
      const dial = fresh.filter((e) => e.type === 'dial').pop();
      if (dial && Date.now() - dial.at < 10 * 60 * 1000) {
        setDialRequest({ phone: dial.phone, name: dial.name, segment: dial.segment, at: dial.at });
        CallBridge?.playAlert?.().catch(() => {});
      }
      const stopped = fresh.filter((e) => e.type === 'drip_stop');
      if (stopped.length) {
        stopped.forEach((e) => crm.noteAdd(e.phone, e.text).catch(() => {}));
        toast(stopped.length === 1 ? `Drip stopped for ${stopped[0].phone.slice(-10)} — they replied` : `${stopped.length} drips stopped — they replied`);
      }
      evSeq.current = Math.max(...fresh.map((e) => e.seq));
      CallBridge?.saveUiCache?.(CACHE_EVENTS, String(evSeq.current));
    } catch (e: any) {
      addLog(`WhatsApp replies: not stored in the panel yet — ${e?.message || e}`);
    } finally {
      handling.current = false;
    }
  }, [toast, addLog, markSent, loadReplies]);

  const refresh = useCallback(async () => {
    if (!live.current.config.url) return;
    try {
      const st: WaStatus = await bridge(`/status?since=${logged.current.n}&ev=${Math.max(0, evSeq.current)}`, undefined, 8000);
      setStatus(st);
      setBridgeError('');
      if (st.campaign) logResults(st.campaign);
      if (st.evSeq != null) handleEvents(st.events || [], st.evSeq);
    } catch (e: any) {
      setBridgeError(e?.message || String(e));
    }
  }, [bridge, logResults, handleEvents]);

  // Replies reach the panel from whichever phone sees them first; every phone shows them.
  useEffect(() => {
    if (!foreground) return undefined;
    loadReplies();
    const timer = setInterval(loadReplies, 60 * 1000);
    return () => clearInterval(timer);
  }, [foreground, loadReplies, syncEndpoint]);

  // Polling: fast while something is moving, slow otherwise, not at all in the background.
  const running = !!status?.campaign?.running;
  const waitingForScan = statusOpen && !status?.connected;
  useEffect(() => {
    if (!configured || !foreground) return undefined;
    refresh();
    const timer = setInterval(refresh, running || waitingForScan || !!campaignFor ? POLL_FAST_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [configured, foreground, running, waitingForScan, !!campaignFor, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  // A campaign that finished while the app was looking: say so once.
  const wasRunning = useRef<boolean>(false);
  useEffect(() => {
    const c = status?.campaign;
    if (wasRunning.current && c && !c.running && c.total > 0) {
      toast(c.cancelled ? `WhatsApp campaign cancelled · ${c.sent} sent` : `WhatsApp campaign done · ${c.sent} sent${c.failed ? `, ${c.failed} failed` : ''}`);
    }
    wasRunning.current = !!c?.running;
  }, [status?.campaign?.running]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveConfig = useCallback(async (c: WaConfig) => {
    const next = { url: normalizeBridgeUrl(c.url), key: c.key.trim() };
    setConfig(next);
    live.current.config = next;
    setStatus(null);
    setBridgeError('');
    CallBridge?.saveUiCache?.(CACHE_CONFIG, JSON.stringify(next));
    if (next.url) await refresh();
  }, [refresh]);

  const setTemplates = useCallback(async (list: WaTemplate[]) => {
    setTemplatesState(list);
    return saveTemplates(list);
  }, []);

  const logOne = useCallback(async (c: WaContact, body: string, how: string) => {
    try {
      await panelAsk('callbacks.php', { action: 'sms_log', channel: 'whatsapp', number: c.phone, template: how, body }, live.current.syncEndpoint);
    } catch (e: any) {
      toast(`WhatsApp sent, but not logged — ${e?.message || e}`, 'error');
    }
  }, [toast]);

  const sendOne = useCallback(async (c: WaContact, tpl?: string, opts?: SendOpts) => {
    let text = fillWa(tpl || live.current.template, c, live.current.me).trim();
    const who = c.name ? firstName(c.name) : c.phone;
    if (live.current.config.url && live.current.connected) {
      try {
        const m = opts?.media;
        await bridge('/send-single', {
          phone: c.phone, name: c.name, segment: c.segment, message: text, mediaUrl: opts?.mediaUrl || undefined,
          media: m ? { b64: m.b64, mime: m.mime, name: m.name, voice: !!m.voice } : undefined,
        }, m ? 120000 : 45000);
        if (!opts?.quiet) toast(`WhatsApp sent to ${who}`);
        addLog(`WhatsApp to ${c.phone} sent through the bridge.`);
        markSent([c.phone]);
        const logged = opts?.media ? `📎 ${opts.media.name}${text ? `\n${text}` : ''}` : opts?.mediaUrl && !text.includes(opts.mediaUrl) ? `${text}\n${opts.mediaUrl}` : text;
        await logOne(c, logged, opts?.how || 'WhatsApp');
        return true;
      } catch (e: any) {
        toast(`WhatsApp not sent — ${e?.message || e}`, 'error');
        return false;
      }
    }
    // No bridge on hand: WhatsApp on this phone, with the text ready (a file has to be attached there by hand).
    if (opts?.media) toast(`Bridge not connected — attach “${opts.media.name}” yourself in WhatsApp`, 'error');
    if (opts?.mediaUrl && !text.includes(opts.mediaUrl)) text = `${text}\n${opts.mediaUrl}`;
    try {
      await Linking.openURL(`whatsapp://send?phone=${waDigits(c.phone)}&text=${encodeURIComponent(text)}`);
    } catch (_) {
      try {
        await Linking.openURL(`https://wa.me/${waDigits(c.phone)}?text=${encodeURIComponent(text)}`);
      } catch (e: any) {
        toast('WhatsApp is not installed on this phone', 'error');
        return false;
      }
    }
    addLog(`WhatsApp to ${c.phone} opened on this phone${live.current.config.url ? ' (bridge not connected)' : ''}.`);
    markSent([c.phone]);
    await logOne(c, text, `${opts?.how || 'WhatsApp'} (phone)`);
    return true;
  }, [bridge, toast, addLog, logOne, markSent]);

  const startCampaign = useCallback(async (contacts: WaContact[], tpl: string, minDelaySec: number, maxDelaySec: number, spin: boolean, batchSize = 20, cooldownSec = 180, media: WaMedia | null = null) => {
    const res = await bridge('/send-bulk', {
      contacts: contacts.map((c) => ({ id: c.id, name: c.name || '', phone: c.phone, segment: c.segment || '' })),
      // [Name] → {name}, and {me} filled; the bridge fills each person's name, list and number.
      template: prepareTemplate(tpl, live.current.me), minDelaySec, maxDelaySec, spin, batchSize, cooldownSec,
      media: media ? { b64: media.b64, mime: media.mime, name: media.name, voice: !!media.voice } : undefined,
    }, 120000);
    if (res.campaign) {
      logged.current = { key: `${res.campaign.id}@${res.campaign.startedAt}`, n: 0 };
      CallBridge?.saveUiCache?.(CACHE_LOGGED, JSON.stringify(logged.current));
      setStatus((s) => (s ? { ...s, campaign: res.campaign } : s));
    }
    addLog(`WhatsApp campaign started: ${contacts.length} contacts${res.skipped ? `, ${res.skipped} skipped (no number or listed twice)` : ''}${res.blocked ? `, ${res.blocked} DND` : ''}.`);
    refresh();
  }, [bridge, addLog, refresh]);

  const control = useCallback(async (action: 'pause' | 'resume' | 'cancel') => {
    try {
      await bridge('/campaign-control', { action });
      refresh();
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  }, [bridge, refresh, toast]);

  const logout = useCallback(async () => {
    try {
      await bridge('/logout', {}, 20000);
      toast('WhatsApp unlinked — scan a new QR to connect again');
      refresh();
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  }, [bridge, refresh, toast]);

  const schedule = useCallback(async (key: string, c: WaContact, message: string, at: number) => {
    if (!live.current.config.url) return false;
    try {
      await bridge('/schedule', { key: `${panelDevice()}:${key}`, phone: c.phone, name: c.name, segment: c.segment, message, at });
      return true;
    } catch (_) {
      return false;
    }
  }, [bridge]);
  const unschedule = useCallback((key: string) => {
    if (live.current.config.url) bridge('/schedule-cancel', { key: `${panelDevice()}:${key}` }).catch(() => {});
  }, [bridge]);
  const setDnd = useCallback((phone: string, on: boolean) => {
    if (live.current.config.url) bridge('/dnd', { phone, dnd: on }).catch(() => {});
  }, [bridge]);
  const startDrip = useCallback(async (contacts: WaContact[], steps: { afterMin: number; message: string }[]) => {
    if (!live.current.config.url) return null;
    const res = await bridge('/drip', {
      key: `${panelDevice()}:drip${Date.now()}`,
      contacts: contacts.map((c) => ({ name: c.name || '', phone: c.phone, segment: c.segment || '' })),
      steps,
    }, 30000);
    contacts.forEach((c) => crm.noteAdd(c.phone, `Drip follow-up started (${steps.length} steps)`).catch(() => {}));
    refresh();
    return { enrolled: Number(res.enrolled) || 0, blocked: Number(res.blocked) || 0 };
  }, [bridge, refresh]);
  const stopDrip = useCallback((phone: string, why = 'stopped') => {
    if (!live.current.config.url) return;
    bridge('/schedule-cancel', { phone }).then((r: any) => {
      if (r?.removed) crm.noteAdd(phone, `Drip follow-up ${why} (${r.removed} left unsent)`).catch(() => {});
      refresh();
    }).catch(() => {});
  }, [bridge, refresh]);
  const clearDial = useCallback(() => setDialRequest(null), []);
  const drips = useMemo(() => Object.fromEntries((status?.drips || []).map((d) => [last10(d.phone), d])), [status?.drips]);

  const ackReply = useCallback((number: string) => {
    setReplies((r) => r.filter((x) => last10(x.number) !== last10(number)));
    crm.metaSet(number, { reply_ack: true }).catch(() => {});
  }, []);

  const openStatus = useCallback(() => setStatusOpen(true), []);
  const openCampaign = useCallback((contacts: WaContact[]) => setCampaignFor(contacts), []);
  const openSend = useCallback((c: WaContact) => setSendFor(c), []);
  const openTemplates = useCallback(() => setTemplatesOpen(true), []);

  const api = useMemo<WaApi>(() => ({
    config, configured, status, bridgeError, saveConfig, refresh, sendOne, startCampaign, control, logout,
    template, templates, setTemplates, me, openStatus, openCampaign, openTemplates,
  }), [config, configured, status, bridgeError, saveConfig, refresh, sendOne, startCampaign, control, logout,
    template, templates, setTemplates, me, openStatus, openCampaign, openTemplates]);
  const sendApi = useMemo<WaSendApi>(() => ({
    sendOne, openCampaign, openSend, sentAt: (phone: string) => sent[last10(phone)] || 0,
    schedule, unschedule, setDnd, replies, ackReply, replyTick, drips, startDrip, stopDrip, dialRequest, clearDial,
  }), [sendOne, openCampaign, openSend, sent, schedule, unschedule, setDnd, replies, ackReply, replyTick, drips, startDrip, stopDrip, dialRequest, clearDial]);

  return (
    <Ctx.Provider value={api}>
    <SendCtx.Provider value={sendApi}>
      {children}
      <WhatsAppSheet visible={statusOpen} onClose={() => setStatusOpen(false)} />
      <CampaignSheet
        contacts={campaignFor}
        onClose={() => setCampaignFor(null)}
        onSetup={() => { setCampaignFor(null); setStatusOpen(true); }}
      />
      <WaSendSheet contact={sendFor} onClose={() => setSendFor(null)} onManage={() => { setSendFor(null); setTemplatesOpen(true); }} />
      <TemplatesSheet visible={templatesOpen} onClose={() => setTemplatesOpen(false)} />
    </SendCtx.Provider>
    </Ctx.Provider>
  );
}

/** The top bar's WhatsApp pill: connected, waiting for a scan, or a running campaign's progress. */
export function WhatsAppBadge({ style, textStyle, compact }: { style: StyleProp<ViewStyle>; textStyle: StyleProp<TextStyle>; compact?: boolean }) {
  const t = useTheme();
  const wa = useWhatsApp();
  const st = wa.status;
  const c = st?.campaign;
  const look = !wa.configured
    ? { label: 'WhatsApp', fg: t.c.muted, bg: t.c.surfaceAlt, icon: 'chat' as const, live: false }
    : c?.running
      ? { label: `${c.done}/${c.total}`, fg: t.c.success, bg: t.c.successSoft, icon: 'campaign' as const, live: !c.paused }
      : st?.connected
        ? { label: 'Live', fg: t.c.success, bg: t.c.successSoft, icon: 'chat' as const, live: false }
        : wa.bridgeError
          ? { label: 'Offline', fg: t.c.danger, bg: t.c.dangerSoft, icon: 'link_off' as const, live: false }
          : { label: 'Scan QR', fg: t.c.warning, bg: t.c.warningSoft, icon: 'qr_code' as const, live: false };
  return (
    <Tactile
      onPress={c?.running ? () => wa.openCampaign([]) : wa.openStatus}
      scaleTo={0.92}
      unstable_pressDelay={0}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={`WhatsApp bot: ${c?.running ? `campaign ${c.done} of ${c.total}` : look.label}`}
      style={[style, { backgroundColor: look.bg }]}
    >
      {look.live ? <PulseDot color={t.c.emerald} size={7} /> : <Icon name={look.icon} size={15} color={look.fg} />}
      {/* Compact (a crowded header): the label only while a campaign runs. */}
      {(!compact || !!c?.running) && <Text style={[textStyle, { color: look.fg }]}>{look.label}</Text>}
    </Tactile>
  );
}
