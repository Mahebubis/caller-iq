import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, NativeModules, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { elevation, makeStyles, radius, space, type, useTheme } from './theme';
import { Avatar } from './art';
import { LIST_TONES } from './sheets/QuickCallSheet';
import { errorKind, panelAsk, panelDevice } from './api';
import { ago, callbackTime, dateOnly, dueIn, num, plural, prettyPhone, serverTime, talk } from './format';
import { MAX_ATTEMPTS, ScheduleTarget, SmsTarget } from './types';
import { useWaSend, WaContact } from './whatsapp';
import { Agent, crm, csvRow, EMPTY_META, hourWindow, Meta, native, Stage, STAGES, waited } from './crm';
import { DRIP, DRIP_STEPS, fillSales, OFFER, TEMPLATES } from './sales';
import { loadLinks, saveLinks, SheetLink, SYNC_EVERY_MS, syncLink } from './sheetSync';
import { usePoints, useUndo } from './engage';
import ImportSheet from './sheets/ImportSheet';
import type { FocusTarget } from './sheets/FocusSheet';
import {
  Appear, AttemptBadge, Banner, Button, Chip, ChipBar, EmptyState, Field, Icon, IconButton, IconName, IndexBadge, MetricTile, Pill,
  ProgressBar, PulseDot, SearchField, SettingRow, Sheet, Skeleton, SkeletonCard, Tactile, useToast,
} from './ui';

const { CallBridge } = NativeModules;

/*
 * Calling lists ("Imports") uploaded in the admin panel, read through the panel's own
 * api/caller-iq/imports.php — `list` for every upload, `detail` for one upload's people (paged,
 * filtered and searched on the server), `annotate` for a counselor's note on one person.
 *
 * The lists are read from the panel once, at launch, and then kept in memory (and on the phone,
 * through CallBridge.saveUiCache, so the next launch starts from them). After that the panel is
 * asked again only when the counselor asks: pull-to-refresh, the refresh button, or Retry — plus
 * one quiet re-read when they come back from dialling someone on a list, so that person's status
 * catches up. Opening a list, switching tabs or coming back to the app never refetches by itself.
 *
 * A refresh that brings nothing new changes nothing on screen: unchanged lists and people keep
 * their exact objects (see keepSame), so memoized cards don't even re-render, let alone flicker.
 * Searching and filtering the lists happens in memory. Only one request per kind is in flight.
 */

export interface ImportList {
  id: number;
  name: string;
  file_name: string;
  total_rows: number;
  stored_rows: number;
  with_phone: number;
  status: string;
  created_at: string;
  finished_at: string | null;
  changed_at: string | null;
  created_by_name: string;
  called: number;
  reached: number;
  connected: number;
  never: number;
  purchased: number;
  /* Live status buckets — sent by the updated panel; older panels leave them out. */
  to_call?: number;
  needs_callback?: number;
  scheduled?: number;
  done?: number;
  default_status?: string;
}

export interface ImportRow {
  id: number;
  row_no: number;
  phone_norm: string;
  phone_raw: string;
  email: string;
  name: string;
  called_by: string;
  comment: string | null;
  tags: string[];
  total: number | null;
  connected: number | null;
  talk_sec: number | null;
  last_at: string | null;
  last_outcome?: string | null;
  last_notes?: string | null;
  bought: number;
  bought_item?: string | null;
  /** The live status worked out by the panel, and the one the row was imported with. */
  status?: string;
  import_status?: string;
  /** Our outgoing calls since the list was uploaded, and the open callback time, if any. */
  attempts?: number | null;
  callback_at?: string | null;
  /** Quick SMS sent to this number from the app. */
  sms_count?: number | null;
  sms_at?: string | null;
  /** WhatsApp messages sent to this number, from the app or a campaign. */
  wa_count?: number | null;
  wa_at?: string | null;
  /** VIP kept above #1; when the lead first called us (file's time column) and its hour; missed calls merged in. */
  pinned?: number;
  lead_at?: string | null;
  best_hour?: number | null;
  inbound_missed?: number;
  /** The phone (device id) this person was shared out to; '' = anyone. */
  assigned_to?: string;
  /** Deal fields (crm.php): stage, sentiment, BANT, heat, lost reason, offer hold, DND, WhatsApp reply. */
  stage?: Stage | '' | null;
  sentiment?: string | null;
  bant?: number | null;
  heat?: number | null;
  lost_reason?: string | null;
  offer_until?: string | null;
  dnd?: number | null;
  replied_at?: string | null;
  reply_text?: string | null;
  reply_ack_at?: string | null;
  activity_at?: string | null;
}

export type Show = 'all' | 'called' | 'connected' | 'not_connected' | 'never' | 'purchased'
  | 'to_call' | 'needs_callback' | 'scheduled' | 'done' | 'maxed' | 'wa_sent'
  | 'replied' | 'converted' | 'ghosting' | 'review' | 'dnd';

interface Summary {
  rows_total: number;
  called: number;
  connected: number;
  not_connected: number;
  never: number;
  purchased: number;
  no_phone: number;
  to_call?: number;
  needs_callback?: number;
  scheduled?: number;
  done?: number;
  maxed?: number;
  wa_sent?: number;
  wa_replied?: number;
  converted?: number;
  review?: number;
  ghosting?: number;
  dnd?: number;
}

/** People on a list still to be called — the panel's live count, or "never called" from an older panel. */
export const toCall = (l: ImportList) => l.to_call ?? l.never ?? 0;

interface Detail {
  key: string;
  rows: ImportRow[];
  total: number;
  summary: Summary | null;
  calls: { calls: number; talk_sec: number } | null;
  at: number;
}

export interface ImportsHandle {
  /** Closes whatever the Lists tab has open; false when there was nothing to close. */
  handleBack: () => boolean;
  /** Opens one list straight away — used by the shortcut on the Calls tab. */
  openListById: (id: number, startShow?: Show, powerDial?: boolean) => void;
  /** Re-reads every list quietly — the Calls tab's pull-to-refresh asks for this. */
  refresh: () => void;
  /** Re-reads what is on screen — after a callback time was set or cleared. */
  refreshOpen: () => void;
  /** From the Focus workspace: fix a name / number / status, pin, or show new deal fields. */
  editRow: (t: FocusTarget, patch: { name?: string; phone?: string; status?: string }) => Promise<void>;
  pinRow: (t: FocusTarget, pinned: boolean) => Promise<void>;
  patchMeta: (number: string, meta: Meta) => void;
  /** The people on screen, for the search palette (with their #). */
  visibleRows: () => { target: FocusTarget; status: string }[];
  /** Keyboard N: the power dialer skips on; otherwise the next person after `number` opens. */
  next: (afterNumber?: string) => FocusTarget | null;
  /** Keyboard Space with nobody in focus: the power dialer's "Call now". */
  dialerCallNow: () => boolean;
  /** The power dialer's current or last person, for keyboard W. */
  dialerPerson: () => FocusTarget | null;
  /** The call screen's power-dialer controls. */
  dialerNext: () => void;
  dialerPause: () => void;
  dialerResume: () => void;
  dialerSkip: () => void;
  dialerStop: () => void;
}

interface Props {
  active: boolean;
  syncEndpoint: string;
  onDial: (phone: string) => void;
  /** Places the call straight away (the auto-dialer). */
  onAutoDial: (phone: string) => void;
  onSchedule: (t: ScheduleTarget) => void;
  onSms: (t: SmsTarget) => void;
  addLog: (msg: string) => void;
  /** Every list as last read, so the Calls tab can show them too. */
  onListsChange?: (lists: ImportList[]) => void;
  /** Opens the Focus workspace on one person. */
  onFocus: (t: FocusTarget) => void;
  /** The power dialer's state, for the in-app call screen (null when it is not running). */
  onDialerChange?: (d: DialerInfo | null) => void;
  /** Opens the Reports tab (tapping Talk time). */
  onOpenReports?: () => void;
}

export interface DialerInfo {
  phase: 'countdown' | 'calling' | 'wrapup' | 'paused';
  pos: number;
  total: number;
  /** When the countdown runs out (ms). */
  at: number;
  current: { name: string; number: string; segment: string } | null;
  next: { name: string; number: string } | null;
}

const PER_PAGE = 100;
const SEARCH_DEBOUNCE_MS = 300;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_LISTS = 'imports_lists_v1';
const cacheDetailKey = (id: number) => `imports_detail_v1_${id}`;

/* The quick-filter tabs above every list; the first six are the working views. */
const SHOW_CHIPS: { key: Show; label: string; icon?: IconName; count: (s: Summary) => number | undefined }[] = [
  { key: 'all', label: 'All', count: (s) => s.rows_total },
  { key: 'needs_callback', label: 'Needs callback', icon: 'phone_callback', count: (s) => s.needs_callback },
  { key: 'never', label: 'Uncalled only', icon: 'call', count: (s) => s.never },
  { key: 'scheduled', label: 'Scheduled', icon: 'alarm', count: (s) => s.scheduled },
  { key: 'wa_sent', label: 'WhatsApp sent', icon: 'chat', count: (s) => s.wa_sent },
  { key: 'maxed', label: 'Max attempts', icon: 'block', count: (s) => s.maxed },
  { key: 'replied', label: 'Replied', icon: 'chat_bubble_outline', count: (s) => s.wa_replied },
  { key: 'ghosting', label: 'Ghosting reviver', icon: 'local_fire_department', count: (s) => s.ghosting },
  { key: 'converted', label: 'Converted', icon: 'emoji_events', count: (s) => s.converted },
  { key: 'review', label: 'Needs review', icon: 'warning_amber', count: (s) => s.review },
  { key: 'dnd', label: 'DND', icon: 'block', count: (s) => s.dnd },
  { key: 'connected', label: 'Connected', count: (s) => s.connected },
  { key: 'not_connected', label: 'Not connected', count: (s) => s.not_connected },
  { key: 'purchased', label: 'Purchased', count: (s) => s.purchased },
];

/* Bulk "Set status": what each person was imported as, as the import dialog offers it. */
const BULK_STATUSES: { key: string; label: string; icon: IconName }[] = [
  { key: 'needs_callback', label: 'Needs callback', icon: 'phone_callback' },
  { key: 'missed_call', label: 'Missed call', icon: 'phone_missed' },
  { key: 'not_called', label: 'Not called', icon: 'call' },
  { key: 'pending_followup', label: 'Pending follow-up', icon: 'alarm' },
  { key: 'called', label: 'Called', icon: 'check_circle' },
];

type Scope = 'all' | 'active' | 'recent';
const SCOPES: { key: Scope; label: string; icon?: IconName }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active', icon: 'bolt' },
  { key: 'recent', label: 'Recent', icon: 'schedule' },
];
/** Still has people nobody has called. */
const isActive = (l: ImportList) => l.status === 'ready' && toCall(l) > 0;
const isRecent = (l: ImportList) => Date.now() - serverTime(l.created_at) < RECENT_MS;

type Sort = 'recent' | 'todo' | 'name';
const SORTS: { key: Sort; label: string }[] = [
  { key: 'recent', label: 'Newest' },
  { key: 'todo', label: 'Most to call' },
  { key: 'name', label: 'Name' },
];

/**
 * `next`, but reusing every item of `prev` that came back identical — and `prev` itself when
 * nothing changed at all — so a refresh with no news leaves React nothing to redraw.
 */
function keepSame<T extends { id: number }>(prev: T[] | null | undefined, next: T[]): T[] {
  if (!prev || !prev.length) return next;
  const old = new Map(prev.map((x) => [x.id, x]));
  let same = prev.length === next.length;
  const out = next.map((x, i) => {
    const o = old.get(x.id);
    if (o && JSON.stringify(o) === JSON.stringify(x)) {
      if (prev[i] !== o) same = false;
      return o;
    }
    same = false;
    return x;
  });
  return same ? prev : out;
}

/** The number handed to the dialer: the file's own number when it is complete, else the matched one. */
const dialNumber = (r: ImportRow): string => {
  const raw = (r.phone_raw || '').replace(/[^\d+]/g, '');
  if (raw.replace(/\D/g, '').length >= 10) return raw;
  return r.phone_norm || '';
};

const STATUS_LABEL: { [k: string]: string } = {
  needs_callback: 'Needs callback', missed_call: 'Missed call', scheduled: 'Scheduled', connected: 'Connected',
  called: 'Called', not_connected: 'Not connected', not_called: 'Not called', no_phone: 'No phone',
};

/** Same wording as the admin panel's Status column; worked out here only for an older panel. */
const rowStatus = (r: ImportRow): string => {
  if (r.status && STATUS_LABEL[r.status]) return STATUS_LABEL[r.status];
  if ((r.connected || 0) > 0) return 'Connected';
  if (r.called_by) return 'Called';
  if (!r.phone_norm) return 'No phone';
  return (r.total || 0) > 0 ? 'Not connected' : 'Not called';
};

/* Still owed a call, or rang with no answer: where a WhatsApp counts as the latest step. */
const WA_STATUSES = ['needs_callback', 'missed_call', 'not_connected', 'not_called'];

/* The power dialer works down people still owed a call, under the attempt limit. */
const DIAL_STATUSES = ['not_called', 'missed_call', 'needs_callback'];
const START_MS = 3000;    // a moment to cancel before the first call goes out
const WRAP_MS = 4000;     // after the outcome is logged: a breath before the next call

interface AutoDial {
  key: string;            // the list / filter / search it was started on
  picked: boolean;        // people chosen by hand (bulk "Dial"): called whatever their status
  ids: number[];
  pos: number;
  /** countdown → calling → wrapup (call ended, waiting for its outcome) → countdown … */
  phase: 'countdown' | 'calling' | 'wrapup' | 'paused';
  at: number;             // when the countdown ends
  called: number;
}

/** Retry gap after `n` failures in a row: 30 s, 1 min, 2 min… up to 5 min. */
const backoff = (n: number) => Math.min(5 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, n - 1));

/* ── the screen ─────────────────────────────────────────────────────────── */

