import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Dimensions, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from './theme';
import { crm, Award, RANK_ICON, RULE_LABEL, Stats } from './crm';
import { CallLogItem } from './types';
import { num } from './format';
import { useToast } from './ui';

/*
 * Points, not money: every callback attempted, call connected, hot lead, sale and referral earns
 * points under the team's rules (crm.php keeps the ledger, so the leaderboard is fair and an award
 * is never given twice). This file holds the points state for the whole app, the strip under the
 * header (today's points, the streak, the shift goal, the rank), the confetti for a closed sale,
 * and the Undo snackbar that every quick action offers (Ctrl+Z on a keyboard).
 */

interface PointsApi {
  stats: Stats | null;
  streak: number;
  cleared: number;
  refresh: () => void;
  /** Points for attempt / connected / ontime; `ref` makes it once only. */
  award: (rule: 'attempt' | 'connected' | 'ontime' | 'offer', ref: string, number?: string) => void;
  /** Awards the panel already gave (meta_set, referral): say so, and celebrate a sale. */
  celebrate: (awards: Award[]) => void;
  confetti: () => void;
}

interface UndoApi {
  push: (label: string, undo: () => any) => void;
  undoLast: () => void;
}

const PointsCtx = createContext<PointsApi | null>(null);
const UndoCtx = createContext<UndoApi>({ push: () => {}, undoLast: () => {} });
export const usePoints = () => {
  const v = useContext(PointsCtx);
  if (!v) throw new Error('usePoints outside EngageProvider');
  return v;
};
export const useUndo = () => useContext(UndoCtx);

const isMissed = (tp: string) => tp === 'MISSED' || tp === 'REJECTED';

export function EngageProvider({ calls, ready, children }: { calls: CallLogItem[]; ready: boolean; children: React.ReactNode }) {
  const toast = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [burst, setBurst] = useState<number>(0);
  const [undo, setUndo] = useState<{ id: number; label: string; fn: () => any } | null>(null);
  const undoRef = useRef(undo);
  undoRef.current = undo;

  const refresh = useCallback(() => {
    crm.stats().then(setStats).catch(() => {});
  }, []);
  useEffect(() => {
    if (!ready) return undefined;
    refresh();
    const timer = setInterval(() => { if (AppState.currentState === 'active') refresh(); }, 2 * 60 * 1000);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  /* The streak: connected calls in a row, newest first, among today's outgoing calls. Cleared: the
     different numbers called back today — the shift goal counts those. */
  const { streak, cleared } = useMemo(() => {
    const start = new Date().setHours(0, 0, 0, 0);
    const out = calls.filter((c) => c && c.timestamp >= start && (c.callType || '').toUpperCase() === 'OUTGOING')
      .sort((a, b) => b.timestamp - a.timestamp);
    let n = 0;
    for (const c of out) { if (c.duration > 0) n++; else break; }
    return { streak: n, cleared: new Set(out.map((c) => (c.number || '').replace(/\D/g, '').slice(-10))).size };
  }, [calls]);

  const confetti = useCallback(() => setBurst((b) => b + 1), []);

  const celebrate = useCallback((awards: Award[]) => {
    if (!awards.length) return;
    const total = awards.reduce((a, x) => a + x.points, 0);
    toast(`+${total} ⚡ ${awards.map((a) => RULE_LABEL[a.rule] || a.rule).join(' · ')}`);
    if (awards.some((a) => a.rule === 'converted')) confetti();
    refresh();
  }, [toast, confetti, refresh]);

  const award = useCallback((rule: 'attempt' | 'connected' | 'ontime' | 'offer', ref: string, number?: string) => {
    crm.pointsAdd(rule, ref, number).then((p) => { if (p > 0) celebrate([{ rule, points: p }]); }).catch(() => {});
  }, [celebrate]);

  const push = useCallback((label: string, fn: () => any) => setUndo({ id: Date.now(), label, fn }), []);
  const undoLast = useCallback(() => {
    const u = undoRef.current;
    if (!u) return;
    setUndo(null);
    Promise.resolve(u.fn()).then(() => toast('Undone')).catch((e: any) => toast(`Couldn’t undo — ${e?.message || e}`, 'error'));
  }, [toast]);
  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo((u) => (u && u.id === undo.id ? null : u)), 7000);
    return () => clearTimeout(timer);
  }, [undo]);

  const api = useMemo(() => ({ stats, streak, cleared, refresh, award, celebrate, confetti }), [stats, streak, cleared, refresh, award, celebrate, confetti]);
  const undoApi = useMemo(() => ({ push, undoLast }), [push, undoLast]);

  return (
    <PointsCtx.Provider value={api}>
      <UndoCtx.Provider value={undoApi}>
        {children}
        {!!undo && <UndoBar label={undo.label} onUndo={undoLast} onClose={() => setUndo(null)} />}
        {burst > 0 && <Confetti key={burst} />}
      </UndoCtx.Provider>
    </PointsCtx.Provider>
  );
}

