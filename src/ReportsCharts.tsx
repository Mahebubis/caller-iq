import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { elevation, makeStyles, radius, space, type, useTheme } from './theme';
import { num, talk } from './format';
import { Icon, IconName, Segmented } from './ui';
import { Donut, Gradient } from './art';
import { LIST_TONES } from './sheets/QuickCallSheet';
import type { ImportList } from './ImportsScreen';

/*
 * The top of Reports: four KPI cards, the call-status donut (connected / missed / callbacks), calls
 * per day / week / month as rounded coral bars, and how far each calling list has got. Every chart
 * prints its numbers, so nothing depends on reading a colour.
 */

export interface CallMix { total: number; connected: number; missed: number; callbacks: number }
export interface CallDay { day: string; n: number; connected: number }

export function ReportsKpis({ mix, talkSec, points }: { mix: CallMix; talkSec: number; points: number }) {
  const t = useTheme();
  const s = useStyles();
  const rate = mix.total ? Math.round((mix.connected / mix.total) * 100) : 0;
  const items: { icon: IconName; label: string; value: string; fg: string; bg: string }[] = [
    { icon: 'call', label: 'Total Calls', value: num(mix.total), fg: t.c.success, bg: t.c.successSoft },
    { icon: 'phone_in_talk', label: 'Connected', value: `${rate}%`, fg: t.c.blue, bg: t.c.blueSoft },
    { icon: 'timer', label: 'Talk Time', value: talk(talkSec), fg: t.c.warning, bg: t.c.warningSoft },
    { icon: 'bolt', label: 'Points', value: num(points), fg: t.c.danger, bg: t.c.dangerSoft },
  ];
  return (
    <View style={s.kpis}>
      {items.map((k) => (
        <View key={k.label} style={s.kpi} accessible accessibilityLabel={`${k.label}: ${k.value}`}>
          <View style={[s.kpiIcon, { backgroundColor: k.bg }]}><Icon name={k.icon} size={20} color={k.fg} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.kpiLabel} numberOfLines={1}>{k.label}</Text>
            <Text style={s.kpiValue} numberOfLines={1} adjustsFontSizeToFit>{k.value}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

export function StatusDonut({ mix }: { mix: CallMix }) {
  const t = useTheme();
  const s = useStyles();
  const other = Math.max(0, mix.total - mix.connected - mix.missed - mix.callbacks);
  const parts = [
    { label: 'Connected', n: mix.connected, color: t.c.emerald },
    { label: 'Missed', n: mix.missed, color: t.c.coral },
    { label: 'Callbacks', n: mix.callbacks, color: t.c.amber },
    { label: 'Not connected', n: other, color: t.dark ? '#5B4A54' : '#E4D3CC' },
  ];
  const pct = (n: number) => (mix.total ? Math.round((n / mix.total) * 100) : 0);
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Call Status</Text>
      <View style={s.donutRow}>
        <Donut values={parts.map((p) => p.n)} colors={parts.map((p) => p.color)} size={150} thickness={20}>
          <Text style={s.donutValue}>{num(mix.total)}</Text>
          <Text style={s.donutLabel}>calls</Text>
        </Donut>
        <View style={{ flex: 1, gap: 10 }}>
          {parts.map((p) => (
            <View key={p.label} style={s.legend}>
              <View style={[s.legendDot, { backgroundColor: p.color }]} />
              <Text style={s.legendLabel} numberOfLines={1}>{p.label}</Text>
              <Text style={s.legendValue}>{pct(p.n)}%</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

type Period = 'daily' | 'weekly' | 'monthly';
const DAY_MS = 86400000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Seven bars: this week Mon–Sun, the last 7 weeks, or the last 6 months. */
const bucket = (days: CallDay[], period: Period): { label: string; n: number; connected: number; now?: boolean }[] => {
  const by = new Map(days.map((d) => [d.day, d]));
  const at = (date: Date) => by.get(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  const today = startOfDay(new Date());
  const sum = (from: Date, to: Date) => {
    let n = 0; let c = 0;
    for (let d = new Date(from); d < to; d = new Date(d.getTime() + DAY_MS)) {
      const x = at(d);
      if (x) { n += x.n; c += x.connected; }
    }
    return { n, connected: c };
  };
  if (period === 'daily') {
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS);
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => {
      const d = new Date(monday.getTime() + i * DAY_MS);
      return { label, ...sum(d, new Date(d.getTime() + DAY_MS)), now: d.getTime() === today.getTime() };
    });
  }
  if (period === 'weekly') {
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS);
    return Array.from({ length: 7 }, (_, i) => {
      const from = new Date(monday.getTime() - (6 - i) * 7 * DAY_MS);
      return { label: from.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }), ...sum(from, new Date(from.getTime() + 7 * DAY_MS)), now: i === 6 };
    });
  }
  return Array.from({ length: 6 }, (_, i) => {
    const from = new Date(today.getFullYear(), today.getMonth() - (5 - i), 1);
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    return { label: from.toLocaleDateString('en-IN', { month: 'short' }), ...sum(from, to), now: i === 5 };
  });
};

export function CallsBars({ days }: { days: CallDay[] }) {
  const t = useTheme();
  const s = useStyles();
  const [period, setPeriod] = useState<Period>('daily');
  const [picked, setPicked] = useState<number | null>(null);
  const bars = useMemo(() => bucket(days, period), [days, period]);
  const max = Math.max(1, ...bars.map((b) => b.n));
  const sel = picked != null ? bars[picked] : null;
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Calls</Text>
      <Segmented
        options={[{ key: 'daily', label: 'Daily' }, { key: 'weekly', label: 'Weekly' }, { key: 'monthly', label: 'Monthly' }] as const}
        value={period}
        onChange={(p: Period) => { setPeriod(p); setPicked(null); }}
        style={{ marginTop: space.sm }}
      />
      <View style={s.bars}>
        {bars.map((b, i) => (
          <Pressable key={b.label + i} onPress={() => setPicked(picked === i ? null : i)} style={s.barCol} accessibilityRole="button" accessibilityLabel={`${b.label}: ${b.n} calls, ${b.connected} connected`}>
            <Text style={s.barNum}>{b.n ? num(b.n) : ''}</Text>
            <View style={s.barTrack}>
              {b.n > 0 && (
                <Gradient
                  colors={b.now || picked === i ? t.grad.primary : ['#FFB199', '#FF8A6B']}
                  angle={180}
                  corner={8}
                  style={{ width: '100%', height: `${Math.max(6, Math.round((b.n / max) * 100))}%` }}
                />
              )}
            </View>
            <Text style={[s.barLabel, b.now && { color: t.c.link, fontWeight: '800' }]} numberOfLines={1}>{b.label}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={s.note}>{sel ? `${sel.label}: ${num(sel.n)} calls, ${num(sel.connected)} connected` : 'Tap a bar for its numbers.'}</Text>
    </View>
  );
}

export function TopSegments({ lists }: { lists: ImportList[] }) {
  const t = useTheme();
  const s = useStyles();
  const top = useMemo(() => lists.filter((l) => l.status === 'ready').map((l) => {
    const base = Math.max(1, l.with_phone || l.stored_rows || l.total_rows || 0);
    return { l, pct: Math.min(1, (l.called || 0) / base) };
  }).sort((a, b) => (b.l.called || 0) - (a.l.called || 0)).slice(0, 5), [lists]);
  if (!top.length) return null;
  const tones = LIST_TONES(t);
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>Top Segments</Text>
      {top.map(({ l, pct }, i) => (
        <View key={l.id} style={s.seg}>
          <View style={s.segHead}>
            <View style={[s.segIcon, { backgroundColor: tones[i % 4].bg }]}><Icon name="layers" size={16} color={tones[i % 4].fg} /></View>
            <Text style={s.segName} numberOfLines={1}>{l.name}</Text>
            <Text style={[s.segPct, { color: tones[i % 4].fg }]}>{Math.round(pct * 100)}%</Text>
          </View>
          <View style={s.segTrack}><View style={[s.segFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: tones[i % 4].bar }]} /></View>
          <Text style={s.note}>{num(l.called || 0)} of {num(l.with_phone || l.stored_rows || 0)} called</Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: space.lg },
  kpi: { flexBasis: '47%', flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.c.surface, borderRadius: 18, padding: 12, ...elevation(t) },
  kpiIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  kpiLabel: { fontSize: 12, fontWeight: '600', color: t.c.muted },
  kpiValue: { ...type.metric, color: t.c.text },
  card: { backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.lg, marginTop: space.md, ...elevation(t) },
  cardTitle: { ...type.heading, color: t.c.text },
  donutRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, marginTop: space.md },
  donutValue: { fontSize: 26, fontWeight: '800', color: t.c.text, fontVariant: ['tabular-nums'] },
  donutLabel: { fontSize: 12, fontWeight: '600', color: t.c.muted },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { flex: 1, fontSize: 13, color: t.c.textSoft, fontWeight: '600' },
  legendValue: { fontSize: 13.5, fontWeight: '800', color: t.c.text, fontVariant: ['tabular-nums'] },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, height: 180, marginTop: space.md },
  barCol: { flex: 1, alignItems: 'center', height: '100%', justifyContent: 'flex-end', gap: 4 },
  barNum: { fontSize: 10.5, fontWeight: '700', color: t.c.muted },
  barTrack: { width: '78%', flex: 1, justifyContent: 'flex-end', maxWidth: 30 },
  barLabel: { fontSize: 11, fontWeight: '600', color: t.c.muted },
  note: { fontSize: 12, color: t.c.muted, marginTop: 6 },
  seg: { marginTop: space.md },
  segHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  segIcon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segName: { flex: 1, fontSize: 14, fontWeight: '700', color: t.c.text },
  segPct: { fontSize: 13.5, fontWeight: '800' },
  segTrack: { height: 8, borderRadius: 4, backgroundColor: t.c.surfaceAlt, overflow: 'hidden', marginTop: 8 },
  segFill: { height: 8, borderRadius: 4 },
}));
