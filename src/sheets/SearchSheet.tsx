import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { ago, last10, prettyPhone } from '../format';
import { Icon, SearchField, Sheet } from '../ui';
import { CallLogItem } from '../types';
import type { Owed } from '../CallbacksScreen';
import type { FocusTarget } from './FocusSheet';

/*
 * The command palette (search button, or Ctrl+K on a keyboard): one box that finds anyone by their
 * # on the open list ("#12" or "12"), by name, or by any run of digits in their number — across
 * the open list, everyone owed a callback, and this phone's recent calls. Picking one opens Focus.
 */

interface Hit { key: string; target: FocusTarget; title: string; sub: string; tag: string }

export default function SearchSheet({ visible, onClose, rows, owed, calls, onPick }: {
  visible: boolean;
  onClose: () => void;
  rows: { target: FocusTarget; status: string }[];
  owed: Owed[];
  calls: CallLogItem[];
  onPick: (t: FocusTarget) => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [q, setQ] = useState<string>('');
  useEffect(() => { if (visible) setQ(''); }, [visible]);

  const hits = useMemo<Hit[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return rows.slice(0, 12).map((r) => toHit(r.target, r.status, 'List'));
    const hash = query.match(/^#?(\d{1,4})$/);
    const digits = query.replace(/\D/g, '');
    const out: Hit[] = [];
    const seen = new Set<string>();
    const add = (h: Hit) => { const k = last10(h.target.number); if (!k || seen.has(k)) return; seen.add(k); out.push(h); };
    if (hash) rows.filter((r) => String(r.target.index) === hash[1]).forEach((r) => add(toHit(r.target, r.status, 'List')));
    const match = (name?: string, number?: string) => (!!name && name.toLowerCase().includes(query)) || (digits.length >= 3 && (number || '').replace(/\D/g, '').includes(digits));
    rows.filter((r) => match(r.target.name, r.target.number)).forEach((r) => add(toHit(r.target, r.status, 'List')));
    owed.filter((o) => match(o.name, o.number)).forEach((o) => add({
      key: `o${o.key}`, title: o.name || prettyPhone(o.number), sub: `${o.name ? `${prettyPhone(o.number)} · ` : ''}${o.segment || 'Callback'}`, tag: 'Callback',
      target: { number: o.number, name: o.name, segment: o.segment, attempts: o.tries, dueAt: o.dueAt },
    }));
    calls.filter((c) => match('', c.number)).slice(0, 20).forEach((c) => add({
      key: `c${c.idempotencyKey}`, title: prettyPhone(c.number), sub: `${(c.callType || '').toLowerCase()} · ${ago(c.timestamp)}`, tag: 'Call',
      target: { number: c.number },
    }));
    return out.slice(0, 40);
  }, [q, rows, owed, calls]);

  return (
    <Sheet visible={visible} onClose={onClose} title="Find anyone" subtitle="#number on the open list, a name, or part of a phone number">
      <SearchField value={q} onChangeText={setQ} placeholder="#12, Priya, 98765…" />
      {hits.length === 0 && <Text style={s.empty}>Nobody matches “{q}”.</Text>}
      {hits.map((h) => (
        <Pressable key={h.key} onPress={() => { onClose(); onPick(h.target); }} style={({ pressed }) => [s.hit, pressed && { opacity: 0.7 }]} accessibilityRole="button">
          <View style={s.num}><Text style={s.numText}>{h.target.pinned ? '★' : h.target.index ? `#${h.target.index}` : '·'}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>{h.title}</Text>
            <Text style={s.sub} numberOfLines={1}>{h.sub}</Text>
          </View>
          <Text style={s.tag}>{h.tag}</Text>
          <Icon name="chevron_right" size={18} color={t.c.faint} />
        </Pressable>
      ))}
    </Sheet>
  );
}

const toHit = (target: FocusTarget, status: string, tag: string): Hit => ({
  key: `r${target.rowId ?? target.number}`,
  target,
  title: target.name || prettyPhone(target.number),
  sub: `${target.name ? `${prettyPhone(target.number)} · ` : ''}${status}`,
  tag,
});

const useStyles = makeStyles((t) => ({
  empty: { fontSize: 13, color: t.c.muted, paddingVertical: space.lg, textAlign: 'center' },
  hit: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.c.divider },
  num: { minWidth: 40, height: 32, borderRadius: radius.sm, backgroundColor: t.c.surfaceAlt, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  numText: { fontSize: 12.5, fontWeight: '800', color: t.c.textSoft },
  title: { fontSize: 14.5, fontWeight: '600', color: t.c.text },
  sub: { fontSize: 12, color: t.c.muted, marginTop: 2 },
  tag: { fontSize: 11, fontWeight: '700', color: t.c.link },
}));