/** The strip under the header: ⚡ today · 🔥 streak · shift goal · rank. */
export function PointsBar({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const p = usePoints();
  const goal = p.stats?.goal || 100;
  const pct = Math.min(1, p.cleared / goal);
  const rank = p.stats?.rank.name || 'Rookie';
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${p.stats?.today ?? 0} points today, streak ${p.streak}, ${p.cleared} of ${goal} cleared, rank ${rank}. Open stats`} style={s.bar}>
      <Text style={s.pts}>⚡ {num(p.stats?.today ?? 0)}<Text style={s.unit}> pts</Text></Text>
      <Text style={[s.streak, p.streak >= 3 && { color: t.c.orange }]}>🔥 {p.streak}</Text>
      <View style={s.goal}>
        <View style={s.goalTrack}><View style={[s.goalFill, { width: `${Math.round(pct * 100)}%`, backgroundColor: pct >= 1 ? t.c.emerald : t.c.primary }]} /></View>
        <Text style={s.goalText} numberOfLines={1}>Cleared {p.cleared}/{goal}</Text>
      </View>
      <View style={s.rank}><Text style={s.rankText} numberOfLines={1}>{RANK_ICON[rank] || '🌱'} {rank}</Text></View>
    </Pressable>
  );
}

const UndoBar = ({ label, onUndo, onClose }: { label: string; onUndo: () => void; onClose: () => void }) => {
  const s = useStyles();
  return (
    <View style={s.undo} pointerEvents="box-none">
      <View style={s.undoInner}>
        <Text style={s.undoText} numberOfLines={2}>{label}</Text>
        <Pressable onPress={onUndo} hitSlop={10} accessibilityRole="button"><Text style={s.undoBtn}>UNDO</Text></Pressable>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss"><Text style={s.undoX}>✕</Text></Pressable>
      </View>
    </View>
  );
};

/* ── confetti for a closed sale ── */
const COLORS = ['#22C55E', '#3B82F6', '#F59E0B', '#EF4444', '#A855F7', '#14B8A6', '#EAB308'];
const PIECES = 42;
const Confetti = () => {
  const { width, height } = Dimensions.get('window');
  const pieces = useMemo(() => Array.from({ length: PIECES }, (_, i) => ({
    x: Math.random() * width,
    drift: (Math.random() - 0.5) * 160,
    delay: Math.random() * 400,
    size: 6 + Math.random() * 7,
    color: COLORS[i % COLORS.length],
    spin: Math.random() > 0.5 ? 1 : -1,
    v: new Animated.Value(0),
  })), [width]);
  useEffect(() => {
    Animated.parallel(pieces.map((p) => Animated.timing(p.v, {
      toValue: 1, duration: 2200 + Math.random() * 800, delay: p.delay, easing: Easing.out(Easing.quad), useNativeDriver: true,
    }))).start();
  }, [pieces]);
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {pieces.map((p, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute', left: p.x, top: -20, width: p.size, height: p.size * 0.5, backgroundColor: p.color, borderRadius: 2,
            opacity: p.v.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] }),
            transform: [
              { translateY: p.v.interpolate({ inputRange: [0, 1], outputRange: [0, height * 0.9] }) },
              { translateX: p.v.interpolate({ inputRange: [0, 1], outputRange: [0, p.drift] }) },
              { rotate: p.v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${p.spin * 720}deg`] }) },
            ],
          }}
        />
      ))}
    </View>
  );
};

const useStyles = makeStyles((t) => ({
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.lg, paddingVertical: 7,
    backgroundColor: t.c.surface, borderBottomWidth: 1, borderBottomColor: t.c.border,
  },
  pts: { fontSize: 13.5, fontWeight: '800', color: t.c.link, fontVariant: ['tabular-nums'] },
  unit: { fontSize: 11, fontWeight: '600', color: t.c.muted },
  streak: { fontSize: 13, fontWeight: '800', color: t.c.textSoft, fontVariant: ['tabular-nums'] },
  goal: { flex: 1, gap: 3 },
  goalTrack: { height: 5, borderRadius: 3, backgroundColor: t.c.surfaceAlt, overflow: 'hidden' },
  goalFill: { height: 5, borderRadius: 3 },
  goalText: { fontSize: 10.5, color: t.c.muted, fontWeight: '600' },
  rank: { backgroundColor: t.c.violetSoft, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 120 },
  rankText: { fontSize: 11, fontWeight: '700', color: t.c.violet },
  undo: { position: 'absolute', left: space.md, right: space.md, bottom: 84, alignItems: 'center' },
  undoInner: {
    flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: t.c.toastBg, borderRadius: radius.md,
    paddingHorizontal: 14, paddingVertical: 11, maxWidth: 520, alignSelf: 'stretch',
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
  },
  undoText: { flex: 1, color: t.c.toastText, fontSize: 13.5 },
  undoBtn: { color: t.c.amber, fontWeight: '800', fontSize: 13 },
  undoX: { color: t.c.toastText, fontSize: 14, opacity: 0.7 },
}));
