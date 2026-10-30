import React, { memo, useMemo, useState } from 'react';
import { LayoutChangeEvent, Text, View } from 'react-native';
import { elevation, glow, makeStyles, radius, space, Tint, type, useTheme } from './theme';
import { num, talk } from './format';
import { Icon, IconName, Tactile } from './ui';
import { usePoints } from './engage';
import { CallLogItem } from './types';

/*
 * Home: who do I call next, and how is my day going? Bold and warm, like a 2026 consumer app.
 *   HomeHero — the greeting, the hero card (callbacks waiting, in huge type, with Start calling)
 *              and the row of coloured shortcut tiles.
 *   HomeTop  — today's four figures as pastel cards, the day strip (every call of today on the
 *              hours of the day) and the dark rewards card (people called against the goal,
 *              points, streak, rank).
 * The Callbacks queue and the Calling lists carousel sit around them, in CallsScreen.
 */

type TileKey = 'start' | 'lists' | 'callbacks' | 'reports';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

const isMissed = (tp: string) => /MISSED|REJECTED/i.test(tp || '');
const DAY = 24 * 3600 * 1000;
const startOfToday = () => new Date().setHours(0, 0, 0, 0);

export const HomeHero = memo(({ name, calls, waiting, onTile }: {
  name: string;
  calls: CallLogItem[];
  /** Callbacks owed (called once is done; calling lists are not in it). */
  waiting: number;
  onTile: (k: TileKey) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const first = (name || '').trim().split(/\s+/)[0];
  const start = startOfToday();
  const today = calls.filter((c) => c && c.timestamp >= start);
  const missed = today.filter((c) => isMissed(c.callType)).length;
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const tiles: { k: TileKey; icon: IconName; label: string; tint: Tint }[] = [
    { k: 'start', icon: 'dialpad', label: 'Dial', tint: t.tints.peach },
    { k: 'lists', icon: 'format_list_bulleted', label: 'Lists', tint: t.tints.sky },
    { k: 'callbacks', icon: 'phone_callback', label: 'Callbacks', tint: t.tints.rose },
    { k: 'reports', icon: 'insights', label: 'Reports', tint: t.tints.mint },
  ];
  return (
    <View>
      <View style={s.greet}>
        <Text style={s.hello}>{greeting()},</Text>
        <Text style={s.name} accessibilityRole="header" numberOfLines={1}>{first || 'there'}</Text>
        <Text style={s.date}>{date}</Text>
      </View>

      {/* The hero: what is waiting on you, big, with the one thing to do about it. */}
      <View style={s.hero}>
        <Icon name={waiting ? 'phone_callback' : 'task_alt'} size={190} color="rgba(255,255,255,0.13)" style={s.heroArt} />
        <Text style={s.heroKicker}>{waiting ? 'Waiting on you' : 'All caught up'}</Text>
        <View style={s.heroRow}>
          <Text style={s.heroNum}>{num(waiting)}</Text>
          <Text style={s.heroUnit}>{waiting === 1 ? 'callback' : 'callbacks'}</Text>
        </View>
        <Text style={s.heroSub} numberOfLines={2}>
          {today.length ? `${num(today.length)} ${today.length === 1 ? 'call' : 'calls'} today` : 'No calls yet today'}
          {missed ? `  ·  ${num(missed)} missed` : ''}
        </Text>
        <Tactile
          onPress={() => onTile(waiting ? 'callbacks' : 'start')}
          scaleTo={0.95}
          unstable_pressDelay={0}
          accessibilityRole="button"
          accessibilityLabel={waiting ? 'Call them back' : 'Start calling'}
          style={s.heroBtn}
        >
          <Text style={s.heroBtnText}>{waiting ? 'Call them back' : 'Start calling'}</Text>
          <View style={s.heroBtnArrow}><Icon name="arrow_forward" size={16} color={t.c.onPrimary} /></View>
        </Tactile>
      </View>

      <View style={s.tiles}>
        {tiles.map((x) => (
          <Tactile key={x.k} onPress={() => onTile(x.k)} scaleTo={0.92} accessibilityRole="button" accessibilityLabel={x.label} style={s.tile}>
            <View style={[s.tileIcon, { backgroundColor: x.tint.bg }]}><Icon name={x.icon} size={26} color={x.tint.fg} /></View>
            <Text style={s.tileText} numberOfLines={1}>{x.label}</Text>
          </Tactile>
        ))}
      </View>
    </View>
  );
});

/** Today against yesterday at the same time of day, from this phone's call log. */
const useDay = (calls: CallLogItem[]) => useMemo(() => {
  const start = startOfToday();
  const now = Date.now();
  const sum = (from: number, to: number) => {
    const list = calls.filter((c) => c && c.timestamp >= from && c.timestamp < to);
    return {
      list,
      total: list.length,
      connected: list.filter((c) => c.duration > 0).length,
      missed: list.filter((c) => isMissed(c.callType)).length,
      talkSec: list.reduce((a, c) => a + (c.duration || 0), 0),
    };
  };
  // Yesterday up to this minute, so a morning is never compared with a whole day.
  return { today: sum(start, now + 1), yday: sum(start - DAY, now - DAY + 1) };
}, [calls]);

export const HomeTop = memo(({ calls, onTile }: {
  calls: CallLogItem[];
  callbacks: number;
  onTile: (k: TileKey) => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const pts = usePoints();
  const { today, yday } = useDay(calls);
  const goal = pts.stats?.goal || 100;
  const rank = pts.stats?.rank.name || 'Rookie';
  const pct = Math.min(1, pts.cleared / goal);
  const cells: { label: string; value: string; was: string; icon: IconName; tint: Tint }[] = [
    { label: 'Calls', value: num(today.total), was: num(yday.total), icon: 'call', tint: t.tints.peach },
    { label: 'Connected', value: num(today.connected), was: num(yday.connected), icon: 'phone_in_talk', tint: t.tints.mint },
    { label: 'Missed', value: num(today.missed), was: num(yday.missed), icon: 'phone_missed', tint: t.tints.rose },
    { label: 'Talk time', value: today.talkSec ? talk(today.talkSec) : '0m', was: yday.talkSec ? talk(yday.talkSec) : '0m', icon: 'timer', tint: t.tints.sky },
  ];
  const at = new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
  return (
    <View>
      <View style={s.sectionHead}>
        <Text style={s.sectionTitle} accessibilityRole="header">Today</Text>
        <Text style={s.sectionNote}>vs yesterday up to {at}</Text>
      </View>

      <View style={s.stats}>
        {cells.map((c) => (
          <View key={c.label} style={[s.stat, { backgroundColor: c.tint.bg }]} accessible accessibilityLabel={`${c.label} ${c.value}, ${c.was} by this time yesterday`}>
            <View style={s.statTop}>
              <View style={s.statIcon}><Icon name={c.icon} size={18} color={c.tint.fg} /></View>
              <Text style={[s.statWas, { color: c.tint.fg }]} numberOfLines={1}>yday {c.was}</Text>
            </View>
            <Text style={s.statValue} numberOfLines={1} adjustsFontSizeToFit>{c.value}</Text>
            <Text style={[s.statLabel, { color: c.tint.fg }]}>{c.label}</Text>
          </View>
        ))}
      </View>

      <View style={s.card}>
        <View style={s.cardHead}>
          <Text style={s.cardTitle}>Your day</Text>
          <Text style={s.sectionNote}>{num(today.total)} {today.total === 1 ? 'call' : 'calls'}</Text>
        </View>
        <DayStrip calls={today.list} />
      </View>

      {/* The rewards card: people called against the goal, with points, streak and rank. */}
      <Tactile
        onPress={() => onTile('reports')}
        scaleTo={0.98}
        accessibilityRole="button"
        accessibilityLabel={`${pts.cleared} of ${goal} people called. ${pts.stats?.today ?? 0} points today, streak ${pts.streak}, rank ${rank}. Open reports`}
        style={s.reward}
      >
        <Icon name="emoji_events" size={150} color="rgba(255,255,255,0.07)" style={s.rewardArt} />
        <Text style={s.rewardKicker}>People called today</Text>
        <Text style={s.rewardNum}>{num(pts.cleared)}<Text style={s.rewardOf}>  of {num(goal)}</Text></Text>
        <View style={s.rewardTrack}>
          {pct > 0 && <View style={[s.rewardFill, { width: `${Math.max(3, pct * 100)}%`, backgroundColor: pct >= 1 ? t.c.emerald : t.c.primary }]} />}
        </View>
        <View style={s.rewardChips}>
          <RewardChip icon="bolt" label={`${num(pts.stats?.today ?? 0)} pts`} />
          <RewardChip icon="local_fire_department" label={`Streak ${num(pts.streak)}`} />
          <RewardChip icon="military_tech" label={rank} />
        </View>
      </Tactile>
    </View>
  );
});

const RewardChip = ({ icon, label }: { icon: IconName; label: string }) => {
  const s = useStyles();
  return (
    <View style={s.rewardChip}>
      <Icon name={icon} size={15} color="#FFD7A8" />
      <Text style={s.rewardChipText} numberOfLines={1}>{label}</Text>
    </View>
  );
};

/**
 * The day strip: today's calls as marks on the hours of the day. A connected call is a tall bar in
 * the accent, a missed one a ring, an unanswered dial a short grey tick, and a line marks now. The
 * axis takes one step all the way (2, 3, 4 or 6 hours), six labels at most, landing on both ends.
 */
const DayStrip = ({ calls }: { calls: CallLogItem[] }) => {
  const t = useTheme();
  const s = useStyles();
  const [w, setW] = useState(0);
  const start = startOfToday();
  const hours = calls.map((c) => (c.timestamp - start) / 3600000);
  const nowH = (Date.now() - start) / 3600000;
  const lo = Math.min(8, ...hours.map((h) => Math.floor(h)));
  const hi = Math.max(20, Math.ceil(nowH), ...hours.map((h) => Math.ceil(h)));
  const step = [2, 3, 4, 6].find((st) => (Math.ceil(hi / st) - Math.floor(lo / st)) <= 6) || 6;
  const from = Math.floor(lo / step) * step;
  const to = Math.min(24, Math.ceil(hi / step) * step);
  const x = (h: number) => ((h - from) / (to - from)) * w;
  const ticks: number[] = [];
  for (let h = from; h <= to; h += step) ticks.push(h);
  const label = (h: number) => (h === 0 || h === 24 ? '12a' : h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`);
  return (
    <View>
      <View style={s.lane} onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} accessible accessibilityLabel={`Today's calls across the day: ${calls.length}`}>
        <View style={s.laneTrack} />
        {w > 0 && calls.map((c, i) => {
          const left = x(hours[i]);
          if (c.duration > 0) return <View key={i} style={[s.markOn, { left: left - 2, backgroundColor: t.c.primary }]} />;
          if (isMissed(c.callType)) return <View key={i} style={[s.markMissed, { left: left - 5 }]} />;
          return <View key={i} style={[s.markNo, { left: left - 1.5 }]} />;
        })}
        {w > 0 && nowH > from && nowH < to && (
          <View style={[s.now, { left: x(nowH) - 1 }]}><View style={s.nowDot} /></View>
        )}
      </View>
      <View style={s.axis}>
        {w > 0 && ticks.map((h, i) => (
          <Text
            key={h}
            style={[s.tick, { left: i === 0 ? 0 : i === ticks.length - 1 ? undefined : x(h) - 20, right: i === ticks.length - 1 ? 0 : undefined, width: 40, textAlign: i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center' }]}
          >
            {label(h)}
          </Text>
        ))}
      </View>
      <View style={s.legend}>
        <View style={s.legendItem}><View style={[s.legendOn, { backgroundColor: t.c.primary }]} /><Text style={s.legendText}>Connected</Text></View>
        <View style={s.legendItem}><View style={s.legendMissed} /><Text style={s.legendText}>Missed</Text></View>
        <View style={s.legendItem}><View style={s.legendNo} /><Text style={s.legendText}>Not answered</Text></View>
      </View>
    </View>
  );
};

const REWARD_INK = '#2A1C16';

const useStyles = makeStyles((t) => ({
  greet: { marginTop: space.xs, marginBottom: space.lg },
  hello: { fontSize: 15, fontWeight: '600', color: t.c.muted },
  name: { ...type.display, fontSize: 32, color: t.c.text, marginTop: 1 },
  date: { fontSize: 13.5, fontWeight: '500', color: t.c.muted, marginTop: 4 },

  hero: {
    backgroundColor: t.c.primary, borderRadius: radius.xxl, padding: 22, paddingBottom: 20, overflow: 'hidden', ...glow(t),
  },
  heroArt: { position: 'absolute', right: -36, bottom: -42, transform: [{ rotate: '-14deg' }] },
  heroKicker: { fontSize: 14, fontWeight: '700', color: 'rgba(255,255,255,0.86)' },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 2 },
  heroNum: { fontSize: 60, fontWeight: '800', letterSpacing: -2.5, color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  heroUnit: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: '#FFFFFF' },
  heroSub: { fontSize: 14, fontWeight: '500', color: 'rgba(255,255,255,0.86)', marginTop: 2 },
  heroBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start', marginTop: 18,
    backgroundColor: '#FFFFFF', borderRadius: radius.pill, paddingLeft: 18, paddingRight: 6, height: 46,
  },
  heroBtnText: { fontSize: 15, fontWeight: '800', color: t.c.primary },
  heroBtnArrow: { width: 34, height: 34, borderRadius: 17, backgroundColor: t.c.primary, alignItems: 'center', justifyContent: 'center' },

  tiles: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.lg, marginBottom: space.sm },
  tile: { width: '23%', alignItems: 'center', gap: 7 },
  tileIcon: { width: '100%', aspectRatio: 1, maxWidth: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontSize: 12.5, fontWeight: '700', color: t.c.textSoft },

  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: space.lg, marginBottom: space.md },
  sectionTitle: { ...type.overline, fontSize: 19, color: t.c.text },
  sectionNote: { fontSize: 12.5, fontWeight: '500', color: t.c.muted },

  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  stat: { width: '48.4%', flexGrow: 1, borderRadius: radius.xl, padding: 14 },
  statTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  statIcon: { width: 34, height: 34, borderRadius: 17, backgroundColor: t.dark ? 'rgba(0,0,0,0.25)' : 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center' },
  statWas: { flexShrink: 1, fontSize: 12, fontWeight: '600', opacity: 0.85, fontVariant: ['tabular-nums'] },
  statValue: { fontSize: 30, fontWeight: '800', letterSpacing: -1, color: t.c.text, marginTop: 10, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 13.5, fontWeight: '700', marginTop: 1 },

  card: { backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.lg, marginTop: space.md, ...elevation(t) },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 },
  cardTitle: { ...type.heading, color: t.c.text },

  lane: { height: 34, justifyContent: 'center' },
  laneTrack: { height: 6, borderRadius: 3, backgroundColor: t.c.surfaceAlt },
  markOn: { position: 'absolute', top: 3, width: 4, height: 28, borderRadius: 2 },
  markMissed: { position: 'absolute', top: 12, width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: t.c.danger, backgroundColor: t.c.surface },
  markNo: { position: 'absolute', top: 10, width: 3, height: 14, borderRadius: 1.5, backgroundColor: t.c.faint },
  now: { position: 'absolute', top: 0, bottom: 0, width: 2, borderRadius: 1, backgroundColor: t.c.text, alignItems: 'center' },
  nowDot: { position: 'absolute', top: -3, width: 8, height: 8, borderRadius: 4, backgroundColor: t.c.text },
  axis: { height: 18, marginTop: 6 },
  tick: { position: 'absolute', top: 0, fontSize: 12, fontWeight: '600', color: t.c.muted, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendOn: { width: 4, height: 14, borderRadius: 2 },
  legendMissed: { width: 10, height: 10, borderRadius: 5, borderWidth: 2, borderColor: t.c.danger },
  legendNo: { width: 3, height: 11, borderRadius: 1.5, backgroundColor: t.c.faint },
  legendText: { fontSize: 12.5, fontWeight: '500', color: t.c.muted },

  reward: {
    backgroundColor: t.dark ? t.c.surfaceAlt : REWARD_INK, borderRadius: radius.xl, padding: 20, marginTop: space.md, marginBottom: space.sm,
    overflow: 'hidden', ...elevation(t, 2),
  },
  rewardArt: { position: 'absolute', right: -24, top: -18, transform: [{ rotate: '12deg' }] },
  rewardKicker: { fontSize: 13.5, fontWeight: '700', color: '#FFD7A8' },
  rewardNum: { fontSize: 34, fontWeight: '800', letterSpacing: -1.2, color: '#FFFFFF', marginTop: 4, fontVariant: ['tabular-nums'] },
  rewardOf: { fontSize: 16, fontWeight: '700', letterSpacing: 0, color: 'rgba(255,255,255,0.6)' },
  rewardTrack: { height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.14)', overflow: 'hidden', marginTop: 12 },
  rewardFill: { height: 10, borderRadius: 5 },
  rewardChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  rewardChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 7 },
  rewardChipText: { fontSize: 13, fontWeight: '700', color: '#FFFFFF' },
}));
