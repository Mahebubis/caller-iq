import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from './theme';
import { prettyPhone } from './format';
import { IconButton, PulseDot } from './ui';

/*
 * The mini call bar: pinned above the tabs from the moment a call is placed from the app until its
 * outcome is picked. Who is on the line, a stopwatch, and the five quick outcomes (keys 1-5 on a
 * keyboard). Tapping the name opens the Focus workspace.
 */

export interface ActiveCall {
  number: string;
  name?: string;
  segment?: string;
  startedAt: number;
  /** From the phone's own call state: dialing until the line opens, live, then ended. */
  phase?: 'dialing' | 'live' | 'ended';
  liveAt?: number;
  endedAt?: number;
  /** Placed by the power dialer, which moves on once the outcome is in. */
  dialer?: boolean;
}

export type Disposition = 'interested' | 'callback' | 'no_answer' | 'lost' | 'converted';
export const DISPOSITIONS: { key: Disposition; label: string; emoji: string }[] = [
  { key: 'interested', label: 'Interested', emoji: '👍' },
  { key: 'callback', label: 'Call back', emoji: '⏰' },
  { key: 'no_answer', label: 'No answer', emoji: '📵' },
  { key: 'lost', label: 'Not int.', emoji: '✋' },
  { key: 'converted', label: 'Converted', emoji: '🏆' },
];

export default function MiniCallBar({ call, onPick, onOpen, onClose }: {
  call: ActiveCall;
  onPick: (d: Disposition) => void;
  onOpen: () => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const from = call.liveAt || 0;
  const sec = from ? Math.max(0, Math.floor(((call.endedAt || Date.now()) - from) / 1000)) : 0;
  const clock = call.phase === 'ended' ? `Ended ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
    : from ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : 'Dialing…';
  return (
    <View style={s.bar}>
      <View style={s.top}>
        <PulseDot color={call.phase === 'ended' ? t.c.coral : call.phase === 'live' ? t.c.emerald : t.c.amber} />
        <Pressable onPress={onOpen} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`On a call with ${call.name || call.number}. Open the workspace`}>
          <Text style={s.name} numberOfLines={1}>{call.name || prettyPhone(call.number)}</Text>
          <Text style={s.sub} numberOfLines={1}>{call.name ? `${prettyPhone(call.number)} · ` : ''}{call.segment || 'Call from the app'}</Text>
        </Pressable>
        <Text style={s.clock}>{clock}</Text>
        <IconButton icon="close" label="Hide the call bar" size={30} onPress={onClose} />
      </View>
      <View style={s.btns}>
        {DISPOSITIONS.map((d, i) => (
          <Pressable key={d.key} onPress={() => onPick(d.key)} style={({ pressed }) => [s.btn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${i + 1}: ${d.label}`}>
            <Text style={s.emoji}>{d.emoji}</Text>
            <Text style={s.btnText} numberOfLines={1}>{i + 1} {d.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  bar: { backgroundColor: t.c.surface, borderTopWidth: 1.5, borderTopColor: t.c.emerald, paddingHorizontal: space.md, paddingTop: 8, paddingBottom: 8, gap: 8 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 14.5, fontWeight: '700', color: t.c.text },
  sub: { fontSize: 11.5, color: t.c.muted },
  clock: { fontSize: 16, fontWeight: '800', color: t.c.success, fontVariant: ['tabular-nums'] },
  btns: { flexDirection: 'row', gap: 6 },
  btn: { flex: 1, alignItems: 'center', paddingVertical: 6, borderRadius: radius.md, backgroundColor: t.c.surfaceAlt },
  emoji: { fontSize: 16 },
  btnText: { fontSize: 10.5, fontWeight: '700', color: t.c.textSoft, marginTop: 2 },
}));
