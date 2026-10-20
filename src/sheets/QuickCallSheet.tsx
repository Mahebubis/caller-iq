import React, { useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import type { Theme } from '../theme';
import { num } from '../format';
import { Button, Icon, Sheet } from '../ui';
import { toCall } from '../ImportsScreen';
import type { ImportList } from '../ImportsScreen';

/*
 * The centre call button (and Home's "Start Calling"): type a number and call it, or start the
 * power dialer on a calling list that still has people to call.
 */

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '0', '⌫'];

/** The four tints of a list's layer icon: pink, blue, amber, purple. */
export const LIST_TONES = (t: Theme) => [
  { fg: '#DB2777', bg: t.dark ? '#3A1530' : '#FCE7F3', bar: '#EC4899' },
  { fg: t.c.blue, bg: t.c.blueSoft, bar: '#3B82F6' },
  { fg: t.c.warning, bg: t.c.warningSoft, bar: '#F59E0B' },
  { fg: t.c.violet, bg: t.c.violetSoft, bar: '#8B5CF6' },
];

export default function QuickCallSheet({ visible, onClose, lists, onDial, onPowerDial }: {
  visible: boolean;
  onClose: () => void;
  lists: ImportList[];
  onDial: (n: string) => void;
  onPowerDial: (id: number) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [n, setN] = useState('');
  useEffect(() => { if (visible) setN(''); }, [visible]);
  const ready = lists.filter((l) => l.status === 'ready' && toCall(l) > 0).slice(0, 6);
  const tones = LIST_TONES(t);
  const press = (k: string) => setN((v) => (k === '⌫' ? v.slice(0, -1) : (v + k).slice(0, 16)));
  const shown = n.replace(/^(\d{5})(\d+)/, '$1 $2');

  return (
    <Sheet visible={visible} onClose={onClose} title="Start calling" subtitle="Dial a number, or let the power dialer work through a list">
      {ready.length > 0 && (
        <>
          <Text style={s.label}>Power dialer</Text>
          {ready.map((l, i) => (
            <Pressable key={l.id} onPress={() => onPowerDial(l.id)} style={({ pressed }) => [s.list, pressed && { opacity: 0.8 }]} accessibilityRole="button" accessibilityLabel={`Power dial ${l.name}`}>
              <View style={[s.listIcon, { backgroundColor: tones[i % 4].bg }]}><Icon name="layers" size={20} color={tones[i % 4].fg} /></View>
              <View style={{ flex: 1 }}>
                <Text style={s.listName} numberOfLines={1}>{l.name}</Text>
                <Text style={s.listSub}>{num(toCall(l))} to call</Text>
              </View>
              <Icon name="play_arrow" size={24} color={t.c.link} />
            </Pressable>
          ))}
        </>
      )}
      <Text style={s.label}>Dial a number</Text>
      <Text style={[s.number, !n && { color: t.c.faint }]} numberOfLines={1}>{shown || '+91 ·····'}</Text>
      <View style={s.pad}>
        {KEYS.map((k) => (
          <Pressable key={k} onPress={() => press(k)} onLongPress={k === '⌫' ? () => setN('') : undefined} style={({ pressed }) => [s.key, pressed && { backgroundColor: t.c.primarySoft }]} accessibilityRole="button" accessibilityLabel={k === '⌫' ? 'Delete' : k}>
            <Text style={s.keyText}>{k}</Text>
          </Pressable>
        ))}
      </View>
      <Button label="Call" icon="call" size="lg" pill disabled={n.replace(/\D/g, '').length < 3} onPress={() => onDial(n)} style={{ marginTop: space.md }} />
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginTop: space.sm, marginBottom: 8 },
  list: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.c.surfaceAlt, borderRadius: radius.lg, padding: 12, marginBottom: 8 },
  listIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  listName: { fontSize: 14.5, fontWeight: '700', color: t.c.text },
  listSub: { fontSize: 12, color: t.c.muted, marginTop: 2 },
  number: { fontSize: 30, fontWeight: '800', color: t.c.text, textAlign: 'center', letterSpacing: 1, marginVertical: space.sm, fontVariant: ['tabular-nums'] },
  pad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
  key: { width: '29%', height: 54, borderRadius: radius.lg, backgroundColor: t.c.input, alignItems: 'center', justifyContent: 'center' },
  keyText: { fontSize: 22, fontWeight: '700', color: t.c.text },
}));
