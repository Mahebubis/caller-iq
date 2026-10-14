import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, NativeModules, Pressable, RefreshControl, Text, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from './theme';
import { errorKind, panelAsk, panelDevice } from './api';
import { ago, callbackTime, dueIn, last10, num, plural, prettyPhone, serverTime } from './format';
import {
  AttemptBadge, Banner, Button, Chip, ChipBar, EmptyState, Icon, IconButton, IconName, IndexBadge, Pill, SearchField, Segmented, SectionHeader,
  SkeletonCard,
} from './ui';
import { MAX_ATTEMPTS, ScheduleTarget, SmsTarget } from './types';
import type { ImportList, Show } from './ImportsScreen';

const { CallBridge } = NativeModules;

/*
 * Every call still owed, in one place.
 *
 *  - All phones (default): the whole team's callbacks from the panel (api/caller-iq/callbacks.php)
 *    over a date window, like the panel's Call log filtered to "Callback: Pending" — so any one
 *    phone can work through everyone's missed calls. Getting through from ANY phone clears a
 *    number for everyone.
 *  - This phone: worked out from this phone's own call log; needs no internet.
 *  - From calling lists: people imported as "Needs callback", "Missed call" or "Pending follow-up"
 *    nobody has spoken to yet (they arrive with the team's list), and people on the admin's lists
 *    who were called but never connected.
 *
 * "Hide" only hides a number on this phone, until it is owed again.
 */

export interface CallbackCall {
  number: string;
  callType: string;
  duration: number;
  timestamp: number;
  outcome?: string;
}

type Reason = 'missed' | 'callback' | 'no_answer' | 'imported' | 'scheduled';

export interface Owed {
  key: string;          // last 10 digits
  number: string;
  name?: string;
  agent?: string;       // whose phone it is owed on (All phones)
  segment?: string;     // the calling list the number is on
  importStatus?: string;
  dueAt?: number;       // a callback time someone set (reason 'scheduled')
  note?: string;
  mine?: boolean;       // that time was set on this phone, so this phone rings for it
  smsAt?: number;       // the last quick SMS sent to them
  smsCount?: number;
  reason: Reason;
  since: number;        // when it became owed
  lastAt: number;       // newest event for the number
  missed: number;
  tries: number;
}

type Since = 'today' | '7' | '15' | '30' | 'all';
const SINCE: { key: Since; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7', label: '7 days' },
  { key: '15', label: '15 days' },
  { key: '30', label: '30 days' },
  { key: 'all', label: 'All time' },
];

const SCOPES = [
  { key: 'team', label: 'All phones', icon: 'groups' },
  { key: 'phone', label: 'This phone', icon: 'smartphone' },
] as const;

interface Props {
  active: boolean;
  syncEndpoint: string;
  calls: CallbackCall[];
  lists: ImportList[];
  onDial: (n: string) => void;
  onOpenList: (id: number, show: Show) => void;
  /** How many calls are owed, for the tab badge. */
  onCount?: (n: number) => void;
  /** Everything owed right now, for the Calls tab's live feed. */
  onItems?: (items: Owed[]) => void;
  onSchedule: (t: ScheduleTarget) => void;
  onSms: (t: SmsTarget) => void;
  /** Bumped when a callback time was set or cleared, so the team's list is read again. */
  reloadSignal: number;
}

const CACHE_DONE = 'callbacks_done_v1';
const CACHE_TEAM = 'callbacks_team_v1';
const STALE_MS = 30 * 1000;
const POLL_MS = 60 * 1000;
const CALLBACK_TAGS = ['Callback Scheduled'];
const NO_ANSWER_TAGS = ['Not Answering'];

const isMissed = (tp: string) => tp === 'MISSED' || tp === 'REJECTED' || tp === 'BLOCKED';

