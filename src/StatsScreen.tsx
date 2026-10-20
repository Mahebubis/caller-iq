import React, { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from './theme';
import { num, plural, talk } from './format';
import { Banner, Button, Field, ProgressBar, Segmented } from './ui';
import { crm, hourWindow, RANK_ICON, RULE_LABEL, STAGES } from './crm';
import { usePoints } from './engage';
import { exportBackup, importBackup, lastSnapshotAt } from './backup';
import { ago } from './format';
import { useToast } from './ui';
import { errorKind } from './api';
import { CallsBars, ReportsKpis, StatusDonut, TopSegments } from './ReportsCharts';
import type { ImportList } from './ImportsScreen';
import { elevation } from './theme';

/*
 * Stats: points and rank, the leaderboard, where leads are in the funnel, why deals were lost,
 * and when calls connect (a weekday × hour heatmap). Every chart is one hue: the length or the
 * shade is the number, and the number is printed beside it. Admins set the points rules here.
 */

type Range = 'today' | 'week' | 'month';
const RANGES: { key: Range; label: string }[] = [{ key: 'today', label: 'Today' }, { key: 'week', label: 'This week' }, { key: 'month', label: 'This month' }];
const SCOPES: { key: 'me' | 'team'; label: string }[] = [{ key: 'me', label: 'Me' }, { key: 'team', label: 'Team' }];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HOURS = Array.from({ length: 14 }, (_, i) => i + 8);   // 8 am – 9 pm
const LOST_LABEL: { [k: string]: string } = { price: 'Price', timing: 'Timing', competitor: 'Competitor', unreachable: 'Unreachable', other: 'Other' };

function StatsScreen({ active, admin, lists = [] }: { active: boolean; admin: boolean; lists?: ImportList[] }) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const pts = usePoints();
  const [range, setRange] = useState<Range>('week');
  const [scope, setScope] = useState<'me' | 'team'>('me');
  const [data, setData] = useState<any>(null);
  const [board, setBoard] = useState<any[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [errKind, setErrKind] = useState<string>('');
  const [cell, setCell] = useState<{ wd: number; h: number; n: number; c: number } | null>(null);
  const [rules, setRules] = useState<{ [k: string]: string } | null>(null);
  const [goal, setGoal] = useState<string>('');
  const [snapAt, setSnapAt] = useState<number>(0);
  useEffect(() => { if (active) lastSnapshotAt().then(setSnapAt); }, [active]);
  const doExport = async () => {
    try {
      const where = await exportBackup({ stats: pts.stats, analytics: data, leaderboard: board });
      toast(`Backup saved to ${where}`);
    } catch (e: any) {
      toast(`Backup failed — ${e?.message || e}`, 'error');
    }
  };
  const doImport = async () => {
    try {
      const n = await importBackup();
      if (n != null) toast(`${n} settings restored — close and reopen the app to use them`);
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, l] = await Promise.all([crm.analytics(range, scope), crm.leaderboard(range)]);
      setData(a);
      setBoard(l.rows || []);
      setError('');
      pts.refresh();
    } catch (e: any) {
      setError(e?.message || String(e));
      setErrKind(errorKind(e));
    } finally {
      setLoading(false);
    }
  }, [range, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) load(); }, [active, load]);

  const st = pts.stats;
  const byRule: { [k: string]: { n: number; points: number } } = data?.by_rule || {};
  const ruleRows = Object.keys(RULE_LABEL).map((k) => ({ k, ...(byRule[k] || { n: 0, points: 0 }) }));
  const ruleMax = Math.max(1, ...ruleRows.map((r) => r.points));
  const rangePoints = ruleRows.reduce((a, r) => a + r.points, 0);
  const funnel: { [k: string]: number } = data?.funnel || {};
  const funnelMax = Math.max(1, ...STAGES.map((x) => funnel[x.key] || 0));
  const won = funnel.converted || 0;
  const lostN = funnel.lost || 0;
  const lost: { reason: string; n: number }[] = data?.lost || [];
  const comps: { name: string; n: number; won: number; lost: number }[] = data?.competitors || [];
  const compMax = Math.max(1, ...comps.map((x) => x.n));
  const lostMax = Math.max(1, ...lost.map((x) => x.n));
  const calls = data?.calls || { outgoing: 0, connected: 0, talk_sec: 0 };
  // DAYOFWEEK: 1 = Sunday … 7 = Saturday → rows Monday first.
  const grid: { [k: string]: { n: number; c: number } } = {};
  (data?.hours || []).forEach((x: any) => { grid[`${(x.wd + 5) % 7}-${x.h}`] = { n: x.n, c: x.connected }; });
  const cellMax = Math.max(1, ...Object.values(grid).map((g) => g.n));

  const nextAt = st?.rank.next_at || 0;
  const rankPct = nextAt ? Math.min(1, ((st?.total || 0) - (st?.rank.from || 0)) / Math.max(1, nextAt - (st?.rank.from || 0))) : 1;

  const editRules = () => {
    setRules(Object.fromEntries(Object.entries(st?.rules || {}).map(([k, v]) => [k, String(v)])));
    setGoal(String(st?.goal || 100));
  };
  const saveRules = async () => {
    if (!rules) return;
    try {
      await crm.rulesSet(Object.fromEntries(Object.entries(rules).map(([k, v]) => [k, Number(v) || 0])), Number(goal) || 100);
      setRules(null);
      pts.refresh();
      toast('Points rules saved for the whole team');
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  };

  return (
    <ScrollView
      contentContainerStyle={s.body}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[t.c.primary]} tintColor={t.c.primary} progressBackgroundColor={t.c.surface} />}
    >
      <Text style={s.h1} accessibilityRole="header">Reports</Text>
      <Segmented options={RANGES} value={range} onChange={setRange} style={{ marginTop: space.md }} />
      {!!error && (errKind === 'missing' || errKind === 'outdated'
        ? <Banner tone="danger" icon="dns" title="Reports need the updated panel" message={`${error} Upload crm.php and crm_lib.php to api/caller-iq/.`} actionLabel="Retry" onAction={load} />
        : <Banner tone={errKind === 'offline' || errKind === 'timeout' ? 'warning' : 'danger'} icon={errKind === 'offline' ? 'wifi_off' : 'error_outline'} title="Couldn’t load the reports" message={error} actionLabel="Retry" onAction={load} />)}

      <ReportsKpis mix={data?.call_mix || { total: 0, connected: 0, missed: 0, callbacks: 0 }} talkSec={calls.talk_sec || 0} points={rangePoints} />
      <StatusDonut mix={data?.call_mix || { total: 0, connected: 0, missed: 0, callbacks: 0 }} />
      <CallsBars days={data?.call_days || []} />
      <TopSegments lists={lists} />

      {/* Points & rank */}
      <View style={s.hero}>
        <View style={{ flex: 1 }}>
          <Text style={s.heroLabel}>{RANGES.find((r) => r.key === range)?.label} · {scope === 'me' ? 'you' : 'team'}</Text>
          <Text style={s.heroValue}>⚡ {num(rangePoints)}<Text style={s.heroUnit}> pts</Text></Text>
          <Text style={s.heroSub}>🔥 {pts.streak} connected in a row · {num(st?.total || 0)} all time</Text>
        </View>
        <View style={s.rankBox}>
          <Text style={s.rankIcon}>{RANK_ICON[st?.rank.name || 'Rookie']}</Text>
          <Text style={s.rankName}>{st?.rank.name || 'Rookie'}</Text>
        </View>
      </View>
      {!!st?.rank.next && (
        <View style={s.card}>
          <Text style={s.cardSub}>{num(nextAt - (st?.total || 0))} pts to {RANK_ICON[st.rank.next]} {st.rank.next}</Text>
          <ProgressBar value={rankPct} color={t.c.violet} />
        </View>
      )}

      <Segmented options={SCOPES} value={scope} onChange={setScope} style={{ marginTop: space.lg }} />

      <Section title="Points by action">
        {ruleRows.map((r) => (
          <Bar key={r.k} label={RULE_LABEL[r.k]} value={r.points} max={ruleMax} right={`${num(r.points)} · ${r.n}×`} color={t.c.primary} />
        ))}
      </Section>

      <Section title={`Leaderboard · ${RANGES.find((r) => r.key === range)?.label.toLowerCase()}`}>
        {board.length === 0 && <Text style={s.empty}>No points yet in this period.</Text>}
        {board.map((r, i) => (
          <View key={r.device_id} style={[s.lbRow, r.me && { backgroundColor: t.c.primarySoft }]}>
            <Text style={s.lbPos}>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</Text>
            <View style={{ flex: 1 }}>
              <Text style={s.lbName} numberOfLines={1}>{r.agent}{r.me ? ' (you)' : ''}</Text>
              <Text style={s.lbSub}>{RANK_ICON[r.rank] || ''} {r.rank} · {r.connected} connected · {r.converted} closed</Text>
            </View>
            <Text style={s.lbPts}>{num(r.points)}</Text>
          </View>
        ))}
      </Section>

      <Section title="Conversion funnel">
        {STAGES.filter((x) => x.key !== 'lost').map((x) => (
          <Bar key={x.key} label={x.label} value={funnel[x.key] || 0} max={funnelMax} right={num(funnel[x.key] || 0)} color={t.c.blue} />
        ))}
        <Text style={s.cardSub}>
          {won + lostN ? `Won ${won} of ${won + lostN} decided (${Math.round((won / (won + lostN)) * 100)}%)` : 'No leads won or lost in this period yet.'}
          {calls.outgoing ? ` · ${Math.round((calls.connected / calls.outgoing) * 100)}% of ${plural(calls.outgoing, 'call')} connected · ${talk(calls.talk_sec)} talk` : ''}
        </Text>
      </Section>

      <Section title="Why deals were lost">
        {lost.length === 0 && <Text style={s.empty}>No lost deals with a reason in this period.</Text>}
        {lost.map((x) => <Bar key={x.reason} label={LOST_LABEL[x.reason] || x.reason} value={x.n} max={lostMax} right={num(x.n)} color={t.c.orange} />)}
      </Section>

      <Section title="Competitors mentioned">
        {comps.length === 0 && <Text style={s.empty}>No competitor mentioned on a call in this period.</Text>}
        {comps.map((x) => (
          <Bar key={x.name} label={x.name} value={x.n} max={compMax} right={`${num(x.n)}${x.won || x.lost ? ` · won ${x.won}/${x.won + x.lost}` : ''}`} color={t.c.violet} />
        ))}
      </Section>

      <Section title="When calls happen">
        <View style={s.heatHead}>
          <View style={s.dayCol} />
          {HOURS.map((h) => <Text key={h} style={s.hourText}>{h % 3 === 0 ? `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}` : ''}</Text>)}
        </View>
        {DAYS.map((d, di) => (
          <View key={d} style={s.heatRow}>
            <Text style={s.dayCol}>{d}</Text>
            {HOURS.map((h) => {
              const g = grid[`${di}-${h}`];
              const a = g ? 0.15 + 0.85 * (g.n / cellMax) : 0;
              const on = cell && cell.wd === di && cell.h === h;
              return (
                <Pressable
                  key={h}
                  onPress={() => setCell(g ? { wd: di, h, n: g.n, c: g.c } : null)}
                  style={[s.cellBox, { backgroundColor: g ? t.c.primary : t.c.surfaceAlt, opacity: g ? a : 1 }, on && s.cellOn]}
                  accessibilityLabel={`${d} ${h}:00, ${g ? g.n : 0} calls`}
                />
              );
            })}
          </View>
        ))}
        <Text style={s.cardSub}>
          {cell ? `${DAYS[cell.wd]} ${hourWindow(cell.h)}: ${plural(cell.n, 'call')}, ${cell.c} connected (${Math.round((cell.c / Math.max(1, cell.n)) * 100)}%)` : 'Darker = more calls. Tap a square for its numbers.'}
        </Text>
      </Section>

      {admin && (
        <Section title="Points rules (team)">
          {!rules ? (
            <Button label="Edit points rules & daily goal" icon="tune" variant="secondary" onPress={editRules} />
          ) : (
            <View>
              {Object.keys(rules).map((k) => (
                <Field key={k} label={RULE_LABEL[k] || k} value={rules[k]} onChangeText={(v) => setRules({ ...rules, [k]: v.replace(/\D/g, '') })} keyboardType="number-pad" />
              ))}
              <Field label="Daily goal (numbers cleared)" value={goal} onChangeText={(v) => setGoal(v.replace(/\D/g, ''))} keyboardType="number-pad" />
              <View style={{ flexDirection: 'row', gap: 10, marginTop: space.sm }}>
                <Button label="Cancel" variant="secondary" onPress={() => setRules(null)} style={{ flex: 1 }} />
                <Button label="Save" icon="check" onPress={saveRules} style={{ flex: 1 }} />
              </View>
            </View>
          )}
        </Section>
      )}
      <Section title="Workspace backup">
        <Text style={s.cardSub}>
          Lists, callbacks, deals and points are kept in the panel. This phone’s own settings (templates, pitch links, WhatsApp bridge, Google Sheet links, tagged outcomes) are saved every 60 seconds{snapAt ? ` — last ${ago(snapAt)}` : ''}.
        </Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label="Export .json" icon="download" variant="secondary" onPress={doExport} style={{ flex: 1 }} />
          <Button label="Restore" icon="upload_file" variant="secondary" onPress={doImport} style={{ flex: 1 }} />
        </View>
      </Section>
      {loading && !data && <ActivityIndicator color={t.c.primary} style={{ marginTop: space.lg }} />}
    </ScrollView>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => {
  const s = useStyles();
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {children}
    </View>
  );
};

