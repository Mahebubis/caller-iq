import React, { useEffect, useState } from 'react';
import { NativeModules, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { Button, Chip, ChipBar, Field, Icon, Sheet } from '../ui';

const { CallBridge } = NativeModules;

/*
 * Friendly names for each SIM slot (sent with every call so the panel shows them too), and when each
 * SIM's prepaid plan ends. The end date drives a recharge reminder two days before (SimValidity.kt).
 * It is filled in by itself when the operator's balance reply names it; Airtel and Vi often answer
 * with an app advert instead, so it can be set here: "Recharged today" and the plan's length, or a date.
 */

type Validity = { date: string; source: string };
const PLANS = [28, 56, 84] as const;
const DAY = 24 * 3600 * 1000;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
/** "25-09-2026", "25/9/26", "25.09.2026" → 2026-09-25, or null. */
const parseTyped = (s: string) => {
  const m = /^\s*(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})\s*$/.exec(s);
  if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  const d = new Date(y, +m[2] - 1, +m[1]);
  return d.getDate() === +m[1] && d.getMonth() === +m[2] - 1 ? iso(d) : null;
};
const nice = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export default function SimLabelsSheet({ visible, sim1, sim2, onSave, onClose }: {
  visible: boolean;
  sim1: string;
  sim2: string;
  onSave: (sim1: string, sim2: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [a, setA] = useState(sim1);
  const [b, setB] = useState(sim2);
  const [saving, setSaving] = useState(false);
  const [valid, setValid] = useState<{ [slot: string]: Validity }>({});

  const loadValidity = () => {
    CallBridge?.getSimValidity?.().then((v: any) => setValid(v || {})).catch(() => {});
  };

  // Start from the labels in use each time the sheet opens.
  useEffect(() => {
    if (visible) { setA(sim1); setB(sim2); loadValidity(); }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try { await onSave(a.trim(), b.trim()); } finally { setSaving(false); }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="SIMs"
      subtitle="Each SIM's label goes with every call to the dashboard. Its plan end date sets a recharge reminder two days before."
      footer={
        <View style={{ flexDirection: 'row', gap: 10, marginTop: space.lg }}>
          <Button label="Close" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          <Button label="Save labels" icon="check" onPress={save} loading={saving} disabled={!a.trim() && !b.trim()} style={{ flex: 1 }} />
        </View>
      }
    >
      <Field label="SIM 1 (slot 1)" value={a} onChangeText={setA} placeholder="e.g. SIM 1: Inbound leads" maxLength={60} />
      <PlanEnd slot={1} v={valid['1']} onChanged={loadValidity} />
      <Field label="SIM 2 (slot 2)" value={b} onChangeText={setB} placeholder="e.g. SIM 2: Admissions" maxLength={60} hint="Leave one empty to keep its current label." />
      <PlanEnd slot={2} v={valid['2']} onChanged={loadValidity} />
    </Sheet>
  );
}

/** One SIM's plan end date: what is known, "Recharged today" plans, or a typed date. Saves at once. */
const PlanEnd = ({ slot, v, onChanged }: { slot: number; v?: Validity; onChanged: () => void }) => {
  const t = useTheme();
  const s = useStyles();
  const [typed, setTyped] = useState('');
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const end = v?.date ? fromIso(v.date) : null;
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  const left = end ? Math.round((end.getTime() - today.getTime()) / DAY) : null;

  const put = async (date: string, done: string) => {
    try {
      await CallBridge?.setSimValidity?.(slot, date);
      setMsg({ text: done });
      setTyped('');
      onChanged();
    } catch (e: any) {
      setMsg({ text: `Not saved — ${e?.message || e}`, error: true });
    }
  };
  // A plan of n days bought today runs to the end of day n, counting today as the first.
  const recharged = (days: number) => {
    const d = new Date(today.getTime() + (days - 1) * DAY);
    put(iso(d), `Saved: ${days}-day plan, ends ${nice(d)}. You'll be reminded two days before.`);
  };
  const saveTyped = () => {
    const d = parseTyped(typed);
    if (!d) { setMsg({ text: 'Type the date as DD-MM-YYYY, e.g. 25-11-2026.', error: true }); return; }
    put(d, `Saved: ends ${nice(fromIso(d)!)}. You'll be reminded two days before.`);
  };

  const tone = left == null ? t.tints.sky : left < 0 ? t.tints.rose : left <= 2 ? t.tints.butter : t.tints.mint;
  return (
    <View style={[s.card, { backgroundColor: tone.bg }]}>
      <View style={s.head}>
        <Icon name="sim_card" size={18} color={tone.fg} />
        <Text style={[s.title, { color: tone.fg }]}>SIM {slot} plan</Text>
      </View>
      {end ? (
        <>
          <Text style={s.date}>Ends {nice(end)}</Text>
          <Text style={s.meta}>
            {left! < 0 ? `Ended ${-left!} ${-left! === 1 ? 'day' : 'days'} ago` : left === 0 ? 'Last day today' : `${left} ${left === 1 ? 'day' : 'days'} left`}
            {'  ·  '}{v?.source === 'auto' ? "from the operator's reply" : 'set by you'}
          </Text>
        </>
      ) : (
        <Text style={s.meta}>Not known yet. The operator's balance reply didn't say; set it below.</Text>
      )}
      <Text style={s.label}>Recharged today</Text>
      <ChipBar style={{ marginHorizontal: -2 }}>
        {PLANS.map((d) => <Chip key={d} label={`${d} days`} icon="event" onPress={() => recharged(d)} />)}
      </ChipBar>
      <View style={s.row}>
        <View style={{ flex: 1 }}>
          <Field label="Or the end date" value={typed} onChangeText={setTyped} placeholder="DD-MM-YYYY" keyboardType="numbers-and-punctuation" maxLength={10} />
        </View>
        <Button label="Save" size="sm" variant="secondary" onPress={saveTyped} disabled={!typed.trim()} style={s.save} />
      </View>
      {!!msg && <Text style={[s.msg, msg.error && { color: t.c.danger }]}>{msg.text}</Text>}
      {!!end && (
        <Button label="Clear the date" variant="ghost" size="sm" onPress={() => put('', 'Cleared: no reminder for this SIM.')} style={{ alignSelf: 'flex-start', marginTop: 4 }} />
      )}
    </View>
  );
};

const useStyles = makeStyles((t) => ({
  card: { borderRadius: radius.xl, padding: space.lg, marginTop: space.md, marginBottom: space.sm },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '800' },
  date: { fontSize: 20, fontWeight: '800', letterSpacing: -0.4, color: t.c.text, marginTop: 8 },
  meta: { fontSize: 13, color: t.c.textSoft, marginTop: 3, lineHeight: 18 },
  label: { fontSize: 13.5, fontWeight: '600', color: t.c.text, marginTop: space.md, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  save: { marginBottom: 2 },
  msg: { fontSize: 13, color: t.c.success, marginTop: 8, lineHeight: 18 },
}));