/** This phone only: walks each number's calls oldest → newest; whatever is still owed is a callback. */
export const pendingCallbacks = (calls: CallbackCall[]): Owed[] => {
  const byNumber = new Map<string, CallbackCall[]>();
  calls.forEach((c) => {
    const k = last10(c?.number);
    if (!k) return;
    if (!byNumber.has(k)) byNumber.set(k, []);
    byNumber.get(k)!.push(c);
  });
  const out: Owed[] = [];
  byNumber.forEach((list, key) => {
    list.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    let p: Owed | null = null;
    const rank: { [k in Reason]: number } = { imported: 0, missed: 1, no_answer: 2, callback: 3, scheduled: 4 };
    list.forEach((c) => {
      const tag = c.outcome || '';
      const why: Reason | null = CALLBACK_TAGS.includes(tag) ? 'callback'
        : NO_ANSWER_TAGS.includes(tag) ? 'no_answer'
        : c.duration > 0 ? null
        : isMissed(c.callType) ? 'missed' : null;
      if (why) {
        if (!p) p = { key, number: c.number, reason: why, since: c.timestamp, lastAt: c.timestamp, missed: 0, tries: 0 };
        else if (rank[why] >= rank[p.reason]) p.reason = why;
        p.lastAt = c.timestamp;
        if (why === 'missed') p.missed++;
      } else if (c.duration > 0) {
        p = null;                                   // spoke to them: nothing owed
      } else if (p) {
        p.tries++;                                  // rang back, no answer
        p.lastAt = c.timestamp;
      }
    });
    if (p) out.push(p);
  });
  return out.sort((a, b) => b.lastAt - a.lastAt);
};

const REASON_ICON: { [k in Reason]: IconName } = {
  missed: 'phone_missed', callback: 'event', no_answer: 'phone_disabled', imported: 'format_list_bulleted', scheduled: 'alarm',
};
const REASON_LABEL: { [k in Reason]: string } = {
  missed: 'Missed call', callback: 'Callback scheduled', no_answer: 'Not answering', imported: 'From a list', scheduled: 'Scheduled',
};
const IMPORTED_LABEL: { [k: string]: string } = { needs_callback: 'Needs callback', missed_call: 'Missed call', pending_followup: 'Follow-up' };