/** One horizontal bar: label on the left, value printed on the right, length is the number. */
const Bar = ({ label, value, max, right, color }: { label: string; value: number; max: number; right: string; color: string }) => {
  const s = useStyles();
  return (
    <View style={s.barRow}>
      <Text style={s.barLabel} numberOfLines={1}>{label}</Text>
      <View style={s.barTrack}>
        {value > 0 && <View style={[s.barFill, { width: `${Math.max(3, Math.round((value / max) * 100))}%`, backgroundColor: color }]} />}
      </View>
      <Text style={s.barValue}>{right}</Text>
    </View>
  );
};

export default memo(StatsScreen);

const useStyles = makeStyles((t) => ({
  body: { padding: space.lg, paddingBottom: space.xxxl },
  h1: { ...type.display, color: t.c.text },
  hero: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.c.surface, borderRadius: radius.xl, ...elevation(t), padding: space.lg, marginTop: space.lg,
  },
  heroLabel: { ...type.overline, color: t.c.muted },
  heroValue: { fontSize: 32, fontWeight: '800', color: t.c.text, marginTop: 4, fontVariant: ['tabular-nums'] },
  heroUnit: { fontSize: 15, fontWeight: '600', color: t.c.muted },
  heroSub: { fontSize: 12.5, color: t.c.textSoft, marginTop: 4 },
  rankBox: { alignItems: 'center', backgroundColor: t.c.violetSoft, borderRadius: radius.lg, paddingHorizontal: 14, paddingVertical: 10 },
  rankIcon: { fontSize: 28 },
  rankName: { fontSize: 12, fontWeight: '800', color: t.c.violet, marginTop: 2 },
  card: { backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.lg, marginTop: space.md, gap: 8, ...elevation(t) },
  cardTitle: { ...type.heading, color: t.c.text, marginBottom: 4 },
  cardSub: { fontSize: 12.5, color: t.c.muted, lineHeight: 18 },
  empty: { fontSize: 13, color: t.c.muted },
  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  barLabel: { width: 120, fontSize: 12.5, color: t.c.textSoft },
  barTrack: { flex: 1, height: 12, borderRadius: 4, backgroundColor: t.c.surfaceAlt, overflow: 'hidden' },
  barFill: { height: 12, borderRadius: 4 },
  barValue: { minWidth: 56, textAlign: 'right', fontSize: 12, fontWeight: '700', color: t.c.text, fontVariant: ['tabular-nums'] },
  lbRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: radius.md },
  lbPos: { width: 32, fontSize: 15, fontWeight: '800', color: t.c.textSoft, textAlign: 'center' },
  lbName: { fontSize: 14, fontWeight: '600', color: t.c.text },
  lbSub: { fontSize: 11.5, color: t.c.muted, marginTop: 2 },
  lbPts: { fontSize: 16, fontWeight: '800', color: t.c.link, fontVariant: ['tabular-nums'] },
  heatHead: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  heatRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  dayCol: { width: 34, fontSize: 11, color: t.c.muted, fontWeight: '600' },
  hourText: { flex: 1, fontSize: 9.5, color: t.c.muted, textAlign: 'center' },
  cellBox: { flex: 1, aspectRatio: 1, borderRadius: 3 },
  cellOn: { borderWidth: 2, borderColor: t.c.text, opacity: 1 },
}));
