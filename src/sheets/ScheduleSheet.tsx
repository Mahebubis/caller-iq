import React, { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { callbackTime, dueIn, prettyPhone } from '../format';
import { ScheduleTarget } from '../types';
import { Button, Chip, ChipBar, Field, Icon, Sheet } from '../ui';

/*
 * "Call back at 4:30 PM": pick a day and a time (or a quick "in 1 hour"), add a note, save. The
 * time is shared with the whole team through the panel, and this phone also sets an alarm that
 * rings a high-priority reminder when it comes — even with the app closed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_MIN = 30;
const FIRST_SLOT = 8 * 60;    // 8:00 am
const LAST_SLOT = 21 * 60;    // 9:00 pm

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const slotLabel = (min: number) => new Date(2000, 0, 1, Math.floor(min / 60), min % 60)
  .toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

const QUICK: { label: string; at: () => number }[] = [
  { label: 'In 30 min', at: () => Date.now() + 30 * 60 * 1000 },
  { label: 'In 1 hour', at: () => Date.now() + 60 * 60 * 1000 },
  { label: 'In 2 hours', at: () => Date.now() + 2 * 60 * 60 * 1000 },
  { label: 'Tomorrow 10 am', at: () => startOfDay(Date.now()) + DAY_MS + 10 * 60 * 60 * 1000 },
];

export default function ScheduleSheet({ target, onSave, onClear, onClose }: {
  target: ScheduleTarget | null;
  onSave: (dueMs: number, note: string) => Promise<void>;
  onClear: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [day, setDay] = useState<number>(startOfDay(Date.now()));
  const [slot, setSlot] = useState<number | null>(null);
  const [exact, setExact] = useState<number | null>(null);   // a quick pick, to the minute
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<'' | 'save' | 'clear'>('');

  // Start from the time already set, else nothing picked.
  useEffect(() => {
    if (!target) return;
    const due = target.dueAt && target.dueAt > Date.now() ? target.dueAt : 0;
    setDay(startOfDay(due || Date.now()));
    setSlot(null);
    setExact(due || null);
    setNote(target.note || '');
    setBusy('');
  }, [target]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => startOfDay(Date.now()) + i * DAY_MS), [target]); // eslint-disable-line react-hooks/exhaustive-deps
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let m = FIRST_SLOT; m <= LAST_SLOT; m += SLOT_MIN) out.push(m);
    return out;
  }, []);

  const dueMs = exact ?? (slot == null ? 0 : day + slot * 60 * 1000);
  const valid = dueMs > Date.now();
  const dayLabel = (d: number, i: number) => (i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
    : new Date(d).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' }));

  const save = async () => {
    if (!valid) return;
    setBusy('save');
    try { await onSave(dueMs, note.trim()); } finally { setBusy(''); }
  };
  const clear = async () => {
    setBusy('clear');
    try { await onClear(); } finally { setBusy(''); }
  };

  const who = target ? target.name || prettyPhone(target.number) : '';
  return (
    <Sheet
      visible={!!target}
      onClose={onClose}
      title="Schedule a callback"
      subtitle={target ? `${who}${target.name ? ` · ${prettyPhone(target.number)}` : ''}${target.segment ? ` · ${target.segment}` : ''}` : ''}
      footer={
        <View style={s.footer}>
          {!!target?.dueAt && (
            <Button label="Clear" icon="close" variant="secondary" onPress={clear} loading={busy === 'clear'} style={{ flex: 1 }} />
          )}
          <Button
            label={valid ? `Call back ${callbackTime(dueMs).replace(', ', ' ')}` : 'Pick a time'}
            icon="alarm"
            onPress={save}
            loading={busy === 'save'}
            disabled={!valid}
            style={{ flex: 2 }}
          />
        </View>
      }
    >
      <Text style={s.label}>Quick</Text>
      <ChipBar>
        {QUICK.map((q) => (
          <Chip key={q.label} label={q.label} icon="schedule" onPress={() => { const at = q.at(); setExact(at); setDay(startOfDay(at)); setSlot(null); }} />
        ))}
      </ChipBar>

      <Text style={s.label}>Day</Text>
      <ChipBar>
        {days.map((d, i) => (
          <Chip key={d} label={dayLabel(d, i)} selected={exact == null && day === d} onPress={() => { setDay(d); setExact(null); }} />
        ))}
      </ChipBar>

      <Text style={s.label}>Time</Text>
      <ChipBar>
        {slots.map((m) => {
          const past = day + m * 60 * 1000 <= Date.now();
          return past ? null : (
            <Chip key={m} label={slotLabel(m)} selected={exact == null && slot === m} onPress={() => { setSlot(m); setExact(null); }} />
          );
        })}
      </ChipBar>

      <View style={[s.preview, valid && { borderColor: t.c.blue, backgroundColor: t.c.blueSoft }]}>
        <Icon name="alarm" size={20} color={valid ? t.c.blue : t.c.faint} />
        <Text style={[s.previewText, valid && { color: t.c.blue }]}>
          {valid ? `${callbackTime(dueMs)} · ${dueIn(dueMs)}` : 'Pick a quick time, or a day and a time'}
        </Text>
      </View>

      <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="e.g. wants fee details, after 4 pm" maxLength={255} />
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginBottom: 8, marginTop: 4 },
  preview: {
    flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md,
    backgroundColor: t.c.surfaceAlt, padding: 12, marginTop: space.xs,
  },
  previewText: { flex: 1, fontSize: 14, fontWeight: '700', color: t.c.muted },
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
}));