const ImportsScreen = forwardRef<ImportsHandle, Props>(({ active, syncEndpoint, onDial, onAutoDial, onSchedule, onSms, addLog, onListsChange, onFocus, onDialerChange, onOpenReports }, ref) => {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const wa = useWaSend();
  const points = usePoints();
  const undo = useUndo();
  const [importOpen, setImportOpen] = useState<boolean>(false);
  const [listMenu, setListMenu] = useState<ImportList | null>(null);
  const [listMenuMode, setListMenuMode] = useState<'' | 'merge' | 'split'>('');
  const [view, setView] = useState<'list' | 'board'>('list');
  const [exporting, setExporting] = useState<boolean>(false);

  const [lists, setLists] = useState<ImportList[]>([]);
  const [listsAt, setListsAt] = useState<number>(0);
  const [listsLoading, setListsLoading] = useState<boolean>(false);
  const [listsError, setListsError] = useState<string>('');
  const [listsErrorKind, setListsErrorKind] = useState<string>('');
  const [listQInput, setListQInput] = useState<string>('');
  const [listQ, setListQ] = useState<string>('');
  const [scope, setScope] = useState<Scope>('all');
  const [sort, setSort] = useState<Sort>('recent');

  const [openId, setOpenId] = useState<number | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [qInput, setQInput] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState<boolean>(false);
  const [detailError, setDetailError] = useState<string>('');
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [pulling, setPulling] = useState<boolean>(false);

  // Rows the counselor just dialled: the call shows in the panel only once the phone uploads it.
  const [dialled, setDialled] = useState<{ [rowId: number]: { at: number; calls: number } }>({});
  // Attempts made from this phone, shown before the panel has the calls.
  const [tried, setTried] = useState<{ [rowId: number]: number }>({});
  const triedRef = useRef(tried);
  triedRef.current = tried;
  const [auto, setAuto] = useState<AutoDial | null>(null);
  const autoRef = useRef<AutoDial | null>(null);
  autoRef.current = auto;
  const awayRef = useRef<boolean>(false);
  // Multi-select for bulk actions; `selecting` stays on until cancelled, even with nothing ticked.
  const [selected, setSelected] = useState<{ [rowId: number]: true }>({});
  const [selecting, setSelecting] = useState<boolean>(false);
  const [bulkSheet, setBulkSheet] = useState<'' | 'status' | 'move' | 'assign'>('');
  // Sharing people out: the team, who is picked, and whose people the list shows.
  const [agents, setAgents] = useState<Agent[]>([]);
  const [assignPick, setAssignPick] = useState<string[]>([]);
  const [assigned, setAssigned] = useState<string>('');
  // Lists that pull new rows from a Google Sheet.
  const [sheetLinks, setSheetLinks] = useState<SheetLink[]>([]);
  const [bulkBusy, setBulkBusy] = useState<boolean>(false);
  const [selectingAll, setSelectingAll] = useState<boolean>(false);
  // "First 30": how many to pick from the top of this view, typed in for Custom.
  const [customN, setCustomN] = useState<string | null>(null);
  // Everyone "Select all matching" picked, including people not loaded on screen yet.
  const matching = useRef<Map<number, { name: string; phone: string }>>(new Map());

  const [noteRow, setNoteRow] = useState<ImportRow | null>(null);
  const [noteCaller, setNoteCaller] = useState<string>('');
  const [noteComment, setNoteComment] = useState<string>('');
  const [noteTags, setNoteTags] = useState<string>('');
  const [noteSaving, setNoteSaving] = useState<boolean>(false);
  const [myName, setMyName] = useState<string>('');

  const detailCache = useRef<Map<string, Detail>>(new Map());
  const listsInFlight = useRef<Promise<void> | null>(null);
  const listsFails = useRef<{ n: number; at: number }>({ n: 0, at: 0 });
  const detailInFlight = useRef<string>('');
  const knownIds = useRef<Set<number> | null>(null);
  const dialledAt = useRef<number>(0);
  const moreInFlight = useRef<boolean>(false);

  const keyOf = (id: number | null, sh: Show, query: string) => `${id}|${sh}|${query}|${assigned}`;
  const currentKey = keyOf(openId, show, q);

  // Effects and timers call through this, so they always see the latest state.
  const live = useRef<any>({});
  live.current = { active, openId, show, q, assigned, currentKey, detail, lists, listsAt, myName, tried: {} as { [id: number]: number } };

  live.current.tried = triedRef.current;
  const ask = (body: any, timeoutMs = 25000) => panelAsk('imports.php', body, syncEndpoint, timeoutMs);

  /* ── every uploaded list ── */

  const loadLists = (mode: 'initial' | 'silent' | 'pull'): Promise<void> => {
    if (listsInFlight.current) return listsInFlight.current;
    // A failing panel is not asked again every minute; a pull or a Retry always goes.
    const f = listsFails.current;
    if (mode === 'silent' && f.n > 0 && Date.now() - f.at < backoff(f.n)) return Promise.resolve();
    if (mode !== 'silent') setListsLoading(true);
    const run = (async () => {
      try {
        const data = await ask({ action: 'list' });
        // One card per list, even if the panel ever sends one twice.
        const byId = new Map<number, ImportList>();
        (Array.isArray(data.imports) ? data.imports : []).forEach((x: ImportList) => {
          const id = Number(x?.id);
          if (id && !byId.has(id)) byId.set(id, { ...x, id });
        });
        const fresh = Array.from(byId.values());
        // A list the admin uploaded since the last look is worth a word.
        if (knownIds.current) {
          const added = fresh.filter((x) => !knownIds.current!.has(x.id));
          if (added.length) toast(added.length === 1 ? `New list: ${added[0].name}` : `${added.length} new lists uploaded`);
        }
        knownIds.current = new Set(fresh.map((x) => x.id));
        setLists((prev) => {
          const next = keepSame(prev, fresh);
          // A list whose numbers moved has stale people cached; the next open reads them again.
          next.forEach((x) => {
            if (prev.length && !prev.includes(x)) dropDetail(x.id);
          });
          return next;
        });
        setListsAt(Date.now());
        setListsError('');
        listsFails.current = { n: 0, at: 0 };
        CallBridge?.saveUiCache?.(CACHE_LISTS, JSON.stringify({ at: Date.now(), lists: fresh }));
        if (mode !== 'silent') addLog(`Lists: ${fresh.length} from the panel.`);
      } catch (e: any) {
        const msg = e?.message || String(e);
        listsFails.current = { n: listsFails.current.n + 1, at: Date.now() };
        setListsError(msg);
        setListsErrorKind(errorKind(e));
        addLog(`Lists error: ${msg}`);
      } finally {
        setListsLoading(false);
        listsInFlight.current = null;
      }
    })();
    listsInFlight.current = run;
    return run;
  };

  /** Forgets the cached people of one list, except the view on screen (`keep`). */
  const dropDetail = (id: number, keep?: string) => {
    detailCache.current.forEach((_, k) => {
      if (k.startsWith(`${id}|`) && k !== keep) detailCache.current.delete(k);
    });
  };

  /* ── the people on one list ── */

  const loadDetail = async (mode: 'open' | 'silent' | 'more' | 'pull') => {
    const { openId: id, show: sh, q: query, assigned: who, currentKey: key, detail: cur } = live.current;
    if (id == null) return;
    const have: Detail | null = cur && cur.key === key ? cur : null;

    if (mode === 'more') {
      if (!have || moreInFlight.current || have.rows.length >= have.total || have.rows.length % PER_PAGE !== 0) return;
      moreInFlight.current = true;
      setLoadingMore(true);
    } else {
      if (detailInFlight.current === key) return;     // the same request is already on its way
      detailInFlight.current = key;
      if (mode === 'open' && !have) setDetailLoading(true);
    }

    try {
      // A quiet refresh re-reads everything already on screen in one request, so nothing jumps.
      const shown = have ? have.rows.length : 0;
      const per = mode === 'more' ? PER_PAGE : Math.min(500, Math.max(PER_PAGE, Math.ceil(shown / PER_PAGE) * PER_PAGE));
      const page = mode === 'more' ? shown / PER_PAGE + 1 : 1;
      const data = await ask({
        action: 'detail', id, page, per_page: per, sort: 'row', dir: 'asc', q: query, max: MAX_ATTEMPTS,
        show: sh === 'purchased' ? 'all' : sh, buy: sh === 'purchased' ? 'yes' : '', assigned: who,
      });
      const got: ImportRow[] = Array.isArray(data.rows) ? data.rows : [];

      // The counselor may have moved on to another list or filter meanwhile.
      if (live.current.currentKey !== key) return;

      const base: Detail | null = live.current.detail && live.current.detail.key === key ? live.current.detail : null;
      let rows: ImportRow[];
      if (mode === 'more' && base) {
        const seen = new Set(base.rows.map((r) => r.id));
        rows = base.rows.concat(got.filter((r) => !seen.has(r.id)));
      } else if (base && base.rows.length > got.length) {
        // Over 500 shown: refresh the first 500, keep the rest as they were.
        const seen = new Set(got.map((r) => r.id));
        rows = got.concat(base.rows.slice(got.length).filter((r) => !seen.has(r.id)));
      } else {
        const seen = new Set<number>();
        rows = got.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
      }
      rows = keepSame(base?.rows, rows);
      // Other filters of this list were read earlier; after a refresh they may be out of date.
      if (mode !== 'more' && mode !== 'open') dropDetail(id, key);
      const next: Detail = {
        key,
        rows,
        total: Number(data.total) || rows.length,
        summary: data.summary || base?.summary || null,
        calls: data.calls || base?.calls || null,
        at: Date.now(),
      };
      detailCache.current.set(key, next);
      setDetail(next);
      setDetailError('');

      // A dialled row stops showing "Calling…" once the panel has the call.
      setDialled((d) => {
        let changed = false;
        const out = { ...d };
        rows.forEach((r) => {
          if (out[r.id] && (r.total || 0) > out[r.id].calls) { delete out[r.id]; changed = true; }
        });
        return changed ? out : d;
      });

      if (sh === 'all' && !query) {
        CallBridge?.saveUiCache?.(cacheDetailKey(id), JSON.stringify({ ...next, rows: rows.slice(0, PER_PAGE) }));
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (live.current.currentKey === key) setDetailError(msg);
      addLog(`List error: ${msg}`);
    } finally {
      if (mode === 'more') { moreInFlight.current = false; setLoadingMore(false); }
      else {
        if (detailInFlight.current === key) detailInFlight.current = '';
        setDetailLoading(false);
      }
    }
  };

  const refreshVisible = (mode: 'silent' | 'pull') => {
    if (live.current.openId != null) {
      // The list's own totals (and the Calls tab's preview) move with its people.
      const d = loadDetail(mode);
      loadLists('silent');
      return d;
    }
    return loadLists(mode);
  };

  const fn = useRef<any>({});
  fn.current = { loadLists, loadDetail, refreshVisible };

  /* ── lifecycle ── */

  // Last saved copies, so the tab is never empty while the panel answers.
  useEffect(() => {
    (async () => {
      try {
        const raw = await CallBridge?.loadUiCache?.(CACHE_LISTS);
        if (raw) {
          const saved = JSON.parse(raw);
          if (Array.isArray(saved?.lists) && !live.current.lists.length) {
            setLists(saved.lists);
            setListsAt(0);   // still refresh: this copy may be old
            knownIds.current = new Set(saved.lists.map((x: ImportList) => x.id));
          }
        }
        const name = await CallBridge?.loadUiCache?.('counselor_name');
        if (name) setMyName(name);
      } catch (_) {}
      // Read the lists once at launch, quietly, so they are ready before the tab is opened.
      fn.current.loadLists(live.current.lists.length ? 'silent' : 'initial');
    })();
  }, []);

  useEffect(() => { onListsChange?.(lists); }, [lists]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back from dialling someone on a list: one quiet re-read now and one once the call has had time
  // to upload, so "Calling…" turns into the real outcome. Any other return to the app reads nothing.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active' || !live.current.active || !dialledAt.current) return;
      dialledAt.current = 0;
      fn.current.refreshVisible('silent');
      timers.push(setTimeout(() => fn.current.refreshVisible('silent'), 8000));
    });
    return () => { sub.remove(); timers.forEach(clearTimeout); };
  }, []);

  // A new list / filter / search: what was already read shows at once and is not read again;
  // anything not read yet is fetched once.
  useEffect(() => {
    if (openId == null) return;
    const cached = detailCache.current.get(currentKey) || null;
    setDetail(cached);
    setDetailError('');
    if (!cached && show === 'all' && !q) {
      // First open since launch: the copy saved on the phone, if any.
      CallBridge?.loadUiCache?.(cacheDetailKey(openId)).then((raw: string) => {
        if (!raw || live.current.currentKey !== currentKey || live.current.detail) return;
        try {
          const saved = JSON.parse(raw);
          if (saved && Array.isArray(saved.rows)) setDetail({ ...saved, key: currentKey, at: 0 });
        } catch (_) {}
      }).catch(() => {});
    }
    if (!cached) fn.current.loadDetail('open');
  }, [currentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // People are searched on the server, lists in memory — both once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [qInput]);
  useEffect(() => {
    const timer = setTimeout(() => setListQ(listQInput.trim().toLowerCase()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [listQInput]);

  /* ── the team (for sharing people out), and Google Sheet sync ── */
  useEffect(() => {
    if (active && !agents.length) crm.agents().then((a) => { agentNames = Object.fromEntries(a.map((x) => [x.device_id, x.name])); setAgents(a); }).catch(() => {});
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncing = useRef<boolean>(false);
  const runSheetSync = useCallback(async (only?: number) => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const links = await loadLinks();
      if (!links.length) { setSheetLinks([]); return; }
      const out: SheetLink[] = [];
      let added = 0;
      for (const l of links) {
        if (only != null && l.listId !== only) { out.push(l); continue; }
        const next = await syncLink(l, (body, ms) => panelAsk('imports.php', body, syncEndpoint, ms));
        added += next.lastAdded;
        if (next.lastAdded) addLog(`Sheet sync: ${next.lastAdded} new rows into “${l.listName}”.`);
        out.push(next);
      }
      saveLinks(out);
      setSheetLinks(out);
      if (added) {
        toast(`${plural(added, 'new lead')} from Google Sheets`);
        fn.current.loadLists('silent');
        if (live.current.openId != null) fn.current.refreshVisible('silent');
      } else if (only != null) {
        const l = out.find((x) => x.listId === only);
        toast(l?.error ? `Sheet sync failed — ${l.error}` : 'Sheet checked — nothing new', l?.error ? 'error' : 'default');
      }
    } finally {
      syncing.current = false;
    }
  }, [syncEndpoint, addLog, toast]);
  useEffect(() => {
    loadLinks().then(setSheetLinks);
    const tick = () => { if (AppState.currentState === 'active') runSheetSync(); };
    const first = setTimeout(tick, 15000);
    const timer = setInterval(tick, SYNC_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [runSheetSync]);
  const unlinkSheet = async (listId: number) => {
    const next = (await loadLinks()).filter((l) => l.listId !== listId);
    saveLinks(next);
    setSheetLinks(next);
    toast('No longer syncing from the sheet');
  };

  /* ── navigation ── */

  const openList = useCallback((l: ImportList, startShow: Show = 'all') => {
    setShow(startShow);
    setQInput('');
    setQ('');
    setOpenId(l.id);
  }, []);

  /** A list's "Start dialer": open it on the people still to call, and start the power dialer. */
  const powerDial = useCallback((l: ImportList) => {
    const sh: Show = l.to_call == null ? 'never' : 'to_call';
    pendingDial.current = keyOf(l.id, sh, '');
    openList(l, sh);
  }, [openList]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeList = () => {
    if (autoRef.current) stopAuto();
    clearSelection();
    setOpenId(null);
    setDetail(null);
    setDetailError('');
  };

  useImperativeHandle(ref, () => ({
    handleBack: () => {
      if (noteRow) { setNoteRow(null); return true; }
      if (live.current.openId != null) { closeList(); return true; }
      if (listQInput || scope !== 'all') { setListQInput(''); setScope('all'); return true; }
      return false;
    },
    refresh: () => fn.current.loadLists('silent'),
    refreshOpen: () => fn.current.refreshVisible('silent'),
    openListById: (id: number, startShow: Show = 'all', powerDial = false) => {
      const l = live.current.lists.find((x: ImportList) => x.id === id);
      if (!l) return;
      if (powerDial) pendingDial.current = keyOf(id, startShow, '');
      openList(l, startShow);
    },
    editRow: async (tg, patch) => {
      if (tg.importId == null || tg.rowId == null) return;
      try {
        const before = (live.current.detail?.rows || []).find((r: ImportRow) => r.id === tg.rowId);
        const d = await panelAsk('imports.php', { action: 'edit_row', id: tg.importId, row_id: tg.rowId, ...patch }, syncEndpoint);
        const row = d.row || {};
        patchRows((r) => r.id === tg.rowId, (r) => ({ ...r, name: row.name ?? r.name, phone_raw: row.phone_raw ?? r.phone_raw, phone_norm: row.phone_norm ?? r.phone_norm, import_status: row.import_status ?? r.import_status }));
        toast('Saved');
        if (patch.status && before) {
          undo.push(`Status changed for ${before.name || 'this person'}`, () => panelAsk('imports.php', { action: 'edit_row', id: tg.importId, row_id: tg.rowId, status: before.import_status || 'not_called' }, syncEndpoint).then(() => fn.current.refreshVisible('silent')));
        }
        fn.current.refreshVisible('silent');
      } catch (e: any) {
        toast(`Not saved — ${e?.message || e}`, 'error');
        throw e;
      }
    },
    pinRow: async (tg, pinned) => {
      if (tg.importId == null || tg.rowId == null) return;
      try {
        await panelAsk('imports.php', { action: 'pin', id: tg.importId, row_id: tg.rowId, pinned }, syncEndpoint);
        patchRows((r) => r.id === tg.rowId, (r) => ({ ...r, pinned: pinned ? 1 : 0 }));
        dropDetail(tg.importId, live.current.currentKey);
        fn.current.refreshVisible('silent');
        undo.push(pinned ? 'Pinned to the top' : 'Unpinned', () => panelAsk('imports.php', { action: 'pin', id: tg.importId, row_id: tg.rowId, pinned: !pinned }, syncEndpoint).then(() => fn.current.refreshVisible('silent')));
      } catch (e: any) {
        toast(`Not saved — ${e?.message || e}`, 'error');
        throw e;
      }
    },
    patchMeta: (number, m) => patchRows(sameNumber(number), (r) => ({ ...r, ...m, stage: m.stage })),
    visibleRows: () => {
      const rs: ImportRow[] = live.current.detail?.key === live.current.currentKey ? live.current.detail.rows : [];
      const pins = rs.filter((r) => r.pinned).length;
      return rs.map((r, i) => ({ target: targetOf(r, r.pinned ? 0 : i - pins + 1), status: rowStatus(r) }));
    },
    next: (afterNumber) => {
      if (autoRef.current) { const a = autoRef.current; setAuto({ ...a, pos: a.pos + 1, phase: 'countdown', at: Date.now() + START_MS }); return null; }
      const rs: ImportRow[] = live.current.detail?.key === live.current.currentKey ? live.current.detail.rows : [];
      if (!rs.length) return null;
      const k = (afterNumber || '').replace(/\D/g, '').slice(-10);
      const at = k ? rs.findIndex((r) => (r.phone_norm || '').slice(-10) === k) : -1;
      const pins = rs.filter((r) => r.pinned).length;
      const i = Math.min(rs.length - 1, at + 1);
      return targetOf(rs[i], rs[i].pinned ? 0 : i - pins + 1);
    },
    dialerCallNow: () => {
      const a = autoRef.current;
      if (!a || a.phase !== 'countdown') return false;
      setAuto({ ...a, at: Date.now() });
      return true;
    },
    dialerNext: () => fnAuto.current.next(),
    dialerPause: () => { const a = autoRef.current; if (a) setAuto({ ...a, phase: 'paused' }); },
    dialerResume: () => { const a = autoRef.current; if (a) setAuto({ ...a, phase: 'countdown', at: Date.now() + START_MS }); },
    dialerSkip: () => { const a = autoRef.current; if (a) setAuto({ ...a, pos: a.pos + 1, phase: 'countdown', at: Date.now() + START_MS }); },
    dialerStop: () => fnAuto.current.stopAuto(),
    dialerPerson: () => {
      const a = autoRef.current;
      if (!a) return null;
      const rs: ImportRow[] = live.current.detail?.rows || [];
      const id = a.phase === 'countdown' && a.called > 0 ? a.ids[a.pos - 1] : a.ids[a.pos];
      const r = rs.find((x) => x.id === id);
      return r ? targetOf(r, rs.indexOf(r) + 1) : null;
    },
  }));

  const call = useCallback((r: ImportRow, viaAuto = false) => {
    const n = dialNumber(r);
    if (!n) return;
    dialledAt.current = Date.now();
    setDialled((d) => ({ ...d, [r.id]: { at: Date.now(), calls: r.total || 0 } }));
    setTried((d) => ({ ...d, [r.id]: Math.max(d[r.id] || 0, r.attempts || 0) + 1 }));
    addLog(`${viaAuto ? 'Auto-dialling' : 'Dialling'} ${n} from list #${live.current.openId}, row ${r.row_no}.`);
    (viaAuto ? onAutoDial : onDial)(n);
  }, [addLog, onDial, onAutoDial]);

  const attemptsOf = useCallback((r: ImportRow) => Math.max(r.attempts || 0, tried[r.id] || 0), [tried]);
  const queueable = useCallback((r: ImportRow) => {
    const st = r.status || (rowStatus(r) === 'Not called' ? 'not_called' : '');
    return DIAL_STATUSES.includes(st) && attemptsOf(r) < MAX_ATTEMPTS && !!dialNumber(r);
  }, [attemptsOf]);

  const schedule = useCallback((r: ImportRow) => onSchedule({
    number: dialNumber(r) || r.phone_norm,
    name: r.name,
    segment: live.current.lists.find((l: ImportList) => l.id === live.current.openId)?.name,
    dueAt: serverTime(r.callback_at) || undefined,
  }), [onSchedule]);

  /* ── Auto-dialer ──────────────────────────────────────────────────────────
   * Works down the people in view who are still owed a call — not called, missed, needs callback —
   * and under MAX_ATTEMPTS: dials one, and once the counselor is back from that call (and its
   * outcome popup) counts down a few seconds, then dials the next. Pause, skip or stop any time. */
  const startAuto = (picked?: number[]) => {
    const rowsNow: ImportRow[] = live.current.detail?.rows || [];
    const ids = picked
      ? rowsNow.filter((r) => picked.includes(r.id) && !!dialNumber(r)).map((r) => r.id)
      : rowsNow.filter(queueable).map((r) => r.id);
    if (!ids.length) { toast(picked ? 'None of them has a phone number' : 'Nobody in this view is waiting for a call'); return; }
    setAuto({ key: currentKey, picked: !!picked, ids, pos: 0, phase: 'countdown', at: Date.now() + START_MS, called: 0 });
  };
  const stopAuto = (why?: string) => {
    const a = autoRef.current;
    setAuto(null);
    if (a) toast(why || `Auto-dial stopped · ${plural(a.called, 'call')} made`);
  };
  const dialCurrent = () => {
    const a = autoRef.current;
    if (!a || a.phase !== 'countdown') return;
    const byId = new Map<number, ImportRow>((live.current.detail?.rows || []).map((r: ImportRow) => [r.id, r]));
    let pos = a.pos;
    const ok = (r?: ImportRow) => !!r && (a.picked ? !!dialNumber(r) : queueable(r));
    while (pos < a.ids.length && !ok(byId.get(a.ids[pos]))) pos++;
    if (pos >= a.ids.length) { stopAuto(`Auto-dial finished · ${plural(a.called, 'call')} made`); return; }
    awayRef.current = false;
    wentLive.current = false;
    setAuto({ ...a, pos, phase: 'calling', at: Date.now() });
    call(byId.get(a.ids[pos])!, true);
  };
  /** After the call: the outcome is logged (or skipped) — a short breath, then the next one. */
  const next = () => {
    const a = autoRef.current;
    if (!a || (a.phase !== 'wrapup' && a.phase !== 'calling')) return;
    setAuto({ ...a, pos: a.pos + 1, called: a.called + 1, phase: 'countdown', at: Date.now() + WRAP_MS });
  };
  const fnAuto = useRef<any>({});
  fnAuto.current = { dialCurrent, stopAuto, next };

  // The countdown: dial when it runs out.
  useEffect(() => {
    if (!auto || auto.phase !== 'countdown') return undefined;
    const timer = setTimeout(() => fnAuto.current.dialCurrent(), Math.max(0, auto.at - Date.now()));
    return () => clearTimeout(timer);
  }, [auto]);

  /* The call ending. The phone reports it (CallIQCallState: OFFHOOK, then IDLE): the dialer then
     waits for the outcome before the next call. On a phone that does not report it, coming back to
     the app stands in for the hang-up, as before. */
  const callStateSeen = useRef<boolean>(false);
  const wentLive = useRef<boolean>(false);
  useEffect(() => {
    const sub = native.events?.addListener('CallIQCallState', (ev: { state: string }) => {
      callStateSeen.current = true;
      const a = autoRef.current;
      if (!a || a.phase !== 'calling') return;
      if (ev.state === 'OFFHOOK') wentLive.current = true;
      else if (ev.state === 'IDLE' && wentLive.current) {
        wentLive.current = false;
        setAuto({ ...a, phase: 'wrapup', at: Date.now() });
      }
    });
    const app = AppState.addEventListener('change', (st) => {
      const a = autoRef.current;
      if (!a || a.phase !== 'calling' || callStateSeen.current) return;
      if (st !== 'active') { awayRef.current = true; return; }
      if (awayRef.current) setAuto({ ...a, phase: 'wrapup', at: Date.now() });
    });
    return () => { sub?.remove(); app.remove(); };
  }, []);

  useEffect(() => {
    if (!onDialerChange) return;
    if (!auto) { onDialerChange(null); return; }
    const byId = new Map<number, ImportRow>((detail?.rows || []).map((r) => [r.id, r]));
    const cur = byId.get(auto.ids[auto.pos]);
    const nx = byId.get(auto.ids[auto.pos + 1]);
    const seg = lists.find((l) => l.id === openId)?.name || '';
    onDialerChange({
      phase: auto.phase, pos: auto.pos, total: auto.ids.length, at: auto.at,
      current: cur ? { name: cur.name, number: dialNumber(cur) || cur.phone_norm, segment: seg } : null,
      next: nx ? { name: nx.name, number: dialNumber(nx) || nx.phone_norm } : null,
    });
  }, [auto, detail?.rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Start calling" from Home / the call button: the power dialer starts once the people are in.
  const pendingDial = useRef<string>('');
  useEffect(() => {
    if (!pendingDial.current || !detail || detail.key !== pendingDial.current || autoRef.current) return;
    pendingDial.current = '';
    startAuto();
  }, [detail]); // eslint-disable-line react-hooks/exhaustive-deps

  // Another list, filter or search ends the run; newly loaded people who qualify join the queue,
  // and the next page is fetched before the queue runs dry.
  useEffect(() => {
    if (auto && auto.key !== currentKey) fnAuto.current.stopAuto();
  }, [currentKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = autoRef.current;
    if (!a || a.picked || !detail || detail.key !== a.key) return;
    const have = new Set(a.ids);
    const add = detail.rows.filter((r) => !have.has(r.id) && queueable(r)).map((r) => r.id);
    if (add.length) setAuto({ ...a, ids: a.ids.concat(add) });
    if (a.ids.length + add.length - a.pos <= 3 && detail.rows.length < detail.total) fn.current.loadDetail('more');
  }, [detail, auto?.pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const openNote = useCallback((r: ImportRow) => {
    setNoteRow(r);
    setNoteCaller(r.called_by || live.current.myName);
    setNoteComment(r.comment || '');
    setNoteTags((r.tags || []).join(', '));
  }, []);

  const noteTagList = noteTags.split(',').map((x) => x.trim()).filter(Boolean);

  const saveNote = async () => {
    if (!noteRow || openId == null || noteSaving) return;
    setNoteSaving(true);
    try {
      const tags = Array.from(new Set(noteTagList));
      const data = await ask({ action: 'annotate', id: openId, row_id: noteRow.id, called_by: noteCaller.trim(), comment: noteComment.trim(), tags });
      const saved = data.row || {};
      const patch = (r: ImportRow): ImportRow =>
        r.id === noteRow.id
          ? { ...r, called_by: saved.called_by ?? noteCaller.trim(), comment: saved.comment ?? noteComment.trim(), tags: saved.tags ?? tags }
          : r;
      // Every cached view of this list holds the row, not only the one on screen.
      detailCache.current.forEach((d, k) => {
        if (k.startsWith(`${openId}|`)) detailCache.current.set(k, { ...d, rows: d.rows.map(patch) });
      });
      setDetail((d) => (d ? { ...d, rows: d.rows.map(patch) } : d));
      if (noteCaller.trim() && noteCaller.trim() !== myName) {
        setMyName(noteCaller.trim());
        CallBridge?.saveUiCache?.('counselor_name', noteCaller.trim());
      }
      setNoteRow(null);
      toast('Note saved to the panel');
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    } finally {
      setNoteSaving(false);
    }
  };

  const onPull = async () => {
    setPulling(true);
    try { await refreshVisible('pull'); } finally { setPulling(false); }
  };

  /* ── derived ── */

  const openListInfo = lists.find((l) => l.id === openId) || null;
  const shownDetail = detail && detail.key === currentKey ? detail : null;

  const shownLists = useMemo(() => {
    const out = lists.filter((l) => (scope === 'active' ? isActive(l) : scope === 'recent' ? isRecent(l) : true)
      && (!listQ || `${l.name} ${l.file_name} ${l.created_by_name}`.toLowerCase().includes(listQ)));
    if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    else if (sort === 'todo') out.sort((a, b) => toCall(b) - toCall(a));
    else out.sort((a, b) => serverTime(b.created_at) - serverTime(a.created_at) || b.id - a.id);
    return out;
  }, [lists, listQ, scope, sort]);

  const totals = useMemo(() => lists.reduce((a, l) => ({
    people: a.people + (l.stored_rows || l.total_rows || 0),
    ready: a.ready + (l.status === 'ready' ? toCall(l) : 0),
    active: a.active + (isActive(l) ? 1 : 0),
    recent: a.recent + (isRecent(l) ? 1 : 0),
  }), { people: 0, ready: 0, active: 0, recent: 0 }), [lists]);
  const scopeCount = (k: Scope) => (k === 'active' ? totals.active : k === 'recent' ? totals.recent : lists.length);
  const nextSort = () => setSort(SORTS[(SORTS.findIndex((o) => o.key === sort) + 1) % SORTS.length].key);

  const refreshControl = (
    <RefreshControl refreshing={pulling} onRefresh={onPull} colors={[t.c.primary]} tintColor={t.c.primary} progressBackgroundColor={t.c.surface} />
  );

  /* ── the lists ── */

  const listsHeader = (
    <View>
      <View style={s.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.h1} accessibilityRole="header">Calling lists</Text>
          <Text style={s.sub}>
            {listsAt ? `Updated ${ago(listsAt)} · pull down to refresh` : 'Uploaded by the admin in Caller IQ → Imports'}
          </Text>
        </View>
        <IconButton icon="upload_file" label="Import a list from a CSV" tone="soft" onPress={() => setImportOpen(true)} />
        {listsLoading && !pulling ? (
          <View style={{ width: 40, alignItems: 'center' }}><ActivityIndicator size="small" color={t.c.primary} /></View>
        ) : (
          <IconButton icon="refresh" label="Refresh lists" tone="outlined" onPress={() => loadLists('pull')} />
        )}
      </View>

      {/* Bento strip — live totals across every list the panel sent. */}
      <View style={s.bento}>
        {lists.length ? (
          <>
            <MetricTile icon="format_list_bulleted" label="Lists" value={num(lists.length)} fg={t.c.link} bg={t.c.primarySoft} />
            <MetricTile icon="groups" label="Contacts" value={num(totals.people)} fg={t.c.violet} bg={t.c.violetSoft} />
            <MetricTile icon="phone_in_talk" label="Ready to call" value={num(totals.ready)} fg={t.c.success} bg={t.c.successSoft} />
          </>
        ) : listsLoading ? (
          [0, 1, 2].map((i) => <Skeleton key={i} height={104} r={radius.lg} style={{ flex: 1 }} />)
        ) : null}
      </View>

      {lists.length > 0 && (
        <>
          <SearchField value={listQInput} onChangeText={setListQInput} placeholder="Search lists by name or uploader" />
          <ChipBar>
            {SCOPES.map((o) => (
              <Chip key={o.key} label={o.label} icon={o.icon} count={scopeCount(o.key)} selected={scope === o.key} onPress={() => setScope(o.key)} />
            ))}
            <Chip label={SORTS.find((o) => o.key === sort)!.label} icon="sort" onPress={nextSort} />
          </ChipBar>
        </>
      )}

      {!!listsError && lists.length > 0 && (
        <Banner
          tone={listsErrorKind === 'offline' || listsErrorKind === 'timeout' ? 'warning' : 'danger'}
          icon={listsErrorKind === 'offline' ? 'wifi_off' : listsErrorKind === 'outdated' || listsErrorKind === 'missing' ? 'dns' : 'error_outline'}
          title={listsErrorKind === 'outdated' || listsErrorKind === 'missing' ? 'Lists can’t load from the panel yet' : 'Couldn’t refresh the lists'}
          message={`${listsError} The lists below are the last saved copy.`}
          actionLabel="Retry"
          actionBusy={listsLoading}
          onAction={() => loadLists('pull')}
        />
      )}
    </View>
  );

  const listsEmpty = listsLoading && !lists.length ? (
    <View>{[0, 1, 2].map((i) => <SkeletonCard key={i} lines={4} />)}</View>
  ) : listsError && !lists.length ? (
    <EmptyState
      tone="danger"
      icon={listsErrorKind === 'offline' ? 'wifi_off' : listsErrorKind === 'outdated' || listsErrorKind === 'missing' ? 'dns' : 'cloud_off'}
      title={listsErrorKind === 'offline' ? 'You’re offline' : 'Couldn’t load the lists'}
      body={listsError}
      actionLabel="Retry"
      actionIcon="refresh"
      onAction={() => loadLists('pull')}
    />
  ) : lists.length === 0 ? (
    <EmptyState
      icon="cloud_upload"
      title="No calling lists yet"
      body="Upload a list in the admin panel under Caller IQ → Imports, then pull down here to load it."
      actionLabel="Check for lists"
      actionIcon="refresh"
      onAction={() => loadLists('pull')}
    />
  ) : (
    <EmptyState
      icon="search"
      title={listQInput ? `No list matches “${listQInput}”` : scope === 'active' ? 'Every list is fully called' : 'No list uploaded this week'}
      actionLabel="Show all lists"
      onAction={() => { setListQInput(''); setScope('all'); }}
    />
  );

  const renderList = useCallback(({ item, index }: { item: ImportList; index: number }) => (
    <ListCard l={item} index={index} onOpen={openList} onPowerDial={powerDial} onMenu={setListMenu} sheet={sheetLinks.find((x) => x.listId === item.id)} />
  ), [openList, powerDial, sheetLinks]);

  /* ── one list's people ── */

  const sum = shownDetail?.summary || null;
  const rows = shownDetail?.rows || [];
  const queueCount = useMemo(() => rows.filter(queueable).length, [rows, queueable]);
  const selectedIds = Object.keys(selected).map(Number);
  const allInView = rows.length > 0 && rows.every((r) => selected[r.id]);

  const detailHeader = (
    <View>
      <View style={s.detailHead}>
        <IconButton icon="arrow_back" label="Back to all lists" tone="outlined" onPress={closeList} />
        <View style={{ flex: 1 }}>
          <Text style={s.h2} numberOfLines={2} accessibilityRole="header">{openListInfo?.name || 'List'}</Text>
          <Text style={s.sub} numberOfLines={1}>
            {shownDetail?.at ? `Updated ${ago(shownDetail.at)}` : detailLoading ? 'Loading…' : 'Saved copy'}
            {shownDetail?.calls ? ` · ${plural(shownDetail.calls.calls, 'call')} · ${talk(shownDetail.calls.talk_sec)} talk` : ''}
          </Text>
        </View>
        {detailLoading && rows.length > 0 && <ActivityIndicator size="small" color={t.c.primary} />}
        {!selecting && !auto && (
          <IconButton icon={view === 'list' ? 'view_kanban' : 'view_list'} label={view === 'list' ? 'Board view' : 'List view'} tone="outlined" onPress={() => setView(view === 'list' ? 'board' : 'list')} />
        )}
        {rows.length > 0 && !auto && !selecting && (
          exporting ? <ActivityIndicator size="small" color={t.c.primary} />
            : <IconButton icon="download" label="Export this view as CSV" tone="outlined" onPress={exportCsv} />
        )}
        {rows.length > 0 && !auto && view === 'list' && (
          <IconButton
            icon={selecting ? 'close' : 'checklist'}
            label={selecting ? 'Stop selecting' : 'Select people'}
            tone={selecting ? 'soft' : 'outlined'}
            onPress={selecting ? clearSelection : () => setSelecting(true)}
          />
        )}
      </View>

      {sum && (
        /* Segment summary — live counts; each pill shows just those people. */
        <View style={s.summaryGrid}>
          <SummaryPill label="Total (#)" value={sum.rows_total} color={t.c.textSoft} on={show === 'all'} onPress={() => setShow('all')} />
          <SummaryPill label="Callback / missed" value={sum.needs_callback ?? sum.to_call ?? sum.never} color={t.c.danger} on={show === 'needs_callback'} onPress={() => setShow('needs_callback')} />
          <SummaryPill label="Scheduled" value={sum.scheduled ?? 0} color={t.c.blue} on={show === 'scheduled'} onPress={() => setShow('scheduled')} />
          <SummaryPill label="WhatsApp / replied" value={sum.wa_sent ?? 0} extra={sum.wa_replied ? `${num(sum.wa_replied)} replied` : undefined} color={t.c.violet} on={show === 'wa_sent'} onPress={() => setShow('wa_sent')} />
          <SummaryPill label="Converted" value={sum.converted ?? sum.purchased} color={t.c.success} on={show === 'converted' || show === 'purchased'} onPress={() => setShow(sum.converted == null ? 'purchased' : 'converted')} />
          <SummaryPill label="Talk time" text={hm(shownDetail?.calls?.talk_sec || 0)} extra={onOpenReports ? 'Full report ›' : undefined} color={t.c.link} onPress={onOpenReports} />
        </View>
      )}

      {selecting && (
        <View style={s.selectRow}>
          <Text style={s.selectText}>{plural(selectedIds.length, 'selected', 'selected')}</Text>
          <Pressable
            onPress={() => setSelected(allInView ? {} : Object.fromEntries(rows.map((r) => [r.id, true])))}
            hitSlop={10}
            accessibilityRole="button"
          >
            <Text style={s.selectLink}>{allInView ? 'Select none' : `Select all ${num(rows.length)} shown`}</Text>
          </Pressable>
        </View>
      )}
      {selecting && (shownDetail?.total ?? rows.length) > 1 && (
        <View>
          <Text style={s.firstLabel}>Pick from the top of this view</Text>
          <ChipBar>
            {[10, 30, 50, 100].filter((n) => n < (shownDetail?.total ?? rows.length)).map((n) => (
              <Chip key={n} label={`First ${n}`} selected={selectedIds.length === n} onPress={() => selectFirst(n)} />
            ))}
            <Chip label="Custom…" icon="edit_note" selected={customN != null} onPress={() => setCustomN(customN == null ? '' : null)} />
          </ChipBar>
          {customN != null && (
            <View style={s.customRow}>
              <View style={{ flex: 1 }}>
                <Field label={`How many (of ${num(shownDetail?.total ?? rows.length)})`} value={customN} onChangeText={(v) => setCustomN(v.replace(/\D/g, '').slice(0, 5))} keyboardType="number-pad" placeholder="e.g. 30" autoFocus />
              </View>
              <Button label="Select" icon="check" size="sm" disabled={!Number(customN)} onPress={() => { selectFirst(Number(customN)); setCustomN(null); }} style={{ marginTop: 26 }} />
            </View>
          )}
        </View>
      )}
      {selecting && shownDetail && shownDetail.total > rows.length && selectedIds.length < shownDetail.total && (
        <Pressable onPress={selectAllMatching} hitSlop={10} accessibilityRole="button" style={s.selectAll}>
          {selectingAll ? <ActivityIndicator size="small" color={t.c.primary} /> : <Icon name="select_all" size={16} color={t.c.link} />}
          <Text style={s.selectLink}>Select all {num(shownDetail.total)} matching this filter</Text>
        </Pressable>
      )}

      {!auto && !selecting && queueCount > 0 && (
        <Button
          label={`Start power dialer · ${num(queueCount)}${shownDetail && rows.length < shownDetail.total ? '+' : ''}`}
          icon="play_arrow"
          variant="success"
          size="lg"
          pill
          onPress={() => startAuto()}
          accessibilityLabel={`Start the power dialer on ${queueCount} people in this view`}
          style={{ marginBottom: space.md }}
        />
      )}

      {show === 'ghosting' && rows.length > 0 && !selecting && (
        <Button
          label={`Revive all ${num(shownDetail?.total ?? rows.length)} on WhatsApp`}
          icon="local_fire_department"
          variant="secondary"
          onPress={reviveAll}
          style={{ marginBottom: space.md }}
        />
      )}
      <SearchField value={qInput} onChangeText={setQInput} placeholder="Search name, email or phone" />
      <ChipBar>
        {SHOW_CHIPS.filter((c) => !sum || c.count(sum) !== undefined || show === c.key).map((c) => (
          <Chip key={c.key} label={c.label} icon={c.icon} count={sum ? c.count(sum) ?? null : null} selected={show === c.key} onPress={() => setShow(c.key)} />
        ))}
      </ChipBar>
      {agents.length > 1 && (
        <ChipBar>
          <Chip label="Everyone’s" icon="groups" selected={!assigned} onPress={() => setAssigned('')} />
          <Chip label="Mine" icon="person_outline" selected={assigned === panelDevice()} onPress={() => setAssigned(panelDevice())} />
          <Chip label="Unassigned" selected={assigned === '__none__'} onPress={() => setAssigned('__none__')} />
          {agents.filter((a) => a.device_id !== panelDevice()).map((a) => (
            <Chip key={a.device_id} label={a.name} selected={assigned === a.device_id} onPress={() => setAssigned(a.device_id)} />
          ))}
        </ChipBar>
      )}

      {!!detailError && (
        <Banner
          tone="danger"
          icon="error_outline"
          message={rows.length ? `${detailError} Showing the last saved copy.` : detailError}
          actionLabel="Retry"
          actionBusy={detailLoading}
          onAction={() => loadDetail(rows.length ? 'silent' : 'open')}
        />
      )}
    </View>
  );

  const detailEmpty = detailLoading ? (
    <View>{[0, 1, 2, 3].map((i) => <SkeletonCard key={i} lines={2} />)}</View>
  ) : detailError ? null : (
    <EmptyState
      icon={q ? 'search' : show === 'never' || show === 'to_call' || show === 'needs_callback' ? 'task_alt' : 'inbox'}
      tone={(show === 'never' || show === 'to_call' || show === 'needs_callback') && !q ? 'success' : 'primary'}
      title={q ? `Nobody matches “${q}”`
        : show === 'never' || show === 'to_call' ? 'Everyone on this list has been called'
        : show === 'needs_callback' ? 'No callbacks owed on this list'
        : show === 'purchased' ? 'Nobody on this list has purchased yet' : 'Nobody here'}
      actionLabel={show !== 'all' ? 'Show everyone' : q ? 'Clear search' : undefined}
      onAction={() => { if (show !== 'all') setShow('all'); else setQInput(''); }}
    />
  );

  const detailFooter = rows.length > 0 ? (
    <View style={s.footer}>
      {loadingMore ? (
        <ActivityIndicator color={t.c.primary} />
      ) : (
        <Text style={s.footerText}>Showing {num(rows.length)} of {num(shownDetail?.total ?? rows.length)}</Text>
      )}
      {!loadingMore && shownDetail && rows.length < shownDetail.total && (
        <Button label="Load more" variant="secondary" size="sm" onPress={() => loadDetail('more')} style={{ marginTop: 10 }} />
      )}
    </View>
  ) : null;

  const sms = useCallback((r: ImportRow) => onSms({
    number: dialNumber(r) || r.phone_norm,
    name: r.name,
    segment: live.current.lists.find((l: ImportList) => l.id === live.current.openId)?.name,
  }), [onSms]);

  const segmentName = (): string => live.current.lists.find((l: ImportList) => l.id === live.current.openId)?.name || '';
  const whatsapp = useCallback((r: ImportRow) => {
    addLog(`WhatsApp to row ${r.row_no} of list #${live.current.openId}.`);
    wa.openSend({ id: r.id, name: r.name, phone: dialNumber(r) || r.phone_norm, segment: segmentName() });
  }, [wa.openSend, addLog]); // eslint-disable-line react-hooks/exhaustive-deps
  const waAtOf = useCallback((r: ImportRow) => Math.max(serverTime(r.wa_at), wa.sentAt(r.phone_norm || r.phone_raw)), [wa]);

  /** What the Focus workspace needs about one person on this list. */
  const targetOf = (r: ImportRow, index: number): FocusTarget => {
    const list = live.current.lists.find((l: ImportList) => l.id === live.current.openId);
    return {
      number: dialNumber(r) || r.phone_norm || r.phone_raw,
      name: r.name,
      email: r.email,
      segment: list?.name,
      index: r.pinned ? 0 : index,
      pinned: !!r.pinned,
      importId: live.current.openId ?? undefined,
      rowId: r.id,
      attempts: Math.max(r.attempts || 0, live.current.tried?.[r.id] || 0),
      importStatus: r.import_status,
      statusLabel: rowStatus(r),
      bestHour: r.best_hour,
      waitingSince: waitingSince(r, list?.created_at),
      dueAt: serverTime(r.callback_at) || undefined,
      meta: rowMeta(r),
    };
  };
  const focus = useCallback((r: ImportRow, index: number) => onFocus(targetOf(r, index)), [onFocus]); // eslint-disable-line react-hooks/exhaustive-deps

  /** One person's row changed (deal fields, pin, name…): every cached view of the list follows. */
  const patchRows = (match: (r: ImportRow) => boolean, patch: (r: ImportRow) => ImportRow) => {
    detailCache.current.forEach((d, k) => detailCache.current.set(k, { ...d, rows: d.rows.map((r) => (match(r) ? patch(r) : r)) }));
    setDetail((d) => (d ? { ...d, rows: d.rows.map((r) => (match(r) ? patch(r) : r)) } : d));
  };
  const sameNumber = (n: string) => { const k = n.replace(/\D/g, '').slice(-10); return (r: ImportRow) => (r.phone_norm || '').slice(-10) === k; };

  /* ── Multi-select and bulk actions ── */
  const toggle = useCallback((r: ImportRow) => {
    setSelecting(true);
    setSelected((cur) => {
      const next = { ...cur };
      if (next[r.id]) delete next[r.id]; else next[r.id] = true;
      return next;
    });
  }, []);
  function clearSelection() { setSelected({}); setSelecting(false); setBulkSheet(''); matching.current = new Map(); }

  /** Everyone this filter and search match, not just the people loaded so far (the panel's own count). */
  async function selectAllMatching() {
    if (openId == null || selectingAll) return;
    setSelectingAll(true);
    try {
      const data = await ask({ action: 'contacts', id: openId, q, max: MAX_ATTEMPTS, show: show === 'purchased' ? 'all' : show, buy: show === 'purchased' ? 'yes' : '', assigned });
      const list: { id: number; name: string; phone: string; phone_raw: string }[] = Array.isArray(data.contacts) ? data.contacts : [];
      matching.current = new Map(list.filter((c: any) => !c.dnd).map((c) => [c.id, { name: c.name, phone: (c.phone_raw || '').replace(/\D/g, '').length >= 10 ? c.phone_raw : c.phone }]));
      // People with no phone number are not in the answer; the ones on screen still count.
      setSelected(Object.fromEntries([...list.map((c) => c.id), ...rows.map((r) => r.id)].map((id) => [id, true])));
      if (data.truncated) toast('Selected the first 5,000 — the most one action can take');
    } catch (e: any) {
      toast(`Couldn’t select everyone — ${e?.message || e}`, 'error');
    } finally {
      setSelectingAll(false);
    }
  }

  /**
   * The first `n` people of this view, in list order (VIPs first) — e.g. 30 of 200 for a WhatsApp
   * campaign. People not loaded on screen yet are fetched from the panel.
   */
  async function selectFirst(n: number) {
    if (openId == null || n <= 0) return;
    if (rows.length >= n || (shownDetail && rows.length >= shownDetail.total)) {
      setSelected(Object.fromEntries(rows.slice(0, n).map((r) => [r.id, true])));
      toast(`First ${num(Math.min(n, rows.length))} selected`);
      return;
    }
    setSelectingAll(true);
    try {
      const data = await ask({ action: 'contacts', id: openId, q, max: MAX_ATTEMPTS, show: show === 'purchased' ? 'all' : show, buy: show === 'purchased' ? 'yes' : '', assigned });
      const list: { id: number; name: string; phone: string; phone_raw: string; dnd?: number }[] = (Array.isArray(data.contacts) ? data.contacts : []).slice(0, n);
      matching.current = new Map(list.filter((c) => !c.dnd).map((c) => [c.id, { name: c.name, phone: (c.phone_raw || '').replace(/\D/g, '').length >= 10 ? c.phone_raw : c.phone }]));
      setSelected(Object.fromEntries(list.map((c) => [c.id, true])));
      toast(`First ${num(list.length)} selected`);
    } catch (e: any) {
      toast(`Couldn’t select them — ${e?.message || e}`, 'error');
    } finally {
      setSelectingAll(false);
    }
  }

  /** The selected people as WhatsApp contacts, for a campaign. */
  const selectedContacts = (): WaContact[] => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seg = segmentName();
    const out: WaContact[] = [];
    selectedIds.forEach((id) => {
      const r = byId.get(id);
      const m = matching.current.get(id);
      const c: WaContact | null = r ? { id, name: r.name, phone: dialNumber(r) || r.phone_norm, segment: seg }
        : m ? { id, name: m.name, phone: m.phone, segment: seg } : null;
      if (c && c.phone && !(r && r.dnd)) out.push(c);
    });
    return out;
  };
  // Selections belong to one view: another list, filter or search starts afresh.
  useEffect(() => { clearSelection(); }, [currentKey]);

  const runBulk = async (op: 'status' | 'move' | 'delete', extra: { status?: string; to_id?: number }, done: string) => {
    if (openId == null || !selectedIds.length || bulkBusy) return;
    setBulkBusy(true);
    try {
      const data = await ask({ action: 'bulk', id: openId, row_ids: selectedIds, op, ...extra });
      toast(`${done} · ${plural(Number(data.changed) || 0, 'person', 'people')}`);
      addLog(`Bulk ${op} on ${selectedIds.length} people in list #${openId}.`);
      dropDetail(openId);
      if (extra.to_id) dropDetail(extra.to_id);
      clearSelection();
      refreshVisible('pull');
    } catch (e: any) {
      toast(`Not done — ${e?.message || e}`, 'error');
    } finally {
      setBulkBusy(false);
    }
  };
  /* The 3-step follow-up drip for everyone picked (DND numbers are left out by the bridge). */
  async function startBulkDrip() {
    const list = selectedContacts();
    if (!list.length) { toast('Nobody picked has a number (or all are DND)'); return; }
    Alert.alert(
      `Start the drip for ${plural(list.length, 'person', 'people')}?`,
      'Each gets a WhatsApp now, another in 24 hours and a last one in 48 hours — stopped for anyone who replies or answers a call.',
      [{ text: 'Cancel', style: 'cancel' }, {
        text: 'Start', onPress: async () => {
          try {
            const seg = segmentName();
            const steps = DRIP.en.map((m, i) => ({ afterMin: DRIP_STEPS[i].afterMin, message: m.replace(/\{segment\}/g, OFFER).replace(/\{me\}/g, live.current.myName || 'our team') }));   // {name} is filled per person by the bridge
            const r = await wa.startDrip(list, steps);
            if (!r) { toast('Set up the WhatsApp bridge to run drips', 'error'); return; }
            toast(`Drip started for ${plural(r.enrolled, 'person', 'people')}${r.blocked ? ` · ${r.blocked} DND left out` : ''}`);
            clearSelection();
          } catch (e: any) {
            toast(e?.message || String(e), 'error');
          }
        },
      }],
    );
  }

  async function runAssign(clear: boolean) {
    if (openId == null || !selectedIds.length) return;
    setBulkBusy(true);
    try {
      const r = await crm.assign(openId, clear ? [] : assignPick, { row_ids: selectedIds }, clear);
      const names = Object.entries(r.per_agent || {}).map(([d, n]) => `${agents.find((a) => a.device_id === d)?.name || d} ${n}`).join(' · ');
      toast(clear ? `Unassigned ${plural(r.assigned, 'person', 'people')}` : `Shared out: ${names}`);
      dropDetail(openId);
      clearSelection();
      refreshVisible('pull');
    } catch (e: any) {
      toast(`Not done — ${e?.message || e}`, 'error');
    } finally {
      setBulkBusy(false);
    }
  }

  const confirmDelete = () => Alert.alert(
    `Delete ${plural(selectedIds.length, 'person', 'people')}?`,
    'They are removed from this list for everyone. Their calls stay in the call log.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: () => runBulk('delete', {}, 'Deleted') }],
  );

  /* Ghosting reviver: warm leads gone quiet for 3 days, one reactivation message each. */
  async function reviveAll() {
    if (openId == null) return;
    try {
      const data = await ask({ action: 'contacts', id: openId, show: 'ghosting', max: MAX_ATTEMPTS, assigned });
      const seg = segmentName();
      const list: WaContact[] = (data.contacts || []).filter((c: any) => !c.dnd).map((c: any) => ({ id: c.id, name: c.name, phone: c.phone, segment: seg }));
      if (!list.length) { toast('Nobody to revive here'); return; }
      wa.openCampaign(list);
      toast(`Write or keep the message — it goes to ${plural(list.length, 'lead')}`);
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  }

  /* CSV of everything this filter and search show (up to 10,000 people), to the Downloads folder. */
  async function exportCsv() {
    if (openId == null || exporting) return;
    setExporting(true);
    try {
      const all: ImportRow[] = [];
      for (let page = 1; page <= 20; page++) {
        const data = await ask({ action: 'detail', id: openId, page, per_page: 500, sort: 'row', dir: 'asc', q, max: MAX_ATTEMPTS, show: show === 'purchased' ? 'all' : show, buy: show === 'purchased' ? 'yes' : '', assigned }, 60000);
        const got: ImportRow[] = data.rows || [];
        all.push(...got);
        if (got.length < 500) break;
      }
      const pins = all.filter((r) => r.pinned).length;
      const lines = [csvRow(['#', 'Name', 'Phone', 'Email', 'Status', 'Attempts', 'Stage', 'Heat', 'Sentiment', 'Lost reason', 'Best time', 'Callback at', 'WhatsApp at', 'Replied', 'Calls', 'Last call', 'Comment', 'Tags'])]
        .concat(all.map((r, i) => csvRow([
          r.pinned ? '★' : i - pins + 1, r.name, r.phone_raw || r.phone_norm, r.email, rowStatus(r), r.attempts || 0, r.stage || '', r.heat || 0,
          r.sentiment || '', r.lost_reason || '', hourWindow(r.best_hour), r.callback_at || '', r.wa_at || '', r.replied_at ? 'yes' : '', r.total || 0,
          r.last_at || '', r.comment || '', (r.tags || []).join(' '),
        ])));
      const name = `${(openListInfo?.name || 'list').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40)}_${show}_${new Date().toISOString().slice(0, 10)}.csv`;
      const where = await native.saveDownload(name, 'text/csv', lines.join('\n'));
      toast(`${plural(all.length, 'row')} saved to ${where}`);
    } catch (e: any) {
      toast(`Export failed — ${e?.message || e}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  /* Board: a person moved to another stage. */
  const moveStage = useCallback(async (r: ImportRow, stage: Stage) => {
    const number = dialNumber(r) || r.phone_norm;
    const prev = (r.stage || 'new') as Stage;
    try {
      const res = await crm.metaSet(number, { stage });
      patchRows(sameNumber(number), (x) => ({ ...x, ...res.meta }));
      points.celebrate(res.awarded);
      undo.push(`${r.name || 'Lead'} → ${STAGES.find((x) => x.key === stage)?.label}`, () => crm.metaSet(number, { stage: prev }).then((b) => patchRows(sameNumber(number), (x) => ({ ...x, ...b.meta }))));
    } catch (e: any) {
      toast(`Not moved — ${e?.message || e}`, 'error');
    }
  }, [points, undo, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  async function listAction(op: 'merge_lists' | 'split_list', body: any, done: string) {
    const l = listMenu;
    if (!l) return;
    setListMenu(null);
    setListMenuMode('');
    try {
      const d = await ask({ action: op, id: l.id, ...body }, 120000);
      toast(op === 'split_list' ? `${done} · ${d.lists?.length || 0} new lists` : `${done} · ${plural(d.moved || 0, 'person', 'people')} moved`);
      dropDetail(l.id);
      if (body.into_id) dropDetail(body.into_id);
      if (live.current.openId === l.id && op === 'merge_lists') closeList();
      loadLists('pull');
    } catch (e: any) {
      toast(`Not done — ${e?.message || e}`, 'error');
    }
  }

  const pinCount = useMemo(() => rows.filter((r) => r.pinned).length, [rows]);
  const renderPerson = useCallback(({ item, index }: { item: ImportRow; index: number }) => (
    <PersonCard
      r={item}
      index={item.pinned ? 0 : index - pinCount}
      listAt={serverTime(openListInfo?.created_at)}
      onFocus={focus}
      attempts={attemptsOf(item)}
      waAt={waAtOf(item)}
      dialledAt={dialled[item.id]?.at}
      selecting={selecting}
      selected={!!selected[item.id]}
      onToggle={toggle}
      onCall={call}
      onNote={openNote}
      onSchedule={schedule}
      onSms={sms}
      onWhatsApp={whatsapp}
    />
  ), [dialled, attemptsOf, waAtOf, selecting, selected, toggle, call, openNote, schedule, sms, whatsapp, pinCount, focus, openListInfo?.created_at]);

  const autoRow = auto ? rows.find((r) => r.id === auto.ids[auto.pos]) || null : null;
  const prevRow = auto && auto.called > 0 && auto.phase === 'countdown' ? rows.find((r) => r.id === auto.ids[auto.pos - 1]) || null : null;

  return (
    <View style={{ flex: 1 }}>
      {/* Both pages stay mounted, so going back to the lists lands where the counselor was. */}
      <View style={[{ flex: 1 }, openId != null && s.hidden]}>
        <FlatList
          data={shownLists}
          keyExtractor={(l) => String(l.id)}
          renderItem={renderList}
          ListHeaderComponent={listsHeader}
          ListEmptyComponent={listsEmpty}
          contentContainerStyle={s.body}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
          initialNumToRender={6}
          windowSize={7}
        />
      </View>

      {openId != null && view === 'board' && (
        <View style={{ flex: 1 }}>
          <View style={[s.body, { paddingBottom: 0 }]}>{detailHeader}</View>
          <Board listId={openId} ask={ask} onOpen={(r, i) => focus(r, i)} onMove={moveStage} attemptsOf={attemptsOf} />
        </View>
      )}

      {openId != null && view === 'list' && (
        <FlatList
          key={`list-${openId}`}
          data={rows}
          extraData={selected}
          keyExtractor={(r) => String(r.id)}
          renderItem={renderPerson}
          ListHeaderComponent={detailHeader}
          ListEmptyComponent={detailEmpty}
          ListFooterComponent={detailFooter}
          onEndReached={() => loadDetail('more')}
          onEndReachedThreshold={0.6}
          contentContainerStyle={[s.body, (!!auto || selecting) && { paddingBottom: 240 }]}
          keyboardShouldPersistTaps="handled"
          refreshControl={refreshControl}
          initialNumToRender={8}
          maxToRenderPerBatch={10}
          windowSize={9}
          removeClippedSubviews
        />
      )}

      {openId != null && selecting && !auto && (
        <Appear style={s.bulkBar}>
          <View style={s.dialerHead}>
            <Icon name="checklist" size={18} color={t.c.link} />
            <Text style={s.dialerTitle}>{plural(selectedIds.length, 'person', 'people')}</Text>
            <View style={{ flex: 1 }} />
            <IconButton icon="close" label="Stop selecting" size={34} tone="outlined" onPress={clearSelection} />
          </View>
          <View style={s.bulkBtns}>
            <BulkButton icon="play_arrow" label="Dial" color={t.c.success} disabled={!selectedIds.length || bulkBusy} onPress={() => { const ids = selectedIds; clearSelection(); startAuto(ids); }} />
            <BulkButton icon="chat" label="WhatsApp" color={t.c.success} disabled={!selectedIds.length || bulkBusy} onPress={() => wa.openCampaign(selectedContacts())} />
            <BulkButton icon="schedule" label="Drip" color={t.c.blue} disabled={!selectedIds.length || bulkBusy} onPress={startBulkDrip} />
            <BulkButton icon="groups" label="Assign" disabled={!selectedIds.length || bulkBusy || agents.length < 1} onPress={() => { setAssignPick([]); setBulkSheet('assign'); }} />
          </View>
          <View style={s.bulkBtns}>
            <BulkButton icon="sell" label="Status" disabled={!selectedIds.length || bulkBusy} onPress={() => setBulkSheet('status')} />
            <BulkButton icon="drive_file_move" label="Move" disabled={!selectedIds.length || bulkBusy} onPress={() => setBulkSheet('move')} />
            <BulkButton icon="delete_outline" label="Delete" color={t.c.danger} disabled={!selectedIds.length || bulkBusy} onPress={confirmDelete} />
          </View>
        </Appear>
      )}

      <Sheet
        visible={!!bulkSheet}
        onClose={() => setBulkSheet('')}
        title={bulkSheet === 'move' ? `Move ${plural(selectedIds.length, 'person', 'people')} to…`
          : bulkSheet === 'assign' ? `Share out ${plural(selectedIds.length, 'person', 'people')}`
          : `Set status for ${plural(selectedIds.length, 'person', 'people')}`}
        subtitle={bulkSheet === 'move'
          ? 'They leave this list and join the one you pick, with their notes and call history.'
          : bulkSheet === 'assign' ? 'Round robin: the 1st goes to the first person picked, the 2nd to the next… so everyone gets an equal share.'
          : 'The status they count as imported with. A call where someone gets through still moves them on.'}
      >
        {bulkSheet === 'assign' && (
          <View>
            <ChipBar>
              {agents.map((a) => (
                <Chip key={a.device_id} label={`${a.name}${a.device_id === panelDevice() ? ' (me)' : ''}`} selected={assignPick.includes(a.device_id)}
                  onPress={() => setAssignPick(assignPick.includes(a.device_id) ? assignPick.filter((x) => x !== a.device_id) : [...assignPick, a.device_id])} />
              ))}
            </ChipBar>
            <Text style={s.sub}>{assignPick.length ? `About ${num(Math.ceil(selectedIds.length / assignPick.length))} each.` : 'Pick one or more people.'}</Text>
            <View style={s.sheetBtns}>
              <Button label="Unassign" variant="secondary" onPress={() => runAssign(true)} loading={bulkBusy} style={{ flex: 1 }} />
              <Button label="Share out" icon="groups" onPress={() => runAssign(false)} loading={bulkBusy} disabled={!assignPick.length} style={{ flex: 1.4 }} />
            </View>
          </View>
        )}
        {bulkSheet === 'status' && BULK_STATUSES.map((o) => (
          <SettingRow key={o.key} icon={o.icon} title={o.label} onPress={() => runBulk('status', { status: o.key }, `Set to ${o.label}`)} />
        ))}
        {bulkSheet === 'move' && lists.filter((l) => l.id !== openId && l.status === 'ready').map((l) => (
          <SettingRow
            key={l.id}
            icon="format_list_bulleted"
            title={l.name}
            desc={`${num(l.stored_rows || l.total_rows)} people`}
            onPress={() => runBulk('move', { to_id: l.id }, `Moved to ${l.name}`)}
          />
        ))}
        {bulkSheet === 'move' && lists.filter((l) => l.id !== openId && l.status === 'ready').length === 0 && (
          <Text style={s.sub}>There is no other list to move them to.</Text>
        )}
      </Sheet>

      {openId != null && auto && (
        <DialerBar
          auto={auto}
          row={autoRow}
          prev={prevRow}
          prevWaAt={prevRow ? waAtOf(prevRow) : 0}
          onSms={sms}
          onWhatsApp={whatsapp}
          attempts={autoRow ? attemptsOf(autoRow) : 0}
          onPause={() => setAuto({ ...auto, phase: 'paused' })}
          onResume={() => setAuto({ ...auto, phase: 'countdown', at: Date.now() + START_MS })}
          onSkip={() => setAuto({ ...auto, pos: auto.pos + 1, phase: 'countdown', at: Date.now() + START_MS })}
          onCallNow={() => setAuto({ ...auto, at: Date.now() })}
          onNext={() => fnAuto.current.next()}
          onStop={() => stopAuto()}
        />
      )}

      <ImportSheet
        visible={importOpen}
        syncEndpoint={syncEndpoint}
        onClose={() => setImportOpen(false)}
        onImported={(id, name) => {
          toast(`“${name}” imported`);
          addLog(`List #${id} imported from this phone.`);
          loadLists('pull').then(() => {
            const l = live.current.lists.find((x: ImportList) => x.id === id);
            if (l) openList(l);
          });
        }}
      />

      {/* A list's menu: merge it into another (one row per number), or split it into batches. */}
      <Sheet
        visible={!!listMenu}
        onClose={() => { setListMenu(null); setListMenuMode(''); }}
        title={listMenuMode === 'merge' ? `Merge “${listMenu?.name}” into…` : listMenuMode === 'split' ? `Split “${listMenu?.name}”` : listMenu?.name || ''}
        subtitle={listMenuMode === 'merge' ? 'Everyone moves into the list you pick; a number on both lists is kept once, with its notes and missed calls added up. This list is then removed.'
          : listMenuMode === 'split' ? `${num(listMenu?.stored_rows || 0)} people. The first batch stays here; the rest become new lists named “… · batch 2”, “… · batch 3”.` : 'List tools'}
      >
        {!listMenuMode && (
          <>
            <SettingRow icon="merge_type" title="Merge into another list" desc="Deduplicated: one row per number" onPress={() => setListMenuMode('merge')} />
            <SettingRow icon="call_split" title="Split into batches" desc="Smaller lists, e.g. 50 people each" onPress={() => setListMenuMode('split')} />
            {!!listMenu && sheetLinks.some((x) => x.listId === listMenu.id) && (
              <>
                <SettingRow icon="refresh" title="Sync from Google Sheet now" desc="Checked every 2 minutes while the app is open" onPress={() => { const id = listMenu.id; setListMenu(null); runSheetSync(id); }} />
                <SettingRow icon="link_off" title="Stop syncing from the sheet" onPress={() => { const id = listMenu.id; setListMenu(null); unlinkSheet(id); }} />
              </>
            )}
          </>
        )}
        {listMenuMode === 'merge' && lists.filter((l) => l.id !== listMenu?.id && l.status === 'ready').map((l) => (
          <SettingRow key={l.id} icon="format_list_bulleted" title={l.name} desc={`${num(l.stored_rows || l.total_rows)} people`}
            onPress={() => Alert.alert(`Merge into “${l.name}”?`, `“${listMenu?.name}” is removed afterwards.`, [{ text: 'Cancel', style: 'cancel' }, { text: 'Merge', onPress: () => listAction('merge_lists', { into_id: l.id }, 'Merged') }])} />
        ))}
        {listMenuMode === 'split' && [25, 50, 100, 200].filter((n) => (listMenu?.stored_rows || 0) > n).map((n) => (
          <SettingRow key={n} icon="content_cut" title={`Batches of ${n}`} desc={`${Math.ceil((listMenu?.stored_rows || 0) / n)} lists`} onPress={() => listAction('split_list', { size: n }, 'Split')} />
        ))}
      </Sheet>

      {/* Note on one person — the same "Called by / Comment & tags" the admin panel shows */}
      <Sheet
        visible={!!noteRow}
        onClose={() => setNoteRow(null)}
        title={noteRow?.comment || noteRow?.called_by ? 'Edit note' : 'Add a note'}
        subtitle={`${noteRow?.name || 'No name'}${noteRow ? ` · ${prettyPhone(noteRow.phone_norm || noteRow.phone_raw)}` : ''}`}
        footer={
          <View style={s.sheetBtns}>
            <Button label="Cancel" variant="secondary" onPress={() => setNoteRow(null)} style={{ flex: 1 }} />
            <Button label="Save note" icon="check" onPress={saveNote} loading={noteSaving} style={{ flex: 1 }} />
          </View>
        }
      >
        <Field label="Called by" value={noteCaller} onChangeText={setNoteCaller} placeholder="Your name" autoCapitalize="words" maxLength={80} />
        <Field
          label="Comment"
          value={noteComment}
          onChangeText={setNoteComment}
          placeholder="e.g. not interested, call back Monday"
          multiline
          maxLength={1000}
        />
        <Field
          label="Tags"
          value={noteTags}
          onChangeText={setNoteTags}
          placeholder="callback, hot lead"
          autoCapitalize="none"
          hint="Separate tags with commas. Saved straight to the admin panel."
        />
        {noteTagList.length > 0 && (
          <View style={[s.tagRow, { marginTop: space.sm }]}>
            {noteTagList.map((tg, i) => <View key={`${tg}-${i}`} style={s.tag}><Text style={s.tagText}>#{tg}</Text></View>)}
          </View>
        )}
      </Sheet>
    </View>
  );
});

/* ── one list ── */

const ListCard = memo(({ l, index, onOpen, onPowerDial, onMenu, sheet }: { l: ImportList; index: number; onOpen: (l: ImportList, show?: Show) => void; onPowerDial: (l: ImportList) => void; onMenu: (l: ImportList) => void; sheet?: SheetLink }) => {
  const t = useTheme();
  const s = useStyles();
  const people = l.stored_rows || l.total_rows || 0;
  const base = Math.max(1, l.with_phone || people);
  const pct = Math.min(1, (l.called || 0) / base);
  const ready = l.status === 'ready';
  const left = toCall(l);
  const callNow = ready && left > 0;
  const created = serverTime(l.created_at);
  // Pink, blue, amber, purple in turn, so neighbouring lists never look alike.
  const tone = { ...LIST_TONES(t)[index % 4], icon: 'layers' as IconName };
  const state = !ready ? { label: 'Uploading', fg: t.c.warning, bg: t.c.warningSoft }
    : !callNow ? { label: 'Completed', fg: t.c.success, bg: t.c.successSoft }
    : (l.called || 0) === 0 ? { label: 'Not Started', fg: t.status['Not called'].fg, bg: t.status['Not called'].bg }
    : { label: 'In Progress', fg: t.c.blue, bg: t.c.blueSoft };
  return (
    <Appear index={index}>
      <Tactile
        onPress={() => onOpen(l)}
        accessibilityRole="button"
        accessibilityLabel={`Number ${index + 1}: ${l.name}, ${people} people, ${left} to call`}
        android_ripple={{ color: t.c.ripple }}
        style={s.card}
      >
        <View style={s.listHead}>
          <View style={[s.listIcon, { backgroundColor: tone.bg }]}><Icon name={tone.icon} size={22} color={tone.fg} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.listName} numberOfLines={2}>{l.name}</Text>
            <View style={s.metaRow}>
              <IndexBadge n={index + 1} style={{ marginRight: 4 }} />
              <Icon name="groups" size={14} color={t.c.faint} />
              <Text style={s.listMeta}>{num(people)} Contacts</Text>
              <Icon name="event" size={14} color={t.c.faint} style={{ marginLeft: 8 }} />
              <Text style={[s.listMeta, { flexShrink: 1 }]} numberOfLines={1}>{created ? dateOnly(created) : l.file_name}</Text>
            </View>
          </View>
          <Pill label={state.label} fg={state.fg} bg={state.bg} dot pulse={!ready} />
          {ready && <IconButton icon="more_vert" label={`List tools for ${l.name}`} size={32} onPress={() => onMenu(l)} />}
        </View>

        <View style={s.progressRow}>
          <Text style={s.progressLabel}>{num(l.called)} of {num(base)} called</Text>
          <Text style={[s.progressPct, { color: tone.fg }]}>{Math.round(pct * 100)}%</Text>
        </View>
        <ProgressBar value={pct} color={tone.bar} />

        <View style={s.miniStats}>
          <MiniStat label="To call" value={left} color={left ? t.c.danger : t.c.muted} />
          <MiniStat label="Scheduled" value={l.scheduled ?? 0} color={l.scheduled ? t.c.blue : t.c.muted} />
          <MiniStat label="Called" value={l.done ?? l.called} color={t.c.success} />
          <MiniStat label="Purchased" value={l.purchased} color={t.c.violet} />
        </View>

        <View style={s.listActions}>
          <Text style={[s.uploader, sheet?.error ? { color: t.c.danger } : sheet ? { color: t.c.success } : null]} numberOfLines={1}>
            {sheet ? (sheet.error ? `Sheet sync failed · ${sheet.error}` : `↻ Google Sheet · ${sheet.lastAt ? ago(sheet.lastAt) : 'linked'}${sheet.lastAdded ? ` · +${sheet.lastAdded}` : ''}`)
              : l.created_by_name ? `by ${l.created_by_name}` : l.file_name}
          </Text>
          <Button
            label={callNow ? 'Start dialer' : 'Open'}
            icon={callNow ? 'play_arrow' : 'chevron_right'}
            variant={callNow ? 'primary' : 'secondary'}
            size="sm"
            pill
            onPress={() => (callNow ? onPowerDial(l) : onOpen(l, 'all'))}
            accessibilityLabel={`${callNow ? 'Start the power dialer on' : 'Open'} ${l.name}`}
            style={{ minWidth: 118 }}
          />
        </View>
      </Tactile>
    </Appear>
  );
});

const MiniStat = ({ label, value, color }: { label: string; value: number; color?: string }) => {
  const s = useStyles();
  return (
    <View style={s.miniStat}>
      <Text style={[s.miniValue, color ? { color } : null]}>{num(value)}</Text>
      <Text style={s.miniLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
};

/** The auto-dialer's control strip, pinned to the bottom of the list while a run is on. */
/** One action of the floating bulk bar: an icon over its label. */
const BulkButton = ({ icon, label, color, disabled, onPress }: { icon: IconName; label: string; color?: string; disabled?: boolean; onPress: () => void }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tactile onPress={onPress} disabled={disabled} scaleTo={0.92} unstable_pressDelay={0} accessibilityRole="button" accessibilityLabel={label} style={[s.bulkBtn, disabled && { opacity: 0.4 }]}>
      <Icon name={icon} size={22} color={color || t.c.link} />
      <Text style={[s.bulkBtnText, color ? { color } : null]}>{label}</Text>
    </Tactile>
  );
};

const DialerBar = ({ auto, row, prev, prevWaAt, onSms, onWhatsApp, attempts, onPause, onResume, onSkip, onCallNow, onStop, onNext }: {
  onNext: () => void;
  auto: AutoDial;
  row: ImportRow | null;
  /** The person just called — offered a WhatsApp or an SMS while the next call counts down. */
  prev: ImportRow | null;
  prevWaAt: number;
  onSms: (r: ImportRow) => void;
  onWhatsApp: (r: ImportRow) => void;
  attempts: number;
  onPause: () => void;
  onResume: () => void;
  onSkip: () => void;
  onCallNow: () => void;
  onStop: () => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (auto.phase !== 'countdown') return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [auto.phase]);
  const secs = Math.max(0, Math.ceil((auto.at - Date.now()) / 1000));
  const total = auto.ids.length;
  const line = auto.phase === 'paused' ? 'Paused'
    : auto.phase === 'calling' ? 'On the call — the next one waits until it ends'
    : auto.phase === 'wrapup' ? 'Call ended — log the outcome, then the next call starts'
    : auto.called === 0 && auto.pos === 0 ? `Starting in ${secs}s` : `Calling next in ${secs}s`;
  return (
    <Appear style={s.dialer}>
      <View style={s.dialerHead}>
        {auto.phase === 'paused' ? <Icon name="pause" size={16} color={t.c.warning} /> : <PulseDot color={t.c.emerald} />}
        <Text style={s.dialerTitle}>Power dialer</Text>
        <Text style={s.dialerCount}>{Math.min(auto.pos + 1, total)} of {total}</Text>
        <View style={{ flex: 1 }} />
        <IconButton icon="stop" label="Stop the power dialer" size={34} tone="outlined" color={t.c.danger} onPress={onStop} />
      </View>
      <ProgressBar value={total ? auto.pos / total : 0} color={t.c.emerald} />
      {row && (
        <View style={s.dialerWho}>
          <View style={{ flex: 1 }}>
            <Text style={s.personName} numberOfLines={1}>{row.name || 'No name'}</Text>
            <Text style={s.personEmail} numberOfLines={1}>{prettyPhone(row.phone_norm || row.phone_raw)}</Text>
          </View>
          <AttemptBadge n={attempts} max={MAX_ATTEMPTS} />
        </View>
      )}
      <Text style={[s.dialerLine, auto.phase === 'paused' && { color: t.c.warning }]}>{line}</Text>
      {prev && (
        <View style={s.dialerFallback}>
          <Text style={s.dialerFallbackText} numberOfLines={1}>No answer from {prev.name ? prev.name.split(' ')[0] : 'them'}?</Text>
          {prevWaAt > Date.now() - 10 * 60 * 1000 ? (
            <View style={s.dialerSms}>
              <Icon name="check" size={16} color={t.c.success} />
              <Text style={[s.dialerSmsText, { color: t.c.success }]}>WhatsApp sent</Text>
            </View>
          ) : (
            <Pressable onPress={() => onWhatsApp(prev)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Send ${prev.name || 'them'} a WhatsApp`} style={s.dialerSms}>
              <Icon name="chat" size={16} color={t.c.success} />
              <Text style={[s.dialerSmsText, { color: t.c.success }]}>WhatsApp</Text>
            </Pressable>
          )}
          <Pressable onPress={() => onSms(prev)} hitSlop={6} accessibilityRole="button" accessibilityLabel={`Send ${prev.name || 'them'} a quick SMS`} style={s.dialerSms}>
            <Icon name="sms" size={16} color={t.c.violet} />
            <Text style={s.dialerSmsText}>SMS</Text>
          </Pressable>
        </View>
      )}
      <View style={s.dialerBtns}>
        {auto.phase === 'paused'
          ? <Button label="Resume" icon="play_arrow" variant="success" size="sm" pill onPress={onResume} style={{ flex: 1 }} />
          : <Button label="Pause" icon="pause" variant="secondary" size="sm" pill onPress={onPause} style={{ flex: 1 }} />}
        <Button label="Skip" icon="skip_next" variant="secondary" size="sm" pill onPress={onSkip} style={{ flex: 1 }} />
        {auto.phase === 'countdown' && (
          <Button label="Call now" icon="call" variant="success" size="sm" pill onPress={onCallNow} style={{ flex: 1 }} />
        )}
        {auto.phase === 'wrapup' && (
          <Button label="Next" icon="skip_next" size="sm" pill onPress={onNext} style={{ flex: 1 }} />
        )}
      </View>
    </Appear>
  );
};

/** One live count in a list's summary, coloured by what it means; tapping it filters to those people. */
const SummaryPill = ({ label, value, text, extra, color, on, onPress }: { label: string; value?: number; text?: string; extra?: string; color: string; on?: boolean; onPress?: () => void }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tactile
      onPress={onPress}
      scaleTo={0.94}
      unstable_pressDelay={0}
      accessibilityRole="button"
      accessibilityState={{ selected: !!on }}
      accessibilityLabel={`${label}: ${text ?? value}`}
      style={[s.sumPill, on && { borderColor: color, backgroundColor: t.c.surfaceAlt }]}
    >
      <View style={s.sumHead}>
        <View style={[s.sumDot, { backgroundColor: color }]} />
        <Text style={[s.sumLabel, on && { color }]} numberOfLines={1}>{label}</Text>
      </View>
      <Text style={[s.sumValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{text ?? num(value)}</Text>
      {!!extra && <Text style={s.sumExtra} numberOfLines={1}>{extra}</Text>}
    </Tactile>
  );
};

/* ── one person ── */

const PersonCard = memo(({ r, index, listAt, attempts, waAt, dialledAt, selecting, selected, onToggle, onFocus, onCall, onNote, onSchedule, onSms, onWhatsApp }: {
  r: ImportRow;
  /** Its # (0 when pinned — VIPs sit above #1). */
  index: number;
  listAt: number;
  onFocus: (r: ImportRow, index: number) => void;
  attempts: number;
  /** The last WhatsApp to them, from the panel or just sent from this phone. */
  waAt: number;
  dialledAt?: number;
  selecting: boolean;
  selected: boolean;
  onToggle: (r: ImportRow) => void;
  onCall: (r: ImportRow) => void;
  onNote: (r: ImportRow) => void;
  onSchedule: (r: ImportRow) => void;
  onSms: (r: ImportRow) => void;
  onWhatsApp: (r: ImportRow) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const calling = !!dialledAt && Date.now() - dialledAt < 10 * 60 * 1000;
  const waSent = !!waAt && WA_STATUSES.includes(r.status || '');
  const replied = !!r.replied_at && !r.dnd && (!r.reply_ack_at || serverTime(r.reply_ack_at) < serverTime(r.replied_at));
  const status = calling ? 'Calling' : replied ? 'Replied - Priority' : waSent ? 'WhatsApp sent' : rowStatus(r);
  const st = status === 'Replied - Priority' ? { fg: '#FFFFFF', bg: t.c.violet } : t.status[status] || t.status['Not called'];
  const since = waitingSince(r, undefined, listAt);
  const waitMs = since && attempts === 0 ? Date.now() - since : 0;
  const sla = waitMs > 30 * 60 * 1000;
  const review = !!r.phone_raw && (!r.phone_norm || r.phone_norm.length !== 10);
  const offerLeft = serverTime(r.offer_until) - Date.now();
  const heat = r.heat || 0;
  const stage = STAGES.find((x) => x.key === r.stage);
  const canCall = !!dialNumber(r);
  const hasNote = !!r.comment || !!r.called_by;
  const maxed = attempts >= MAX_ATTEMPTS;
  const due = serverTime(r.callback_at);
  const overdue = !!due && due <= Date.now();
  const smsAt = serverTime(r.sms_at);
  // Rang with no answer, or they rang us: a text is the next best thing.
  const unanswered = attempts > 0 && ['needs_callback', 'missed_call', 'not_connected'].includes(r.status || '');
  return (
    <Appear index={index} style={[s.person, maxed && s.personMaxed, sla && s.personSla, replied && s.personReplied, !!r.pinned && s.personPinned, calling && s.personActive, selected && s.personSelected]}>
      <Pressable
        onPress={selecting ? () => onToggle(r) : () => onFocus(r, index + 1)}
        onLongPress={() => onToggle(r)}
        delayLongPress={350}
        accessibilityHint={selecting ? 'Tap to select or unselect' : 'Tap to open the workspace, long-press to select'}
      >
        <View style={s.personTop}>
          {/* The # column (position in the list as filtered and sorted now), and the checkbox when selecting. */}
          <Tactile
            onPress={selecting ? () => onToggle(r) : () => onFocus(r, index + 1)}
            onLongPress={() => onToggle(r)}
            scaleTo={0.88}
            unstable_pressDelay={0}
            accessibilityRole={selecting ? 'checkbox' : 'button'}
            accessibilityState={selecting ? { checked: selected } : undefined}
            accessibilityLabel={`${r.pinned ? 'Pinned' : `Number ${index + 1}`}${selecting ? (selected ? ', selected' : ', not selected') : ', open the workspace'}`}
            style={[s.numBox, !!r.pinned && s.numBoxPinned, selected && s.numBoxOn]}
          >
            {selecting
              ? <Icon name={selected ? 'check_box' : 'check_box_outline_blank'} size={24} color={selected ? t.c.onPrimary : t.c.muted} />
              : r.pinned ? <Icon name="star" size={22} color={t.c.amber} />
              : <Text style={s.numText} numberOfLines={1} adjustsFontSizeToFit>#{index + 1}</Text>}
          </Tactile>
          <Avatar name={r.name} phone={r.phone_norm || r.phone_raw} size={42} />
          <View style={{ flex: 1 }}>
            <Text style={s.personName} numberOfLines={1}>{r.name || 'No name'}</Text>
            <Text style={s.personPhone} selectable>{prettyPhone(r.phone_norm || r.phone_raw) || 'No phone number'}</Text>
            {!!r.email && <Text style={s.personEmail} numberOfLines={1}>{r.email}</Text>}
            <View style={s.badgeRow}>
              <AttemptBadge n={attempts} max={MAX_ATTEMPTS} />
              {heat > 0 && <Pill label={`Heat ${heat}`} icon="local_fire_department" fg={heat >= 70 ? t.c.danger : heat >= 40 ? t.c.orange : t.c.blue} bg={t.c.surfaceAlt} />}
              {!!stage && stage.key !== 'new' && <Pill label={stage.label} fg={t.c.textSoft} bg={t.c.surfaceAlt} />}
              {waitMs > 0 && <Pill label={`Waiting: ${waited(waitMs)}`} icon="timer" fg={sla ? t.c.danger : t.c.warning} bg={sla ? t.c.dangerSoft : t.c.warningSoft} pulse={sla} />}
              {r.best_hour != null && <Pill label={`Best ${hourWindow(r.best_hour)}`} icon="schedule" fg={t.c.success} bg={t.c.successSoft} />}
              {(r.inbound_missed || 0) > 1 && <Pill label={`Missed ${r.inbound_missed}×`} icon="phone_missed" fg={t.c.danger} bg={t.c.dangerSoft} />}
              {offerLeft > 0 && <Pill label={`Offer ${waited(offerLeft)} left`} icon="timer" fg={t.c.warning} bg={t.c.warningSoft} />}
              {review && <Pill label="Needs review" icon="warning_amber" fg={t.c.warning} bg={t.c.warningSoft} />}
              {!!r.dnd && <Pill label="DND" icon="block" fg="#FFFFFF" bg={t.c.coral} />}
              {!!r.assigned_to && <Pill label={r.assigned_to === panelDevice() ? 'Mine' : `→ ${agentName(r.assigned_to)}`} icon="person_outline" fg={t.c.link} bg={t.c.primarySoft} />}
              {!!smsAt && <Pill label={`SMS ${ago(smsAt)}${(r.sms_count || 0) > 1 ? ` · ${r.sms_count}×` : ''}`} icon="sms" fg={t.c.violet} bg={t.c.violetSoft} />}
              {!!waAt && <Pill label={`WhatsApp ${ago(waAt)}${(r.wa_count || 0) > 1 ? ` · ${r.wa_count}×` : ''}`} icon="chat" fg={t.c.success} bg={t.c.successSoft} />}
              {!!due && (
                <Pill
                  label={overdue ? `Due ${dueIn(due)}` : callbackTime(due)}
                  icon="alarm"
                  fg={overdue ? t.c.danger : t.c.blue}
                  bg={overdue ? t.c.dangerSoft : t.c.blueSoft}
                />
              )}
            </View>
          </View>
          <View style={{ alignItems: 'flex-end', gap: 6 }}>
            <Pill label={calling ? 'Calling…' : status} fg={st.fg} bg={st.bg} dot pulse={calling} dotColor={calling ? t.c.emerald : undefined} />
            <Text style={s.rowNo}>Row {r.row_no}</Text>
          </View>
        </View>

        {replied && !!r.reply_text && (
          <View style={s.replyLine}>
            <Icon name="chat_bubble_outline" size={15} color={t.c.violet} />
            <Text style={s.replyText} numberOfLines={2}>“{r.reply_text}” · {ago(serverTime(r.replied_at))}</Text>
          </View>
        )}
        {(r.total || 0) > 0 && (
          <View style={s.callsLine}>
            <Icon name="history" size={15} color={t.c.muted} />
            <Text style={s.personCalls} numberOfLines={2}>
              {plural(r.total || 0, 'call')} · {talk(r.talk_sec)} talk · last {ago(serverTime(r.last_at))}
              {r.last_outcome ? ` · ${r.last_outcome}` : ''}
            </Text>
          </View>
        )}

        {(!!r.comment || (r.tags || []).length > 0 || !!r.called_by || r.bought > 0) && (
          <View style={s.noteBox}>
            {!!r.comment && <Text style={s.noteText}>“{r.comment}”</Text>}
            <View style={s.tagRow}>
              {!!r.called_by && <View style={s.tag}><Icon name="person_outline" size={12} color={t.c.muted} /><Text style={s.tagText}>{r.called_by}</Text></View>}
              {(r.tags || []).map((tg) => <View key={tg} style={s.tag}><Text style={s.tagText}>#{tg}</Text></View>)}
              {r.bought > 0 && (
                <View style={[s.tag, { backgroundColor: t.c.violetSoft }]}>
                  <Icon name="shopping_bag" size={12} color={t.c.violet} />
                  <Text style={[s.tagText, { color: t.c.violet }]}>Purchased{r.bought_item ? ` · ${r.bought_item}` : ''}</Text>
                </View>
              )}
            </View>
          </View>
        )}

        <View style={s.personActions}>
          <IconButton icon="edit_note" label={hasNote ? 'Edit note' : 'Add a note'} size={36} tone={hasNote ? 'soft' : 'outlined'} onPress={() => onNote(r)} />
          <IconButton
            icon="sms"
            label={`Send a quick SMS to ${r.name || prettyPhone(r.phone_norm)}`}
            size={36}
            tone={unanswered ? 'soft' : 'outlined'}
            color={unanswered ? t.c.violet : undefined}
            disabled={!canCall}
            onPress={() => onSms(r)}
          />
          <IconButton
            icon="chat"
            label={`Send a WhatsApp to ${r.name || prettyPhone(r.phone_norm)}`}
            size={36}
            tone="soft"
            color={unanswered && !waSent ? t.c.success : '#16A34A'}
            disabled={!canCall || !!r.dnd}
            onPress={() => onWhatsApp(r)}
          />
          {/* An icon, so five actions fit a small phone; the time set shows in the pill above. */}
          <IconButton
            icon="alarm"
            label={`${due ? 'Reschedule the' : 'Schedule a'} callback for ${r.name || prettyPhone(r.phone_norm)}`}
            size={36}
            tone={due ? 'soft' : 'outlined'}
            color={due ? t.c.blue : undefined}
            disabled={!canCall}
            onPress={() => onSchedule(r)}
          />
          <Tactile
            onPress={() => onCall(r)}
            disabled={!canCall}
            scaleTo={0.88}
            unstable_pressDelay={0}
            accessibilityRole="button"
            accessibilityLabel={`Call ${r.name || prettyPhone(r.phone_norm)}`}
            style={[s.callRound, !canCall && { opacity: 0.4 }]}
          >
            <Icon name="call" size={20} color={t.c.success} />
          </Tactile>
        </View>
      </Pressable>
    </Appear>
  );
});

/* Agent names for the "→ Ravi" pill, filled once the team is read. */
let agentNames: { [device: string]: string } = {};
const agentName = (d: string) => agentNames[d] || d.slice(0, 8);

/** The deal fields of a row, as the Focus workspace takes them. */
const rowMeta = (r: ImportRow): Meta => ({
  ...EMPTY_META,
  stage: (r.stage || '') as Meta['stage'], sentiment: (r.sentiment || '') as Meta['sentiment'], bant: r.bant || 0, heat: r.heat || 0,
  lost_reason: (r.lost_reason || '') as Meta['lost_reason'], offer_until: r.offer_until || null, dnd: r.dnd || 0,
  replied_at: r.replied_at || null, reply_text: r.reply_text || '', reply_ack_at: r.reply_ack_at || null,
});

/** Since when a lead still owed a call has been waiting: when they called us, else since the list came in. */
function waitingSince(r: ImportRow, listCreated?: string | null, listAt?: number): number {
  if (!['needs_callback', 'missed_call', 'not_called'].includes(r.status || '')) return 0;
  return serverTime(r.lead_at) || listAt || serverTime(listCreated) || 0;
}

const hm = (sec: number) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;

/* ── Board: one column per deal stage; ◀ ▶ move a lead along ── */
const Board = ({ listId, ask, onOpen, onMove, attemptsOf }: {
  listId: number;
  ask: (body: any, ms?: number) => Promise<any>;
  onOpen: (r: ImportRow, index: number) => void;
  onMove: (r: ImportRow, stage: Stage) => Promise<void>;
  attemptsOf: (r: ImportRow) => number;
}) => {
  const t = useTheme();
  const s = useStyles();
  const [cols, setCols] = useState<{ [k: string]: { rows: ImportRow[]; total: number } }>({});
  const [loading, setLoading] = useState<boolean>(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const got = await Promise.all(STAGES.map((st) => ask({ action: 'detail', id: listId, page: 1, per_page: 100, sort: 'row', dir: 'asc', show: `stage_${st.key}`, max: MAX_ATTEMPTS })
        .then((d) => [st.key, { rows: d.rows || [], total: Number(d.total) || 0 }] as const).catch(() => [st.key, { rows: [], total: 0 }] as const)));
      setCols(Object.fromEntries(got));
    } finally {
      setLoading(false);
    }
  }, [listId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);

  const move = async (r: ImportRow, from: number, dir: -1 | 1) => {
    const to = STAGES[from + dir];
    if (!to) return;
    // Moves on the board at once; the panel catches up.
    setCols((c) => {
      const a = c[STAGES[from].key]; const b = c[to.key];
      return { ...c, [STAGES[from].key]: { rows: a.rows.filter((x) => x.id !== r.id), total: a.total - 1 }, [to.key]: { rows: [{ ...r, stage: to.key }, ...b.rows], total: b.total + 1 } };
    });
    await onMove(r, to.key);
  };

  return (
    <ScrollView horizontal contentContainerStyle={s.board} showsHorizontalScrollIndicator={false}>
      {STAGES.map((st, ci) => {
        const col = cols[st.key] || { rows: [], total: 0 };
        const color = (t.c as any)[st.color] || t.c.muted;
        return (
          <View key={st.key} style={s.col}>
            <View style={s.colHead}>
              <View style={[s.sumDot, { backgroundColor: color }]} />
              <Text style={s.colTitle}>{st.label}</Text>
              <Text style={s.colCount}>{num(col.total)}</Text>
            </View>
            {loading && !col.rows.length ? <ActivityIndicator color={t.c.primary} /> : null}
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 8, paddingBottom: 40 }}>
              {col.rows.map((r, i) => (
                <Pressable key={r.id} onPress={() => onOpen(r, i + 1)} style={s.boardCard} accessibilityRole="button">
                  <View style={s.boardTop}>
                    <Text style={s.boardNum}>#{i + 1}</Text>
                    <Text style={s.boardName} numberOfLines={1}>{r.name || prettyPhone(r.phone_norm)}</Text>
                    {(r.heat || 0) > 0 && <Text style={[s.boardHeat, { color: (r.heat || 0) >= 70 ? t.c.danger : t.c.orange }]}>🔥{r.heat}</Text>}
                  </View>
                  <Text style={s.boardMeta} numberOfLines={1}>{prettyPhone(r.phone_norm || r.phone_raw)} · {attemptsOf(r)}/{MAX_ATTEMPTS} tries</Text>
                  <View style={s.boardMove}>
                    <IconButton icon="chevron_left" label={`Move back to ${STAGES[ci - 1]?.label || ''}`} size={30} tone="outlined" disabled={ci === 0} onPress={() => move(r, ci, -1)} />
                    <View style={{ flex: 1 }} />
                    <IconButton icon="chevron_right" label={`Move on to ${STAGES[ci + 1]?.label || ''}`} size={30} tone="outlined" disabled={ci === STAGES.length - 1} onPress={() => move(r, ci, 1)} />
                  </View>
                </Pressable>
              ))}
              {!loading && !col.rows.length && <Text style={s.colEmpty}>Nobody here</Text>}
              {col.total > col.rows.length && <Text style={s.colEmpty}>+{num(col.total - col.rows.length)} more — use the list view</Text>}
            </ScrollView>
          </View>
        );
      })}
    </ScrollView>
  );
};

export default memo(ImportsScreen);

const useStyles = makeStyles((t) => ({
  body: { padding: space.lg, paddingBottom: space.xxxl },
  hidden: { display: 'none' },

  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  h1: { ...type.display, color: t.c.text },
  h2: { ...type.title, color: t.c.text },
  sub: { ...type.caption, color: t.c.muted, marginTop: 2 },
  bento: { flexDirection: 'row', gap: space.sm, marginTop: space.lg, marginBottom: space.lg },

  card: {
    backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.lg, marginBottom: space.md, ...elevation(t),
  },
  listHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  listIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  listName: { ...type.cardTitle, color: t.c.text },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  listMeta: { fontSize: 12.5, color: t.c.muted, fontWeight: '500' },
  uploader: { flex: 1, fontSize: 12, color: t.c.faint },

  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.lg, marginBottom: 7 },
  progressLabel: { fontSize: 12.5, color: t.c.textSoft, fontWeight: '600' },
  progressPct: { fontSize: 12.5, color: t.c.link, fontWeight: '700' },

  miniStats: { flexDirection: 'row', marginTop: space.lg, backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, paddingVertical: 10 },
  miniStat: { flex: 1, alignItems: 'center', paddingHorizontal: 2 },
  miniValue: { fontSize: 16, fontWeight: '800', color: t.c.text, fontVariant: ['tabular-nums'] },
  miniLabel: { fontSize: 11, color: t.c.muted, marginTop: 2 },

  listActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: space.md },

  detailHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: space.lg },
  summary: { flexDirection: 'row', gap: 6, marginBottom: space.md },
  sumPill: {
    flexBasis: '31%', flexGrow: 1, backgroundColor: t.c.surface, borderRadius: radius.lg, borderWidth: 1.5, borderColor: 'transparent', ...elevation(t),
    paddingHorizontal: 9, paddingVertical: 9,
  },
  sumHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  sumDot: { width: 7, height: 7, borderRadius: 4 },
  sumLabel: { flexShrink: 1, fontSize: 11, fontWeight: '700', color: t.c.muted },
  sumValue: { ...type.metric, fontSize: 19, marginTop: 4 },

  person: {
    backgroundColor: t.c.surface, borderRadius: radius.xl, borderWidth: 1, borderColor: 'transparent',
    padding: 14, marginBottom: 10, ...elevation(t),
  },
  callRound: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.c.successSoft, alignItems: 'center', justifyContent: 'center' },
  personActive: { borderColor: t.c.emerald, backgroundColor: t.c.successSoft },
  personTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  numBox: { width: 34, height: 34, borderRadius: 10, backgroundColor: t.c.primarySoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  numText: { fontSize: 12.5, fontWeight: '800', color: t.c.link, fontVariant: ['tabular-nums'] },
  rowNo: { fontSize: 11, color: t.c.faint, fontWeight: '600' },
  personName: { fontSize: 15, fontWeight: '600', color: t.c.text },
  personPhone: { fontSize: 14, color: t.c.textSoft, marginTop: 3, letterSpacing: 0.2 },
  personEmail: { fontSize: 12, color: t.c.muted, marginTop: 2 },
  callsLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, marginLeft: 98 },
  personCalls: { flex: 1, fontSize: 12, color: t.c.muted },
  noteBox: { marginTop: 10, marginLeft: 98, backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 10 },
  noteText: { fontSize: 13, color: t.c.textSoft, fontStyle: 'italic', marginBottom: 6, lineHeight: 18 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3 },
  tagText: { fontSize: 11.5, color: t.c.textSoft, fontWeight: '600' },
  personActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  personMaxed: { borderColor: t.c.coral, borderWidth: 1.5 },
  personSla: { borderColor: t.c.danger, borderWidth: 2, backgroundColor: t.c.dangerSoft },
  personReplied: { borderColor: t.c.violet, borderWidth: 2 },
  personPinned: { borderColor: t.c.amber, borderWidth: 1.5 },
  numBoxPinned: { backgroundColor: t.c.warningSoft, borderColor: t.c.amber },
  replyLine: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, marginLeft: 98 },
  replyText: { flex: 1, fontSize: 12.5, color: t.c.violet, fontWeight: '600' },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.md },
  sumExtra: { fontSize: 10.5, color: t.c.muted, marginTop: 1 },
  personSelected: { borderColor: t.c.primary, borderWidth: 1.5, backgroundColor: t.c.primarySoft },
  numBoxOn: { backgroundColor: t.c.primary, borderColor: t.c.primary },
  selectRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.md },
  selectText: { ...type.overline, color: t.c.link },
  selectLink: { fontSize: 13, fontWeight: '700', color: t.c.link },
  bulkBar: {
    position: 'absolute', left: space.md, right: space.md, bottom: space.md, gap: 10,
    backgroundColor: t.c.surface, borderRadius: radius.xl, borderWidth: 1.5, borderColor: t.c.primary, padding: 14,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 4 },
  },
  bulkBtns: { flexDirection: 'row', gap: 8 },
  bulkBtn: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: radius.md, backgroundColor: t.c.surfaceAlt },
  bulkBtnText: { fontSize: 12, fontWeight: '700', color: t.c.link },
  dialerSms: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 8, borderRadius: radius.pill, backgroundColor: t.c.surfaceAlt },
  dialerFallback: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dialerFallbackText: { flex: 1, fontSize: 12.5, fontWeight: '600', color: t.c.textSoft },
  selectAll: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.md },
  firstLabel: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginBottom: 6 },
  customRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: -6, marginBottom: space.sm },
  dialerSmsText: { fontSize: 12.5, fontWeight: '700', color: t.c.violet },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },

  dialer: {
    position: 'absolute', left: space.md, right: space.md, bottom: space.md, gap: 10,
    backgroundColor: t.c.surface, borderRadius: radius.xl, borderWidth: 1.5, borderColor: t.c.emerald, padding: 14,
    elevation: 8, shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 4 },
  },
  dialerHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dialerTitle: { ...type.heading, color: t.c.text },
  dialerCount: { fontSize: 12.5, fontWeight: '700', color: t.c.muted, fontVariant: ['tabular-nums'] },
  dialerWho: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dialerLine: { fontSize: 12.5, fontWeight: '600', color: t.c.success },
  dialerBtns: { flexDirection: 'row', gap: 8 },

  footer: { alignItems: 'center', paddingVertical: space.lg },
  board: { paddingHorizontal: space.lg, paddingBottom: space.lg, gap: 10 },
  col: { width: 270, backgroundColor: t.c.surfaceAlt, borderRadius: radius.lg, padding: 10 },
  colHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  colTitle: { flex: 1, fontSize: 13.5, fontWeight: '800', color: t.c.text },
  colCount: { fontSize: 12.5, fontWeight: '700', color: t.c.muted },
  colEmpty: { fontSize: 12, color: t.c.faint, textAlign: 'center', paddingVertical: 10 },
  boardCard: { backgroundColor: t.c.surface, borderRadius: radius.md, borderWidth: 1, borderColor: t.c.border, padding: 10 },
  boardTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  boardNum: { fontSize: 12, fontWeight: '800', color: t.c.muted },
  boardName: { flex: 1, fontSize: 14, fontWeight: '600', color: t.c.text },
  boardHeat: { fontSize: 12, fontWeight: '800' },
  boardMeta: { fontSize: 12, color: t.c.muted, marginTop: 3 },
  boardMove: { flexDirection: 'row', marginTop: 8 },
  footerText: { fontSize: 12, color: t.c.muted },

  sheetBtns: { flexDirection: 'row', gap: 10, marginTop: space.lg },
}));
