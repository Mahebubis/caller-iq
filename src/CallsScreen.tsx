import React, { forwardRef, memo, useCallback, useDeferredValue, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { FlatList, NativeModules, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { elevation, makeStyles, radius, space, type, useTheme } from './theme';
import { Avatar } from './art';
import { HomeTop } from './HomeDash';
import { ago, callbackTime, callTime, clock, dueIn, last10, num, plural, prettyPhone } from './format';
import {
  Appear, AttemptBadge, Banner, Button, EmptyState, Icon, IconButton, IconName, IndexBadge, ProgressBar, PulseDot,
  SearchField, Segmented, SectionHeader, Tactile,
} from './ui';
import { CallLogItem, MAX_ATTEMPTS, ScheduleTarget, SetupInfo, SIM_SOURCE_TEXT, SimNicknameMap, SmsTarget } from './types';
import { toCall } from './ImportsScreen';
import type { ImportList, Show } from './ImportsScreen';
import type { Owed } from './CallbacksScreen';
import type { FocusTarget } from './sheets/FocusSheet';
import { useWaSend } from './whatsapp';
import { serverTime } from './format';

const { CallBridge } = NativeModules;

/*
 * The Calls tab: today at a glance, a live feed of what needs a call now, the admin's calling
 * lists, and this phone's own call log — every call made or received, with its SIM and the
 * outcome the counselor tagged.
 */

type Filter = 'ALL' | 'INCOMING' | 'OUTGOING' | 'MISSED';
const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'INCOMING', label: 'Incoming' },
  { key: 'OUTGOING', label: 'Outgoing' },
  { key: 'MISSED', label: 'Missed' },
];

export interface CallsHandle {
  /** Clears the search / filter; false when there was nothing to clear. */
  handleBack: () => boolean;
}

interface Props {
  calls: CallLogItem[];
  loading: boolean;
  onRefresh: () => void;
  setup: SetupInfo | null;
  pendingQueueCount: number;
  syncing: boolean;
  onUploadNow: () => void;
  onStartSetup: () => void;
  onTestConnection: () => void;
  lists: ImportList[];
  onOpenList: (id: number, show?: Show) => void;
  onSeeAllLists: () => void;
  simNicknames: SimNicknameMap;
  onEditSims: () => void;
  onTag: (c: CallLogItem) => void;
  onDial: (n: string) => void;
  /** Everything owed a callback (team, this phone, and tasks imported from lists). */
  tasks: Owed[];
  onSeeCallbacks: () => void;
  onSchedule: (t: ScheduleTarget) => void;
  onSnooze: (o: Owed, minutes: number) => void;
  onDoneCallback: (o: Owed) => void;
  onSms: (t: SmsTarget) => void;
  onFocus: (t: FocusTarget) => void;
  /** Home's plum header (built by App: it knows the name, the bell, the sync state). */
  hero?: React.ReactNode;
  onTile: (k: 'start' | 'lists' | 'callbacks' | 'reports') => void;
}

/* ── Callbacks on Home ───────────────────────────────────────────────────────
 * Only callbacks, one row per number: missed calls nobody has called back yet (this phone's of the
 * last day, and the team's), callbacks asked for, and callback times coming up. Calling lists are
 * kept apart — their people are in their own section and the Lists tab — and answered calls are in
 * Recent calls. Called once is done: a number this phone has called since it was missed leaves. */
type FeedKind = 'missed' | 'callback' | 'scheduled';
interface FeedItem {
  key: string;
  number: string;
  kind: FeedKind;
  at: number;
  name?: string;
  segment?: string;
  agent?: string;
  tries?: number;
  heat?: number;
  dnd?: boolean;
}

const FEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPCOMING_MS = 3 * 60 * 60 * 1000;      // callback times coming up soon are listed
const ALERT_WINDOW_MS = 12 * 60 * 60 * 1000;  // a due callback stays on top this long
const ALERT_SOUND_MS = 5 * 60 * 1000;         // rings only if it fell due this recently
const FEED_MAX = 8;
const FEED_SHOWN = 4;

