import React, { memo, useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { elevation, makeStyles, radius, space, type, useTheme } from './theme';
import { num } from './format';
import { Icon, IconButton, IconName, Tactile } from './ui';
import { Avatar, Gradient, Logo } from './art';
import { usePoints } from './engage';
import { RANK_ICON } from './crm';
import { CallLogItem } from './types';

/*
 * Home: the deep-plum curved hero (logo, bell, avatar, greeting, date pill) and, overlapping it,
 * the 2×2 metric grid, the daily target card with points, and the four gradient quick actions.
 */

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
};

export const HomeHero = memo(({ name, bell, onBell, onAvatar, onSearch, setupLeft, onSetup, status }: {
  name: string;
  bell: number;
  onBell: () => void;
  onAvatar: () => void;
  onSearch: () => void;
  setupLeft: number;
  onSetup: () => void;
  /** The upload and WhatsApp pills, on glass. */
  status?: React.ReactNode;
}) => {
  const t = useTheme();
  const s = useStyles();
  const first = (name || '').trim().split(/\s+/)[0];
  return (
    <Gradient colors={t.grad.header} angle={145} leaves="top" leafColor="rgba(255,255,255,0.07)" style={s.hero}>
      <View style={s.heroTop}>
        <Logo size={24} light />
        <View style={{ flex: 1 }} />
        <GlassIcon icon="search" label="Find anyone" onPress={onSearch} />
        {setupLeft > 0 && <GlassIcon icon="checklist" label={`${setupLeft} setup steps left`} badge={setupLeft} onPress={onSetup} />}
        <GlassIcon icon="notifications" label={`${bell} callbacks waiting`} badge={bell} onPress={onBell} />
        <Pressable onPress={onAvatar} accessibilityRole="button" accessibilityLabel="Settings" style={s.avatarRing}>
          <Avatar name={name || 'Me'} size={36} />
        </Pressable>
      </View>
      <Text style={s.hello} numberOfLines={1}>{greeting()}{first ? `, ${first}` : ''} 👋</Text>
      <View style={s.heroBottom}>
        <View style={s.datePill}>
          <Icon name="event" size={14} color="#FFFFFF" />
          <Text style={s.dateText}>{new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</Text>
        </View>
        {status}
      </View>
    </Gradient>
  );
});

const GlassIcon = ({ icon, label, onPress, badge }: { icon: IconName; label: string; onPress: () => void; badge?: number }) => {
  const s = useStyles();
  return (
    <Tactile onPress={onPress} scaleTo={0.88} unstable_pressDelay={0} accessibilityRole="button" accessibilityLabel={label} style={s.glass}>
      <Icon name={icon} size={20} color="#FFFFFF" />
      {!!badge && badge > 0 && <View style={s.badge}><Text style={s.badgeText}>{badge > 99 ? '99+' : badge}</Text></View>}
    </Tactile>
  );
};

/** Today vs yesterday, from this phone's call log. */
const useDayStats = (calls: CallLogItem[]) => useMemo(() => {
  const start = new Date().setHours(0, 0, 0, 0);
  const yStart = start - 24 * 3600 * 1000;
  const count = (from: number, to: number) => {
    const list = calls.filter((c) => c && c.timestamp >= from && c.timestamp < to);
    const missed = list.filter((c) => /MISSED|REJECTED/i.test(c.callType || '')).length;
    const connected = list.filter((c) => c.duration > 0).length;
    return { total: list.length, connected, missed };
  };
  return { today: count(start, Date.now() + 1), yday: count(yStart, start) };
}, [calls]);

const trend = (now: number, before: number) => {
  if (!before) return now ? { up: true, text: 'new' } : null;
  const pct = Math.round(((now - before) / before) * 100);
  return { up: pct >= 0, text: `${Math.abs(pct)}%` };
};

export const HomeTop = memo(({ calls, callbacks, onTile }: {
  calls: CallLogItem[];
  callbacks: number;
  onTile: (k: 'start' | 'lists' | 'callbacks' | 'reports') => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const pts = usePoints();
  const { today, yday } = useDayStats(calls);
  const goal = pts.stats?.goal || 100;
  const pct = Math.min(1, pts.cleared / goal);
  const rank = pts.stats?.rank.name || 'Rookie';
  const metrics: { icon: IconName; label: string; value: number; fg: string; bg: string; tr: ReturnType<typeof trend> }[] = [
    { icon: 'call', label: 'Total Calls', value: today.total, fg: t.c.success, bg: t.c.successSoft, tr: trend(today.total, yday.total) },
    { icon: 'phone_in_talk', label: 'Connected', value: today.connected, fg: t.c.blue, bg: t.c.blueSoft, tr: trend(today.connected, yday.connected) },
    { icon: 'phone_missed', label: 'Missed', value: today.missed, fg: t.c.danger, bg: t.c.dangerSoft, tr: trend(today.missed, yday.missed) },
    { icon: 'phone_callback', label: 'Callbacks', value: callbacks, fg: t.c.warning, bg: t.c.warningSoft, tr: null },
  ];
  return (
    <View style={s.top}>
      <View style={s.grid}>
        {metrics.map((m) => (
          <View key={m.label} style={s.metric} accessible accessibilityLabel={`${m.label}: ${m.value}`}>
            <View style={[s.metricIcon, { backgroundColor: m.bg }]}><Icon name={m.icon} size={20} color={m.fg} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.metricLabel} numberOfLines={1}>{m.label}</Text>
              <View style={s.metricRow}>
                <Text style={s.metricValue}>{num(m.value)}</Text>
                {!!m.tr && (
                  // Missed calls going up is bad news, so its arrow reads the other way round.
                  <Text style={[s.trend, { color: (m.label === 'Missed' ? !m.tr.up : m.tr.up) ? t.c.success : t.c.danger }]}>
                    {m.tr.up ? '↑' : '↓'} {m.tr.text}
                  </Text>
                )}
              </View>
            </View>
          </View>
        ))}
      </View>

      <Pressable style={s.target} onPress={() => onTile('reports')} accessibilityRole="button" accessibilityLabel={`Daily target ${pts.cleared} of ${goal}. Open reports`}>
        <View style={s.targetHead}>
          <View style={{ flex: 1 }}>
            <Text style={s.targetLabel}>Daily Target Progress</Text>
            <Text style={s.targetValue}>{num(pts.cleared)} <Text style={s.targetOf}>/ {num(goal)}</Text></Text>
          </View>
          <View style={[s.metricIcon, { backgroundColor: t.c.primarySoft, width: 44, height: 44, borderRadius: 14 }]}>
            <Text style={{ fontSize: 22 }}>🎯</Text>
          </View>
        </View>
        <View style={s.track}>
          {pct > 0 && <Gradient colors={t.grad.primary} corner={7} style={{ height: 14, width: `${Math.max(4, Math.round(pct * 100))}%` }} />}
        </View>
        <View style={s.targetFoot}>
          <Text style={s.targetPct}>{Math.round(pct * 100)}% done</Text>
          <View style={s.xp}><Text style={s.xpText}>⚡ {num(pts.stats?.today ?? 0)} XP</Text></View>
          <View style={s.xp}><Text style={s.xpText}>🔥 {pts.streak}</Text></View>
          <View style={[s.xp, { backgroundColor: t.c.violetSoft }]}><Text style={[s.xpText, { color: t.c.violet }]}>{RANK_ICON[rank]} {rank}</Text></View>
        </View>
      </Pressable>

      <View style={s.tiles}>
        <QuickTile k="start" icon="call" label="Start Calling" colors={t.grad.tiles.start} onPress={onTile} />
        <QuickTile k="lists" icon="format_list_bulleted" label="View Lists" colors={t.grad.tiles.lists} onPress={onTile} />
        <QuickTile k="callbacks" icon="phone_callback" label="Callbacks" colors={t.grad.tiles.callbacks} onPress={onTile} />
        <QuickTile k="reports" icon="bar_chart" label="Reports" colors={t.grad.tiles.reports} onPress={onTile} />
      </View>
    </View>
  );
});

const QuickTile = ({ k, icon, label, colors, onPress }: { k: 'start' | 'lists' | 'callbacks' | 'reports'; icon: IconName; label: string; colors: string[]; onPress: (k: any) => void }) => {
  const s = useStyles();
  return (
    <Tactile onPress={() => onPress(k)} scaleTo={0.94} accessibilityRole="button" accessibilityLabel={label} style={s.tileWrap}>
      <Gradient colors={colors} angle={135} corner={18} style={s.tile}>
        <View style={s.tileIcon}><Icon name={icon} size={20} color="#FFFFFF" /></View>
        <Text style={s.tileText} numberOfLines={2}>{label}</Text>
      </Gradient>
    </Tactile>
  );
};

const useStyles = makeStyles((t) => ({
  hero: {
    marginHorizontal: -space.lg, marginTop: -space.lg, paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: 72,
    borderBottomLeftRadius: 32, borderBottomRightRadius: 32, overflow: 'hidden',
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  glass: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute', top: -2, right: -2, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: '#F44350', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: '#4A154B',
  },
  badgeText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '800' },
  avatarRing: { borderRadius: 22, borderWidth: 2, borderColor: 'rgba(255,255,255,0.5)', padding: 1 },
  hello: { ...type.title, fontSize: 22, color: '#FFFFFF', marginTop: space.xl },
  heroBottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: space.md },
  datePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)', borderRadius: radius.pill, paddingHorizontal: 12, paddingVertical: 6,
  },
  dateText: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '600' },

  top: { marginTop: -56 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: {
    flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.c.surface,
    borderRadius: 18, padding: 12, ...elevation(t, 2),
  },
  metricIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  metricLabel: { fontSize: 12, fontWeight: '600', color: t.c.muted },
  metricRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 1 },
  metricValue: { ...type.metric, color: t.c.text },
  trend: { fontSize: 11.5, fontWeight: '800' },

  target: { backgroundColor: t.c.surface, borderRadius: 20, padding: space.lg, marginTop: space.md, ...elevation(t) },
  targetHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  targetLabel: { fontSize: 13, fontWeight: '600', color: t.c.muted },
  targetValue: { fontSize: 26, fontWeight: '800', color: t.c.text, marginTop: 2, fontVariant: ['tabular-nums'] },
  targetOf: { fontSize: 18, fontWeight: '700', color: t.c.faint },
  track: { height: 14, borderRadius: 7, backgroundColor: t.c.surfaceAlt, overflow: 'hidden', marginTop: space.md },
  targetFoot: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: space.sm, flexWrap: 'wrap' },
  targetPct: { flex: 1, fontSize: 13, fontWeight: '800', color: t.c.link },
  xp: { backgroundColor: t.c.primarySoft, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4 },
  xpText: { fontSize: 11.5, fontWeight: '800', color: t.c.link },

  tiles: { flexDirection: 'row', gap: 10, marginTop: space.md, marginBottom: space.lg },
  tileWrap: { flex: 1, borderRadius: 18, ...elevation(t, 2) },
  tile: { aspectRatio: 0.92, padding: 10, justifyContent: 'space-between' },
  tileIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.24)', alignItems: 'center', justifyContent: 'center' },
  tileText: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '800', lineHeight: 16 },
}));