const CallbacksScreen = ({ active, syncEndpoint, calls, lists, onDial, onOpenList, onCount, onItems, onSchedule, onSms, reloadSignal }: Props) => {
  const t = useTheme();
  const s = useStyles();
  const [scope, setScope] = useState<'team' | 'phone'>('team');
  const [since, setSince] = useState<Since>('30');
  const [query, setQuery] = useState<string>('');
  const [done, setDone] = useState<{ [k: string]: number }>({});

  const [team, setTeam] = useState<{ since: Since; at: number; items: Owed[] } | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [errKind, setErrKind] = useState<string>('');
  const [pulling, setPulling] = useState<boolean>(false);
  const inFlight = useRef<string>('');
  const fails = useRef<{ n: number; at: number }>({ n: 0, at: 0 });

  const live = useRef<any>({});
  live.current = { active, since, team };

  const loadTeam = async (mode: 'open' | 'silent' | 'retry', sn: Since = live.current.since) => {
    if (inFlight.current === sn) return;
    // Missing or failing on the panel: not asked again every minute, only on Retry / pull.
    const f = fails.current;
    if (mode === 'silent' && f.n > 0 && Date.now() - f.at < Math.min(5 * 60 * 1000, 30 * 1000 * 2 ** (f.n - 1))) return;
    inFlight.current = sn;
    const cur = live.current.team;
    if (mode !== 'silent' && !(cur && cur.since === sn)) setLoading(true);
    try {
      const data = await panelAsk('callbacks.php', { action: 'list', since: sn }, syncEndpoint);
      const seen = new Set<string>();
      const items: Owed[] = [];
      (Array.isArray(data.callbacks) ? data.callbacks : []).forEach((x: any) => {
        const key = last10(x.number);
        if (!key || seen.has(key)) return;
        seen.add(key);
        items.push({
          key,
          number: x.number,
          name: x.name || '',
          agent: x.agent || '',
          segment: x.segment || '',
          importStatus: x.import_status || '',
          dueAt: serverTime(x.due_at) || undefined,
          note: x.note || '',
          mine: !!x.sched_device && x.sched_device === panelDevice(),
          smsAt: serverTime(x.sms_at) || undefined,
          smsCount: Number(x.sms_count) || 0,
          reason: (REASON_LABEL[x.reason as Reason] ? x.reason : 'missed') as Reason,
          since: serverTime(x.since_at),
          lastAt: serverTime(x.last_at),
          missed: Number(x.missed) || 0,
          tries: Number(x.tries) || 0,
        });
      });
      fails.current = { n: 0, at: 0 };
      if (live.current.since !== sn) return;             // the counselor picked another window meanwhile
      const next = { since: sn, at: Date.now(), items };
      setTeam(next);
      setError('');
      if (sn === '30') CallBridge?.saveUiCache?.(CACHE_TEAM, JSON.stringify(next));
    } catch (e: any) {
      fails.current = { n: fails.current.n + 1, at: Date.now() };
      if (live.current.since === sn) { setError(e?.message || String(e)); setErrKind(errorKind(e)); }
    } finally {
      if (inFlight.current === sn) inFlight.current = '';
      setLoading(false);
    }
  };
  const fn = useRef<any>({});
  fn.current = { loadTeam };

  // Saved copies first, so the tab is never empty while the panel answers.
  useEffect(() => {
    CallBridge?.loadUiCache?.(CACHE_DONE).then((raw: string) => {
      try { if (raw) setDone(JSON.parse(raw) || {}); } catch (_) {}
    }).catch(() => {});
    CallBridge?.loadUiCache?.(CACHE_TEAM).then((raw: string) => {
      try {
        const saved = raw ? JSON.parse(raw) : null;
        if (saved && Array.isArray(saved.items) && !live.current.team) setTeam({ ...saved, at: 0 });
      } catch (_) {}
    }).catch(() => {});
    // Read once at launch too, so the tab badge counts the whole team's callbacks.
    fn.current.loadTeam('silent', '30');
  }, []);

  // Opening the tab or changing the window: refresh what is out of date.
  useEffect(() => {
    if (!active) return;
    const cur = live.current.team;
    if (!cur || cur.since !== since) fn.current.loadTeam('open', since);
    else if (Date.now() - cur.at > STALE_MS) fn.current.loadTeam('silent', since);
  }, [active, since]);

  // A callback time was just set or cleared somewhere in the app.
  useEffect(() => {
    if (reloadSignal) fn.current.loadTeam('retry');
  }, [reloadSignal]);

  // While the tab is open: a quiet look once a minute, and on coming back from the dialer.
  useEffect(() => {
    if (!active) return undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const iv = setInterval(() => { if (AppState.currentState === 'active') fn.current.loadTeam('silent'); }, POLL_MS);
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') timers.push(setTimeout(() => fn.current.loadTeam('silent'), 6000));   // time for the call to upload
    });
    return () => { clearInterval(iv); sub.remove(); timers.forEach(clearTimeout); };
  }, [active]);

  const phoneItems = useMemo(() => pendingCallbacks(calls), [calls]);
  const teamItems = team && team.since === since ? team.items : null;

  const shown = useMemo(() => {
    const items = scope === 'team' ? teamItems || [] : phoneItems;
    const q = query.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    const out = items.filter((o) => {
      if (done[o.key] >= o.lastAt) return false;
      if (!q) return true;
      return (qd.length >= 3 && o.key.includes(qd))
        || (o.name || '').toLowerCase().includes(q)
        || (o.agent || '').toLowerCase().includes(q)
        || (o.segment || '').toLowerCase().includes(q);
    });
    // Callback times lead, soonest (or most overdue) first.
    return out.sort((a, b) => (a.dueAt ? 0 : 1) - (b.dueAt ? 0 : 1) || (a.dueAt || 0) - (b.dueAt || 0));
  }, [scope, teamItems, phoneItems, query, done]);

  // Badge and live feed: the team's 30-day list when the panel has answered, else this phone's.
  useEffect(() => {
    const tm = team && team.since === '30' ? team.items : null;
    const owed = (tm || phoneItems).filter((o) => !(done[o.key] >= o.lastAt));
    onCount?.(owed.length);
    onItems?.(owed);
  }, [team, phoneItems, done]); // eslint-disable-line react-hooks/exhaustive-deps

  const hide = useCallback((o: Owed) => {
    setDone((d) => {
      const next = { ...d, [o.key]: Math.max(Date.now(), o.lastAt) };
      CallBridge?.saveUiCache?.(CACHE_DONE, JSON.stringify(next));
      return next;
    });
  }, []);

  const fromLists = useMemo(() => lists
    .map((l) => ({ l, n: Math.max(0, (l.reached || 0) - (l.connected || 0)) }))
    .filter((x) => x.n > 0), [lists]);

  const onPull = async () => {
    setPulling(true);
    try { await loadTeam('retry'); } finally { setPulling(false); }
  };

  const renderItem = useCallback(({ item, index }: { item: Owed; index: number }) => (
    <OwedCard o={item} index={index} onDial={onDial} onHide={hide} onSchedule={onSchedule} onSms={onSms} />
  ), [onDial, hide, onSchedule, onSms]);

  const header = (
    <View>
      <View style={s.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.h1} accessibilityRole="header">Callbacks</Text>
          <Text style={s.sub}>
            {scope === 'team'
              ? `Every phone · ${team?.at ? `updated ${ago(team.at)}` : 'saved copy'}`
              : 'From this phone’s call log — works offline'}
          </Text>
        </View>
        {loading && !!teamItems && <ActivityIndicator size="small" color={t.c.primary} />}
      </View>

      <Segmented options={SCOPES} value={scope} onChange={setScope} style={{ marginTop: space.lg }} />

      {scope === 'team' && (
        <ChipBar>
          {SINCE.map((x) => <Chip key={x.key} label={x.label} selected={since === x.key} onPress={() => setSince(x.key)} />)}
        </ChipBar>
      )}

      <SearchField value={query} onChangeText={setQuery} placeholder={scope === 'team' ? 'Search number, name or agent' : 'Search number'} />

      {scope === 'team' && !!error && (
        <Banner
          tone={errKind === 'offline' || errKind === 'timeout' ? 'warning' : 'danger'}
          icon={errKind === 'offline' ? 'wifi_off' : errKind === 'missing' || errKind === 'outdated' ? 'dns' : 'error_outline'}
          title={errKind === 'missing' || errKind === 'outdated' ? 'Team callbacks aren’t on the panel yet' : undefined}
          message={`${error}${errKind === 'missing' || errKind === 'outdated' ? ' “This phone” still works meanwhile.' : ''}`}
          actionLabel="Retry"
          actionBusy={loading}
          onAction={() => loadTeam('retry')}
        />
      )}

      <Text style={s.count}>{plural(shown.length, 'callback')} pending</Text>
    </View>
  );

  const empty = scope === 'team' && loading && !teamItems ? (
    <View>{[0, 1, 2].map((i) => <SkeletonCard key={i} lines={2} />)}</View>
  ) : scope === 'team' && !teamItems && error ? null : (
    <EmptyState
      icon={query ? 'search' : 'task_alt'}
      tone={query ? 'primary' : 'success'}
      title={query ? `Nothing matches “${query}”` : 'You’re all caught up'}
      body={query ? undefined : 'Missed calls nobody has returned, and calls tagged “Callback Scheduled” or “Not Answering”, show up here.'}
      actionLabel={query ? 'Clear search' : undefined}
      onAction={() => setQuery('')}
    />
  );

  const footer = fromLists.length > 0 ? (
    <View style={{ marginTop: space.lg }}>
      <SectionHeader title="From calling lists" />
      <Text style={[s.sub, { marginTop: -4, marginBottom: space.md }]}>Called, but nobody picked up yet</Text>
      {fromLists.map(({ l, n }) => (
        <Pressable
          key={l.id}
          onPress={() => onOpenList(l.id, 'not_connected')}
          accessibilityRole="button"
          accessibilityLabel={`${l.name}: ${n} not connected. Open list`}
          android_ripple={{ color: t.c.ripple }}
          style={({ pressed }) => [s.card, s.row, pressed && { opacity: 0.9 }]}
        >
          <View style={[s.reasonIcon, { backgroundColor: t.c.orangeSoft }]}><Icon name="format_list_bulleted" size={20} color={t.c.orange} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.listName} numberOfLines={1}>{l.name}</Text>
            <Text style={s.meta}>{num(n)} not connected · {num(l.connected)} connected</Text>
          </View>
          <Icon name="chevron_right" size={22} color={t.c.faint} />
        </Pressable>
      ))}
    </View>
  ) : null;

  return (
    <FlatList
      data={scope === 'team' && !teamItems ? [] : shown}
      keyExtractor={(o) => o.key}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      contentContainerStyle={s.body}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={10}
      windowSize={9}
      refreshControl={
        <RefreshControl refreshing={pulling} onRefresh={onPull} colors={[t.c.primary]} tintColor={t.c.primary} progressBackgroundColor={t.c.surface} />
      }
    />
  );
};