/** Callbacks due now, top of the feed; then the rest, newest (or soonest) first. */
const buildFeed = (calls: CallLogItem[], tasks: Owed[]): { alerts: Owed[]; items: FeedItem[] } => {
  const now = Date.now();
  const alerts = tasks.filter((o) => !!o.dueAt && o.dueAt <= now && o.dueAt > now - ALERT_WINDOW_MS)
    .sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0));
  const alerted = new Set(alerts.map((o) => o.key));
  const info = new Map(tasks.map((o) => [o.key, o]));
  const byKey = new Map<string, FeedItem>();
  const put = (it: FeedItem) => {
    if (alerted.has(it.key)) return;
    const cur = byKey.get(it.key);
    if (!cur || cur.at < it.at) byKey.set(it.key, it);
  };
  // The last time this phone rang each number, answered or not, and whether it ever got through.
  const outAt = new Map<string, number>();
  const spokeAt = new Map<string, number>();
  calls.forEach((c) => {
    const k = c && last10(c.number);
    if (!k) return;
    if ((c.callType || '').toUpperCase() === 'OUTGOING') outAt.set(k, Math.max(outAt.get(k) || 0, c.timestamp));
    if (c.duration > 0) spokeAt.set(k, Math.max(spokeAt.get(k) || 0, c.timestamp));
  });
  const settled = (k: string, since: number) => Math.max(outAt.get(k) || 0, spokeAt.get(k) || 0) >= since;
  calls.forEach((c) => {
    if (!c || c.timestamp < now - FEED_WINDOW_MS || !isMissed((c.callType || '').toUpperCase())) return;
    const key = last10(c.number);
    if (!key || settled(key, c.timestamp)) return;
    const o = info.get(key);
    put({ key, number: c.number, kind: 'missed', at: c.timestamp, name: o?.name, segment: o?.segment, tries: o?.tries, heat: o?.heat, dnd: o?.dnd });
  });
  // `tasks` arrives already settled by the Callbacks tab (no list tasks, called once is done).
  tasks.forEach((o) => {
    const base = { key: o.key, number: o.number, name: o.name, segment: o.segment, tries: o.tries, heat: o.heat, dnd: o.dnd };
    if (o.dueAt && o.dueAt > now && o.dueAt <= now + UPCOMING_MS) put({ ...base, kind: 'scheduled', at: o.dueAt });
    else if (o.reason === 'callback') put({ ...base, kind: 'callback', at: o.lastAt, agent: o.agent });
    else if (o.reason === 'missed' && o.lastAt >= now - FEED_WINDOW_MS) put({ ...base, kind: 'missed', at: o.lastAt, agent: o.agent });
  });
  return { alerts, items: Array.from(byKey.values()).sort((a, b) => b.at - a.at).slice(0, FEED_MAX) };
};

const FEED_KIND: { [k in FeedKind]: { label: string; icon: IconName; tone: 'success' | 'danger' | 'blue' } } = {
  callback: { label: 'Asked for a callback', icon: 'phone_callback', tone: 'blue' },
  missed: { label: 'Missed call', icon: 'phone_missed', tone: 'danger' },
  scheduled: { label: 'Callback', icon: 'alarm', tone: 'blue' },
};

const LiveFeed = memo(({ calls, tasks, onDial, onSeeAll, onSnooze, onDone, onFocus }: {
  calls: CallLogItem[];
  tasks: Owed[];
  onDial: (n: string) => void;
  onSeeAll: () => void;
  onSnooze: (o: Owed, minutes: number) => void;
  onDone: (o: Owed) => void;
  onSms: (t: SmsTarget) => void;
  onFocus: (t: FocusTarget) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const wa = useWaSend();
  // The clock: "2 min ago" keeps counting and due callbacks surface without anything being fetched.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 15 * 1000);
    return () => clearInterval(timer);
  }, []);
  const { alerts, items } = useMemo(() => buildFeed(calls, tasks), [calls, tasks, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // Four rows keep the Today card on the first screen; the rest are one tap away.
  const [more, setMore] = useState(false);
  const shown = more ? items : items.slice(0, FEED_SHOWN);

  // A callback set on this phone rings once (sound + vibration) as it falls due; the team's show
  // on top without ringing every phone.
  const rung = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh = alerts.filter((o) => o.mine && !rung.current.has(`${o.key}@${o.dueAt}`) && Date.now() - (o.dueAt || 0) < ALERT_SOUND_MS);
    alerts.forEach((o) => rung.current.add(`${o.key}@${o.dueAt}`));
    if (fresh.length) CallBridge?.playAlert?.().catch(() => {});
  }, [alerts]);

  return (
    <View>
      {/* WhatsApp replies from leads: the hottest thing on the screen. */}
      {wa.replies.map((r, i) => {
        const number = prettyPhone(r.number) || r.number;
        return (
          <Appear key={`reply-${r.number}-${r.at}`} index={i} style={s.replyAlert}>
            <View style={s.alertHead}>
              <PulseDot color={t.c.violet} size={9} />
              <Text style={[s.alertTitle, { color: t.c.violet }]}>{r.dnd ? 'Opted out (DND)' : 'Replied - Priority'}</Text>
              <Text style={[s.alertWhen, { color: t.c.violet }]}>{ago(serverTime(r.at))}</Text>
            </View>
            <Pressable onPress={() => onFocus({ number: r.number, name: r.name, segment: r.segment })} accessibilityRole="button">
              <Text style={s.alertName} numberOfLines={1}>{r.name || number}</Text>
              <Text style={s.listMeta} numberOfLines={1}>{r.name ? `${number} · ` : ''}{r.segment || 'WhatsApp'}{r.heat ? ` · heat ${r.heat}` : ''}</Text>
            </Pressable>
            <Text style={s.alertNote} numberOfLines={3}>“{r.text}”</Text>
            <View style={s.alertBtns}>
              <Button label="Call now" icon="call" variant="success" pill onPress={() => { wa.ackReply(r.number); onDial(r.number); }} style={{ flex: 2 }} />
              <Button label="Open" icon="chevron_right" variant="secondary" pill onPress={() => onFocus({ number: r.number, name: r.name, segment: r.segment })} style={{ flex: 1 }} />
              <IconButton icon="check" label="Seen — clear this reply" tone="outlined" onPress={() => wa.ackReply(r.number)} />
            </View>
          </Appear>
        );
      })}

      {alerts.map((o, i) => {
        const number = prettyPhone(o.number) || o.number;
        return (
          <Appear key={`${o.key}@${o.dueAt}`} index={i} style={s.alert}>
            <View style={s.alertHead}>
              <PulseDot color={t.c.coral} size={9} />
              <Text style={s.alertTitle}>Callback due</Text>
              <Text style={s.alertWhen}>{dueIn(o.dueAt || 0)}</Text>
            </View>
            <Text style={s.alertName} numberOfLines={1}>{o.name || number}</Text>
            <Text style={s.listMeta} numberOfLines={1}>
              {o.name ? `${number} · ` : ''}set for {callbackTime(o.dueAt || 0)}{o.segment ? ` · ${o.segment}` : ''}
            </Text>
            {!!o.note && <Text style={s.alertNote} numberOfLines={2}>“{o.note}”</Text>}
            <AttemptBadge n={o.tries} max={MAX_ATTEMPTS} />
            <View style={s.alertBtns}>
              <Button label="Call now" icon="call" variant="success" pill onPress={() => onDial(o.number)} style={{ flex: 2 }} accessibilityLabel={`Call ${o.name || number} now`} />
              <Button label="10 min" icon="snooze" variant="secondary" pill onPress={() => onSnooze(o, 10)} style={{ flex: 1 }} accessibilityLabel="Remind me again in 10 minutes" />
              <IconButton icon="chat" label={`Auto-WhatsApp ${o.name || number}`} tone="outlined" disabled={!!o.dnd} onPress={() => wa.openSend({ name: o.name, phone: o.number, segment: o.segment })} />
              <IconButton icon="check" label="Done — clear this callback" tone="outlined" onPress={() => onDone(o)} />
            </View>
          </Appear>
        );
      })}

      <View>
        <View style={s.feedHead}>
          <Text style={s.feedTitle} accessibilityRole="header">Callbacks</Text>
          <View style={{ flex: 1 }} />
          <Pressable onPress={onSeeAll} hitSlop={10} accessibilityRole="button" style={s.seeAll}>
            <Text style={s.link}>See all{tasks.length ? ` (${num(tasks.length)})` : ''}</Text>
            <Icon name="arrow_forward" size={15} color={t.c.link} />
          </Pressable>
        </View>
        {items.length === 0 ? (
          <View style={[s.card, s.feedEmptyCard]}>
            <View style={[s.feedEmptyIcon, { backgroundColor: t.tints.mint.bg }]}><Icon name="task_alt" size={22} color={t.tints.mint.fg} /></View>
            <Text style={s.feedEmpty}>Nobody is waiting. Missed calls you haven't called back and callback times coming up land here.</Text>
          </View>
        ) : shown.map((it, i) => {
          const k = FEED_KIND[it.kind];
          const tint = k.tone === 'danger' ? t.tints.rose : k.tone === 'success' ? t.tints.mint : t.tints.sky;
          const number = prettyPhone(it.number) || it.number;
          const extra = [it.segment, it.tries != null ? `tries ${it.tries}/${MAX_ATTEMPTS}` : '', it.heat ? `heat ${it.heat}` : ''].filter(Boolean).join('  ·  ');
          return (
            <Appear key={it.key} index={i} style={s.feedRow}>
              <Avatar name={it.name} phone={it.number} size={46} />
              <Pressable style={{ flex: 1 }} onPress={() => onFocus({ number: it.number, name: it.name, segment: it.segment, attempts: it.tries })} accessibilityRole="button" accessibilityLabel={`Open ${it.name || number}`}>
                <Text style={s.feedName} numberOfLines={1}>{it.name || number}</Text>
                <View style={s.feedTagRow}>
                  <View style={[s.feedTag, { backgroundColor: tint.bg }]}>
                    <Icon name={k.icon} size={13} color={tint.fg} />
                    <Text style={[s.feedTagText, { color: tint.fg }]} numberOfLines={1}>{it.kind === 'scheduled' ? callbackTime(it.at) : k.label}</Text>
                  </View>
                  <Text style={s.feedMeta} numberOfLines={1}>{it.kind === 'scheduled' ? dueIn(it.at) : ago(it.at)}</Text>
                </View>
                {!!(extra || it.agent) && <Text style={[s.feedMeta, { marginTop: 4 }, it.tries != null && it.tries >= MAX_ATTEMPTS && { color: t.c.danger }]} numberOfLines={1}>{[it.agent, extra].filter(Boolean).join('  ·  ')}</Text>}
              </Pressable>
              {/* WhatsApp and Call: two fixed round actions, so the name and the time keep their width. */}
              <IconButton icon="chat" label={`Auto-WhatsApp ${it.name || number}`} size={42} tone="outlined" color={t.c.textSoft} disabled={!!it.dnd} onPress={() => wa.openSend({ name: it.name, phone: it.number, segment: it.segment })} />
              <Tactile onPress={() => onDial(it.number)} scaleTo={0.9} unstable_pressDelay={0} accessibilityRole="button" accessibilityLabel={`Call ${it.name || number} now`} style={s.callRound}>
                <Icon name="call" size={20} color="#FFFFFF" />
              </Tactile>
            </Appear>
          );
        })}
        {items.length > FEED_SHOWN && (
          <Pressable onPress={() => setMore(!more)} hitSlop={6} accessibilityRole="button" style={s.feedMore}>
            <Text style={s.link}>{more ? 'Show fewer' : `Show ${items.length - FEED_SHOWN} more`}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
});

const simLabel = (names: SimNicknameMap, simId: string) => (simId ? names[simId] || simId : 'Unknown SIM');
const isMissed = (tp: string) => tp === 'MISSED' || tp === 'REJECTED';

const CallsScreen = forwardRef<CallsHandle, Props>((p, ref) => {
  const t = useTheme();
  const s = useStyles();
  const [search, setSearch] = useState<string>('');
  const [filter, setFilter] = useState<Filter>('ALL');
  // Typing stays instant; the list catches up a frame later.
  const query = useDeferredValue(search);

  useImperativeHandle(ref, () => ({
    handleBack: () => {
      if (search) { setSearch(''); return true; }
      if (filter !== 'ALL') { setFilter('ALL'); return true; }
      return false;
    },
  }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const qd = q.replace(/\D/g, '');
    return p.calls.filter((c) => {
      if (!c) return false;
      if (filter === 'MISSED' ? !isMissed(c.callType) : filter !== 'ALL' && c.callType !== filter) return false;
      if (!q) return true;
      return (qd.length >= 2 && (c.number || '').replace(/\D/g, '').includes(qd))
        || (c.number || '').toLowerCase().includes(q)
        || (c.outcome || '').toLowerCase().includes(q);
    });
  }, [p.calls, filter, query]);

  const { onTag, onDial, onSchedule, simNicknames } = p;
  const renderItem = useCallback(({ item, index }: { item: CallLogItem; index: number }) => (
    <CallRow item={item} index={index} sim={simLabel(simNicknames, item.simId)} onTag={onTag} onDial={onDial} onSchedule={onSchedule} />
  ), [simNicknames, onTag, onDial, onSchedule]);

  const setupOff = p.setup ? p.setup.steps.filter((x) => x.required && x.status === 'todo') : [];
  const setupUnsure = p.setup ? p.setup.steps.filter((x) => x.required && x.status === 'unknown') : [];

  const header = (
    <View>
      {p.hero}

      {/* Everything this phone still needs, from one list that knows this Android version and maker. */}
      {(setupOff.length > 0 || setupUnsure.length > 0) && (
        <Banner
          tone="primary"
          icon="checklist"
          title={setupOff.length ? `${plural(setupOff.length, 'setting')} still off` : `${setupUnsure.length} to confirm`}
          message={setupOff.length
            ? `${setupOff.map((x) => x.title).join(', ')}. Until ${setupOff.length === 1 ? 'it is' : 'they are'} on, calls can be missed and the popup may not appear.`
            : `${setupUnsure.map((x) => x.title).join(', ')} — this phone cannot report ${setupUnsure.length === 1 ? 'it' : 'them'}, so confirm once.`}
          actionLabel="Allow all"
          onAction={p.onStartSetup}
        />
      )}

      {/* Calls that cannot reach the panel must not fail silently. */}
      {!!p.setup?.syncError && (
        <Banner
          tone="danger"
          icon="sync_problem"
          title="Calls are not uploading"
          message={`${p.setup.syncError}${p.pendingQueueCount > 0 ? ` — ${p.pendingQueueCount} waiting on this phone` : ''}. They upload by themselves once this is fixed.`}
          actionLabel="Test"
          onAction={p.onTestConnection}
        />
      )}

      <LiveFeed calls={p.calls} tasks={p.tasks} onDial={p.onDial} onSeeAll={p.onSeeCallbacks} onSnooze={p.onSnooze} onDone={p.onDoneCallback} onSms={p.onSms} onFocus={p.onFocus} />

      <HomeTop calls={p.calls} callbacks={p.tasks.length} onTile={p.onTile} />

      {/* The admin's calling lists: their own section, never mixed into Callbacks. A carousel of
          cards, each with a coloured cover carrying how much of the list is called. */}
      <View style={s.feedHead}>
        <Text style={s.feedTitle} accessibilityRole="header">Calling lists</Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={p.onSeeAllLists} hitSlop={10} accessibilityRole="button" style={s.seeAll}>
          <Text style={s.link}>{p.lists.length ? `See all (${p.lists.length})` : 'Open'}</Text>
          <Icon name="arrow_forward" size={15} color={t.c.link} />
        </Pressable>
      </View>
      {p.lists.length === 0 ? (
        <View style={[s.card, s.feedEmptyCard]}>
          <View style={[s.feedEmptyIcon, { backgroundColor: t.tints.sky.bg }]}><Icon name="format_list_bulleted" size={22} color={t.tints.sky.fg} /></View>
          <Text style={s.feedEmpty}>Lists uploaded in the admin panel (Caller IQ → Imports) appear here.</Text>
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.carousel} contentContainerStyle={s.carouselIn}>
          {p.lists.slice(0, 8).map((l, i) => {
            const people = l.stored_rows || l.total_rows || 0;
            const base = Math.max(1, l.with_phone || people);
            const left = toCall(l);
            const start: Show = l.to_call == null ? 'never' : 'to_call';
            const pct = Math.min(1, (l.called || 0) / base);
            const tint = [t.tints.sky, t.tints.peach, t.tints.berry, t.tints.mint, t.tints.butter, t.tints.rose][i % 6];
            return (
              <Tactile
                key={l.id}
                onPress={() => p.onOpenList(l.id)}
                scaleTo={0.96}
                accessibilityRole="button"
                accessibilityLabel={`Open ${l.name}`}
                style={s.listCard}
              >
                <View style={[s.listCover, { backgroundColor: tint.bg }]}>
                  <Icon name="format_list_bulleted" size={96} color={tint.fg} style={s.listCoverArt} />
                  <Text style={[s.listPct, { color: tint.fg }]}>{Math.round(pct * 100)}%</Text>
                  <Text style={[s.listPctLabel, { color: tint.fg }]}>called</Text>
                </View>
                <View style={s.listBody}>
                  <Text style={s.listName} numberOfLines={2}>{l.name}</Text>
                  <ProgressBar value={pct} color={tint.fg} />
                  <View style={s.listFoot}>
                    <Text style={s.listMeta} numberOfLines={1}><Text style={s.listLeft}>{num(left)}</Text> to call · {num(people)}</Text>
                    <Tactile
                      onPress={() => p.onOpenList(l.id, left > 0 ? start : 'all')}
                      scaleTo={0.9}
                      unstable_pressDelay={0}
                      accessibilityRole="button"
                      accessibilityLabel={`${left > 0 ? 'Start calling' : 'Open'} ${l.name}`}
                      style={[s.listGo, left > 0 ? { backgroundColor: t.c.primary } : { backgroundColor: t.c.surfaceAlt }]}
                    >
                      <Icon name={left > 0 ? 'call' : 'chevron_right'} size={18} color={left > 0 ? '#FFFFFF' : t.c.textSoft} />
                    </Tactile>
                  </View>
                </View>
              </Tactile>
            );
          })}
        </ScrollView>
      )}

      {/* Dual-SIM labels */}
      <Tactile
        onPress={p.onEditSims}
        accessibilityRole="button"
        accessibilityLabel="Edit SIM labels"
        style={[s.card, s.simCard]}
      >
        <View style={[s.simIcon, { backgroundColor: t.tints.butter.bg }]}><Icon name="sim_card" size={20} color={t.tints.butter.fg} /></View>
        <View style={{ flex: 1 }}>
          <Text style={s.simTitle} numberOfLines={1}>{simLabel(p.simNicknames, 'SIM 1')}</Text>
          <Text style={s.simSub} numberOfLines={1}>{simLabel(p.simNicknames, 'SIM 2')}</Text>
        </View>
        <Text style={s.link}>Edit</Text>
      </Tactile>

      <SectionHeader title={`Recent calls · ${num(filtered.length)}`} action={p.loading ? 'Refreshing…' : 'Refresh'} onAction={p.loading ? undefined : p.onRefresh} />
      <SearchField value={search} onChangeText={setSearch} placeholder="Search number or outcome" />
      <Segmented options={FILTERS} value={filter} onChange={setFilter} />
    </View>
  );

  const empty = (
    <EmptyState
      icon={search || filter !== 'ALL' ? 'search' : 'phone_in_talk'}
      title={search || filter !== 'ALL' ? 'No calls match' : 'No calls yet'}
      body={search || filter !== 'ALL' ? 'Try another search or filter.' : 'Calls made or received on this phone appear here by themselves.'}
      actionLabel={search || filter !== 'ALL' ? 'Clear filters' : undefined}
      onAction={() => { setSearch(''); setFilter('ALL'); }}
    />
  );

  return (
    <FlatList
      data={filtered}
      keyExtractor={(c) => c.idempotencyKey || `${c.number}_${c.timestamp}`}
      renderItem={renderItem}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      contentContainerStyle={s.body}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={8}
      maxToRenderPerBatch={10}
      windowSize={9}
      removeClippedSubviews
      refreshControl={
        <RefreshControl refreshing={p.loading} onRefresh={p.onRefresh} colors={[t.c.primary]} tintColor={t.c.primary} progressBackgroundColor={t.c.surface} />
      }
    />
  );
});

const TYPE: { [k: string]: { label: string; icon: IconName; tone: 'success' | 'primary' | 'danger' | 'muted' } } = {
  INCOMING: { label: 'Incoming', icon: 'call_received', tone: 'success' },
  OUTGOING: { label: 'Outgoing', icon: 'call_made', tone: 'primary' },
  MISSED: { label: 'Missed', icon: 'call_missed', tone: 'danger' },
  REJECTED: { label: 'Rejected', icon: 'block', tone: 'muted' },
};

const CallRow = memo(({ item, index, sim, onTag, onDial, onSchedule }: {
  item: CallLogItem;
  index: number;
  sim: string;
  onTag: (c: CallLogItem) => void;
  onDial: (n: string) => void;
  onSchedule: (t: ScheduleTarget) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const ty = TYPE[(item.callType || '').toUpperCase()] || { label: item.callType || 'Call', icon: 'call' as IconName, tone: 'muted' as const };
  const fg = ty.tone === 'success' ? t.c.success : ty.tone === 'primary' ? t.c.link : ty.tone === 'danger' ? t.c.danger : t.c.muted;
  const bg = ty.tone === 'success' ? t.c.successSoft : ty.tone === 'primary' ? t.c.primarySoft : ty.tone === 'danger' ? t.c.dangerSoft : t.c.surfaceAlt;
  const number = prettyPhone(item.number) || 'Private number';
  return (
    <Appear index={index} style={s.callCard}>
      <View style={s.callTop}>
        <View>
          <Avatar phone={item.number} size={44} />
          <View style={[s.typeBadge, { backgroundColor: bg }]}><Icon name={ty.icon} size={12} color={fg} /></View>
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.callTitleRow}>
            <IndexBadge n={index + 1} />
            <Text style={s.callNumber} numberOfLines={1} selectable>{number}</Text>
            <Text style={s.callTime}>{callTime(item.timestamp)}</Text>
          </View>
          <Text style={s.callMeta} numberOfLines={1}>
            <Text style={{ color: fg, fontWeight: '600' }}>{ty.label}</Text>
            {'  ·  '}{item.duration > 0 ? clock(item.duration) : 'not connected'}{'  ·  '}
            <Text style={item.simSlot ? s.simOk : s.simUnknown}>{sim}</Text>
            {item.simCarrier ? ` (${item.simCarrier})` : ''}
          </Text>
          {!item.simSlot && !!item.simSource && (
            <Text style={s.simHint}>SIM {SIM_SOURCE_TEXT[item.simSource] || item.simSource}</Text>
          )}
        </View>
      </View>

      <View style={s.callFooter}>
        {item.outcome ? (
          <Pressable
            onPress={() => onTag(item)}
            accessibilityRole="button"
            accessibilityLabel={`Outcome ${item.outcome}. Change it`}
            style={({ pressed }) => [s.outcomeChip, pressed && { opacity: 0.75 }]}
          >
            <Icon name="sell" size={14} color={t.c.success} />
            <Text style={s.outcomeText} numberOfLines={1}>{item.outcome}</Text>
          </Pressable>
        ) : (
          <Button label="Tag outcome" icon="sell" variant="soft" size="sm" onPress={() => onTag(item)} accessibilityLabel={`Tag the outcome of the call with ${number}`} />
        )}
        <View style={{ flex: 1 }} />
        {!!item.number && (
          <>
            <IconButton icon="alarm" label={`Schedule a callback for ${number}`} tone="outlined" size={36} onPress={() => onSchedule({ number: item.number })} />
            <Button label="Call" icon="call" iconColor={t.c.success} size="sm" variant="secondary" pill onPress={() => onDial(item.number)} accessibilityLabel={`Call ${number}`} />
          </>
        )}
      </View>
    </Appear>
  );
});

export default memo(CallsScreen);

const useStyles = makeStyles((t) => ({
  body: { padding: space.lg, paddingBottom: space.xxxl },
  card: {
    backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.lg, marginBottom: space.md, ...elevation(t),
  },
  link: { fontSize: 13.5, fontWeight: '700', color: t.c.link },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  listName: { fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2, color: t.c.text, lineHeight: 20, minHeight: 40 },
  listMeta: { fontSize: 12.5, fontWeight: '500', color: t.c.muted, fontVariant: ['tabular-nums'], flexShrink: 1 },
  listLeft: { fontWeight: '800', color: t.c.text },
  carousel: { marginHorizontal: -space.lg, marginBottom: space.sm },
  carouselIn: { paddingHorizontal: space.lg, paddingTop: 2, paddingBottom: 14, gap: 12 },
  listCard: { width: 230, backgroundColor: t.c.surface, borderRadius: radius.xl, overflow: 'hidden', ...elevation(t) },
  listCover: { height: 104, padding: 16, justifyContent: 'flex-end', overflow: 'hidden' },
  listCoverArt: { position: 'absolute', right: -14, top: -14, opacity: 0.16, transform: [{ rotate: '-10deg' }] },
  listPct: { fontSize: 34, fontWeight: '800', letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  listPctLabel: { fontSize: 13, fontWeight: '700', marginTop: -4 },
  listBody: { padding: 14, gap: 10 },
  listFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  listGo: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },

  feedHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.lg, marginBottom: space.md },
  feedTitle: { ...type.overline, fontSize: 19, color: t.c.text },
  feedRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.c.surface, borderRadius: radius.lg,
    padding: 12, paddingRight: 12, marginBottom: 10, ...elevation(t),
  },
  feedName: { fontSize: 15.5, fontWeight: '700', letterSpacing: -0.2, color: t.c.text, fontVariant: ['tabular-nums'] },
  feedTagRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 5 },
  feedTag: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 1 },
  feedTagText: { fontSize: 12, fontWeight: '700' },
  feedMeta: { fontSize: 12.5, fontWeight: '500', color: t.c.muted },
  feedEmptyCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  feedEmptyIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  feedEmpty: { flex: 1, fontSize: 13.5, color: t.c.muted, lineHeight: 20 },
  feedMore: { paddingVertical: 6, alignItems: 'center' },
  callRound: { width: 44, height: 44, borderRadius: 22, backgroundColor: t.c.success, alignItems: 'center', justifyContent: 'center' },

  // A callback that has fallen due: a rose card that cannot be missed, the due time in words.
  alert: {
    backgroundColor: t.tints.rose.bg, borderRadius: radius.xl,
    padding: space.lg, marginBottom: space.md, gap: 6,
  },
  alertHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  alertTitle: { fontSize: 13.5, fontWeight: '800', color: t.tints.rose.fg, flex: 1 },
  alertWhen: { fontSize: 13.5, fontWeight: '800', color: t.tints.rose.fg, fontVariant: ['tabular-nums'] },
  alertName: { ...type.cardTitle, fontSize: 18, color: t.c.text },
  alertNote: { fontSize: 13.5, color: t.c.textSoft, fontStyle: 'italic', lineHeight: 19 },
  alertBtns: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  replyAlert: {
    backgroundColor: t.tints.berry.bg, borderRadius: radius.xl,
    padding: space.lg, marginBottom: space.md, gap: 6,
  },

  simCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  simIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  simTitle: { fontSize: 14, fontWeight: '600', color: t.c.text },
  simSub: { fontSize: 12.5, color: t.c.muted, marginTop: 2 },

  callCard: {
    backgroundColor: t.c.surface, borderRadius: radius.lg, padding: 14, marginBottom: 10, ...elevation(t),
  },
  typeBadge: {
    position: 'absolute', right: -3, bottom: -3, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: t.c.surface,
  },
  callTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  callTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  callNumber: { flex: 1, fontSize: 15, fontWeight: '600', color: t.c.text, letterSpacing: 0.2, fontVariant: ['tabular-nums'] },
  callTime: { fontSize: 12, color: t.c.muted, fontVariant: ['tabular-nums'] },
  callMeta: { fontSize: 13, color: t.c.muted, marginTop: 4, fontVariant: ['tabular-nums'] },
  simOk: { color: t.c.textSoft, fontWeight: '500' },
  simUnknown: { color: t.c.warning, fontWeight: '600' },
  simHint: { fontSize: 12, color: t.c.muted, marginTop: 2 },
  callFooter: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.c.divider },
  outcomeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minHeight: 36,
    backgroundColor: t.c.successSoft, borderRadius: radius.pill, paddingHorizontal: 12,
  },
  outcomeText: { color: t.c.success, fontSize: 12.5, fontWeight: '600', flexShrink: 1 },
}));