const OwedCard = memo(({ o, index, onDial, onHide, onSchedule, onSms }: {
  o: Owed;
  index: number;
  onDial: (n: string) => void;
  onHide: (o: Owed) => void;
  onSchedule: (t: ScheduleTarget) => void;
  onSms: (t: SmsTarget) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const overdue = !!o.dueAt && o.dueAt <= Date.now();
  const scheduled = o.reason === 'scheduled' || o.reason === 'callback' || (o.reason === 'imported' && o.importStatus === 'pending_followup');
  const tone = overdue ? { fg: t.c.danger, bg: t.c.dangerSoft }
    : scheduled ? { fg: t.c.blue, bg: t.c.blueSoft }
    : o.reason === 'no_answer' ? { fg: t.c.orange, bg: t.c.orangeSoft }
    : { fg: t.c.danger, bg: t.c.dangerSoft };
  const label = o.dueAt ? (overdue ? `Due ${dueIn(o.dueAt)}` : callbackTime(o.dueAt))
    : o.reason === 'imported' ? IMPORTED_LABEL[o.importStatus || ''] || REASON_LABEL.imported : REASON_LABEL[o.reason];
  const number = o.key.length === 10 ? o.key : o.number;
  return (
    <View style={s.card}>
      <View style={s.row}>
        <View style={[s.reasonIcon, { backgroundColor: tone.bg }]}><Icon name={REASON_ICON[o.reason]} size={20} color={tone.fg} /></View>
        <View style={{ flex: 1 }}>
          <View style={s.numberRow}>
            <IndexBadge n={index + 1} />
            <Text style={s.number} selectable>{prettyPhone(number)}</Text>
          </View>
          {!!o.name && <Text style={s.name} numberOfLines={1}>{o.name}</Text>}
          <Text style={s.meta}>
            {o.reason === 'imported' ? `added ${ago(o.since, 'earlier')}` : ago(o.since, 'earlier')}
            {o.missed > 1 ? ` · missed ${o.missed}×` : ''}
            {o.tries ? ` · tried ${o.tries}× since` : ''}
          </Text>
        </View>
        <Pill label={label} fg={tone.fg} bg={tone.bg} dot pulse={overdue} />
      </View>
      {!!o.note && <Text style={s.note} numberOfLines={2}>“{o.note}”</Text>}
      <View style={s.agentRow}>
        <AttemptBadge n={o.tries} max={MAX_ATTEMPTS} />
        {!!o.smsAt && <Pill label={`SMS ${ago(o.smsAt)}${(o.smsCount || 0) > 1 ? ` · ${o.smsCount}×` : ''}`} icon="sms" fg={t.c.violet} bg={t.c.violetSoft} />}
      </View>
      {!!o.segment && (
        <View style={s.agentRow}>
          <Icon name="sell" size={14} color={t.c.faint} />
          <Text style={s.agent} numberOfLines={1}>{o.segment}</Text>
        </View>
      )}
      {!!o.agent && (
        <View style={s.agentRow}>
          <Icon name="smartphone" size={14} color={t.c.faint} />
          <Text style={s.agent} numberOfLines={1}>Owed on {o.agent}</Text>
        </View>
      )}
      <View style={s.actions}>
        <IconButton icon="visibility_off" label={`Hide ${prettyPhone(number)} on this phone`} size={36} onPress={() => onHide(o)} />
        {/* Rang back with no answer (or they missed us): a text is the next best thing. */}
        <IconButton
          icon="sms"
          label={`Send a quick SMS to ${prettyPhone(number)}`}
          size={36}
          tone={o.tries > 0 || o.reason === 'no_answer' ? 'soft' : 'outlined'}
          onPress={() => onSms({ number, name: o.name, segment: o.segment })}
        />
        <Button
          label={o.dueAt ? 'Reschedule' : 'Schedule'}
          icon="alarm"
          variant="secondary"
          size="sm"
          onPress={() => onSchedule({ number, name: o.name, segment: o.segment, dueAt: o.dueAt, note: o.note })}
          accessibilityLabel={`Schedule a callback for ${prettyPhone(number)}`}
        />
        <Button label="Call back" icon="call" size="sm" variant="success" pill onPress={() => onDial(number)} accessibilityLabel={`Call back ${prettyPhone(number)}`} />
      </View>
    </View>
  );
});

export default memo(CallbacksScreen);

const useStyles = makeStyles((t) => ({
  body: { padding: space.lg, paddingBottom: space.xxxl },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  h1: { ...type.display, color: t.c.text },
  sub: { ...type.caption, color: t.c.muted, marginTop: 2 },
  count: { ...type.overline, color: t.c.muted, marginBottom: space.md, marginTop: space.xs },

  card: {
    backgroundColor: t.c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.c.border,
    padding: 14, marginBottom: 10, overflow: 'hidden',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reasonIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  numberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  number: { fontSize: 15.5, fontWeight: '600', color: t.c.text, letterSpacing: 0.2 },
  name: { fontSize: 13, color: t.c.link, fontWeight: '600', marginTop: 2 },
  listName: { fontSize: 15, fontWeight: '600', color: t.c.text },
  meta: { fontSize: 12, color: t.c.muted, marginTop: 3 },
  agentRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 8, marginLeft: 52 },
  agent: { fontSize: 12, color: t.c.muted },
  note: { fontSize: 13, color: t.c.textSoft, fontStyle: 'italic', marginTop: 8, marginLeft: 52 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 12 },
}));
