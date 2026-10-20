import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, Switch, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { callbackTime } from '../format';
import { Button, Chip, ChipBar, Field, Icon, IconButton } from '../ui';
import { useToast } from '../ui';
import { Battle, crm, native, Plan } from '../crm';
import {
  DEFAULT_BATTLE, DEFAULT_PLANS, DRIP, DRIP_STEPS, EMI_LINE, fillSales, Lang, OFFER_SUMMARY, rupees, VALIDITY_LINE,
} from '../sales';
import { useWaSend, WaContact, WaMedia } from '../whatsapp';
import { usePoints } from '../engage';

/*
 * The Focus workspace's extra tools, each a self-contained panel:
 *   DripPanel        3 follow-ups (now, +24 h, +48 h) sent by the bridge; stops when they reply/answer
 *   AttachPanel      a PDF, image or voice note from this phone, sent with a caption
 *   OfferCalculator  plan + on-call discount + EMI → a formatted offer on WhatsApp (+ points)
 *   BattlePanel      the competitor they mentioned, logged, with the Us vs Them matrix to read out
 * Plans and the matrix are team settings (crm.php); an unlocked admin can edit them here.
 */

interface Base { contact: WaContact; lang: Lang; vars: { name?: string; segment?: string; me?: string } }

/* Team settings, read once per app run. */
let teamCache: { plans: Plan[]; battle: Battle } | null = null;
export const useTeamSettings = () => {
  const [v, setV] = useState(teamCache || { plans: DEFAULT_PLANS, battle: DEFAULT_BATTLE });
  useEffect(() => {
    if (teamCache) return;
    crm.settingsGet(['plans', 'battle']).then((d) => {
      teamCache = { plans: d.plans?.length ? d.plans : DEFAULT_PLANS, battle: d.battle?.criteria ? d.battle : DEFAULT_BATTLE };
      setV(teamCache);
    }).catch(() => {});
  }, []);
  const save = async (key: 'plans' | 'battle', value: any) => {
    await crm.settingsSet(key, value);
    teamCache = { ...(teamCache || v), [key]: value };
    setV(teamCache);
  };
  return { ...v, save };
};

/* ── Drip ── */
export function DripPanel({ contact, lang, vars, dnd }: Base & { dnd: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const wa = useWaSend();
  const [busy, setBusy] = useState(false);
  const drip = wa.drips[contact.phone.replace(/\D/g, '').slice(-10)];
  const start = async () => {
    if (dnd) { toast('They opted out (DND) — no drip', 'error'); return; }
    setBusy(true);
    try {
      const r = await wa.startDrip([contact], DRIP[lang].map((m, i) => ({ afterMin: DRIP_STEPS[i].afterMin, message: fillSales(m, vars) })));
      toast(r ? 'Drip started: now, in 24 h and in 48 h — it stops if they reply or pick up' : 'Set up the WhatsApp bridge to run drips', r ? 'default' : 'error');
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return drip ? (
    <View style={[s.card, s.row, { borderColor: t.c.blue }]}>
      <Icon name="schedule" size={22} color={t.c.blue} />
      <View style={{ flex: 1 }}>
        <Text style={s.title}>Drip running · {drip.left} left</Text>
        <Text style={s.sub}>Next {callbackTime(drip.nextAt)}. Stops by itself when they reply or answer a call.</Text>
      </View>
      <Button label="Stop" size="sm" variant="secondary" onPress={() => wa.stopDrip(contact.phone)} />
    </View>
  ) : (
    <View>
      {DRIP_STEPS.map((st, i) => (
        <Text key={st.label} style={s.sub} numberOfLines={2}>{i + 1}. {st.label}: {fillSales(DRIP[lang][i], vars)}</Text>
      ))}
      <Button label="Start the 3-step drip" icon="schedule" variant="secondary" loading={busy} onPress={start} style={{ marginTop: space.sm }} />
    </View>
  );
}

/* ── Attachments ── */
export function AttachPanel({ contact, lang, vars, onSent }: Base & { onSent: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const wa = useWaSend();
  const [media, setMedia] = useState<WaMedia | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async () => {
    try {
      const f = await native.pickMediaFile();
      if (!f) return;
      setMedia({ b64: f.b64, mime: f.mime, name: f.name, bytes: f.bytes, voice: /^audio\//.test(f.mime) });
      if (!caption) setCaption(fillSales(lang === 'en' ? 'Hi {name}, sharing this for {segment}.' : lang === 'hi' ? 'नमस्ते {name}, {segment} के लिए यह भेज रहा/रही हूँ।' : lang === 'mr' ? 'नमस्कार {name}, {segment} साठी हे पाठवत आहे.' : 'Hi {name}, {segment} ke liye yeh bhej raha/rahi hoon.', vars));
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  };
  const send = async () => {
    if (!media) return;
    setBusy(true);
    try {
      const ok = await wa.sendOne(contact, caption, { media, how: media.voice ? 'Voice note' : 'File' });
      if (ok) { setMedia(null); setCaption(''); onSent(); }
    } finally {
      setBusy(false);
    }
  };
  if (!media) return <Button label="Attach a PDF, image or voice note" icon="upload_file" variant="soft" onPress={pick} />;
  const audio = /^audio\//.test(media.mime);
  return (
    <View style={s.card}>
      <View style={s.row}>
        <Icon name={audio ? 'mic' : media.mime === 'application/pdf' ? 'format_list_bulleted' : 'upload_file'} size={22} color={t.c.link} />
        <View style={{ flex: 1 }}>
          <Text style={s.title} numberOfLines={1}>{media.name}</Text>
          <Text style={s.sub}>{media.mime} · {Math.max(1, Math.round((media.bytes || 0) / 1024))} KB</Text>
        </View>
        <IconButton icon="close" label="Remove the file" size={32} onPress={() => setMedia(null)} />
      </View>
      {audio && (
        <View style={[s.row, { marginTop: 6 }]}>
          <Text style={[s.sub, { flex: 1 }]}>Send as a voice note (plays inline in WhatsApp)</Text>
          <Switch value={!!media.voice} onValueChange={(v) => setMedia({ ...media, voice: v })} trackColor={{ false: t.c.borderStrong, true: t.c.primaryLine }} thumbColor={media.voice ? t.c.primary : t.c.surface} />
        </View>
      )}
      <Field label={audio && media.voice ? 'Message sent before it' : 'Caption'} value={caption} onChangeText={setCaption} multiline maxLength={1000} />
      <Button label="Send on WhatsApp" icon="send" variant="success" loading={busy} onPress={send} />
    </View>
  );
}

/* ── Offer calculator ── */
const DISCOUNTS = [0, 5, 10, 15, 20];
const EMIS = [1, 3, 6, 12];
export function OfferCalculator({ contact, lang, vars, offerUntil, admin, onSent }: Base & { offerUntil: number; admin: boolean; onSent: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const wa = useWaSend();
  const points = usePoints();
  const team = useTeamSettings();
  const [plan, setPlan] = useState(0);
  const [disc, setDisc] = useState(10);
  const [emi, setEmi] = useState(1);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Plan[] | null>(null);
  const p = team.plans[Math.min(plan, team.plans.length - 1)] || DEFAULT_PLANS[0];
  const final = Math.round(p.price * (1 - disc / 100));
  const per = emi > 1 ? Math.ceil(final / emi) : final;
  const text = useMemo(() => fillSales(OFFER_SUMMARY[lang], vars)
    .replace('{plan}', `${p.name}${p.note ? ` (${p.note})` : ''}`)
    .replace('{price}', rupees(p.price))
    .replace('{discount}', String(disc))
    .replace('{final}', rupees(final))
    .replace('{emi}', EMI_LINE[lang](emi, rupees(per)))
    .replace('{validity}', VALIDITY_LINE[lang](offerUntil > Date.now() ? callbackTime(offerUntil) : ''))
    .replace(/\n{2,}/g, '\n'), [lang, vars, p, disc, final, emi, per, offerUntil]);

  const send = async () => {
    setBusy(true);
    try {
      const ok = await wa.sendOne(contact, text, { how: 'Offer' });
      if (ok) {
        points.award('offer', `${contact.phone.replace(/\D/g, '').slice(-10)}:${new Date().toISOString().slice(0, 10)}`, contact.phone);
        onSent();
      }
    } finally {
      setBusy(false);
    }
  };
  const savePlans = async () => {
    if (!editing) return;
    const clean = editing.filter((x) => x.name.trim() && x.price > 0);
    try {
      await team.save('plans', clean);
      setEditing(null);
      toast('Plans saved for the team');
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  };

  if (editing) {
    return (
      <View style={s.card}>
        {editing.map((x, i) => (
          <View key={i} style={s.row}>
            <View style={{ flex: 2 }}><Field label="Plan" value={x.name} onChangeText={(v) => setEditing(editing.map((y, j) => (j === i ? { ...y, name: v } : y)))} /></View>
            <View style={{ flex: 1 }}><Field label="Price ₹" value={String(x.price || '')} keyboardType="number-pad" onChangeText={(v) => setEditing(editing.map((y, j) => (j === i ? { ...y, price: Number(v.replace(/\D/g, '')) || 0 } : y)))} /></View>
            <IconButton icon="delete_outline" label="Remove plan" size={32} onPress={() => setEditing(editing.filter((_, j) => j !== i))} />
          </View>
        ))}
        <View style={s.row}>
          <Button label="Add plan" icon="add" size="sm" variant="secondary" onPress={() => setEditing([...editing, { name: '', price: 0 }])} />
          <View style={{ flex: 1 }} />
          <Button label="Cancel" size="sm" variant="secondary" onPress={() => setEditing(null)} />
          <Button label="Save" icon="check" size="sm" onPress={savePlans} />
        </View>
      </View>
    );
  }
  return (
    <View>
      <ChipBar>{team.plans.map((x, i) => <Chip key={x.name + i} label={`${x.name} · ${rupees(x.price)}`} selected={plan === i} onPress={() => setPlan(i)} />)}</ChipBar>
      <Text style={s.label}>On-call special discount</Text>
      <ChipBar>{DISCOUNTS.map((d) => <Chip key={d} label={d ? `${d}%` : 'None'} selected={disc === d} onPress={() => setDisc(d)} />)}</ChipBar>
      <Text style={s.label}>Pay in</Text>
      <ChipBar>{EMIS.map((m) => <Chip key={m} label={m === 1 ? 'Full' : `${m} EMIs`} selected={emi === m} onPress={() => setEmi(m)} />)}</ChipBar>
      <View style={s.calc}>
        <Line label="Plan price" value={rupees(p.price)} />
        {disc > 0 && <Line label={`On-call special −${disc}%`} value={`−${rupees(p.price - final)}`} color={t.c.success} />}
        <Line label="Final price" value={rupees(final)} bold />
        {emi > 1 && <Line label={`${emi} monthly instalments`} value={`${rupees(per)} / month`} bold />}
      </View>
      <View style={s.row}>
        <Button label="Send offer on WhatsApp" icon="send" variant="success" loading={busy} onPress={send} style={{ flex: 1 }} />
        {admin && <IconButton icon="tune" label="Edit the team's plans" tone="outlined" onPress={() => setEditing(team.plans.map((x) => ({ ...x })))} />}
      </View>
    </View>
  );
}

const Line = ({ label, value, bold, color }: { label: string; value: string; bold?: boolean; color?: string }) => {
  const s = useStyles();
  return (
    <View style={s.line}>
      <Text style={[s.lineLabel, bold && s.bold]}>{label}</Text>
      <Text style={[s.lineValue, bold && s.bold, color ? { color } : null]}>{value}</Text>
    </View>
  );
};

/* ── Competitor battle matrix ── */
export function BattlePanel({ competitor, onPick, admin }: { competitor: string; onPick: (name: string) => void; admin: boolean }) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const team = useTeamSettings();
  const [editing, setEditing] = useState<Battle | null>(null);
  const b = team.battle;
  const ci = b.competitors.findIndex((c) => c.name === competitor);
  const them = ci >= 0 ? b.competitors[ci] : null;

  const save = async () => {
    if (!editing) return;
    try {
      await team.save('battle', editing);
      setEditing(null);
      toast('Battle matrix saved for the team');
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  };

  if (editing) {
    const ei = Math.max(0, editing.competitors.findIndex((c) => c.name === competitor));
    const ec = editing.competitors[ei];
    return (
      <View style={s.card}>
        <Text style={s.title}>Edit: us vs {ec?.name || 'competitor'}</Text>
        {editing.criteria.map((cr, i) => (
          <View key={i} style={s.row}>
            <View style={{ flex: 1 }}><Field label={cr} value={editing.us[i] || ''} placeholder="Us" onChangeText={(v) => { const us = [...editing.us]; us[i] = v; setEditing({ ...editing, us }); }} /></View>
            {ec && (
              <View style={{ flex: 1 }}><Field label={ec.name} value={ec.values[i] || ''} placeholder="Them" onChangeText={(v) => {
                const comps = editing.competitors.map((c, j) => (j === ei ? { ...c, values: Object.assign([...c.values], { [i]: v }) } : c));
                setEditing({ ...editing, competitors: comps });
              }} /></View>
            )}
          </View>
        ))}
        <Field label="Competitors (comma separated)" value={editing.competitors.map((c) => c.name).join(', ')} onChangeText={(v) => {
          const names = v.split(',').map((x) => x.trim()).filter(Boolean);
          setEditing({ ...editing, competitors: names.map((n) => editing.competitors.find((c) => c.name === n) || { name: n, values: [] }) });
        }} />
        <View style={s.row}>
          <View style={{ flex: 1 }} />
          <Button label="Cancel" size="sm" variant="secondary" onPress={() => setEditing(null)} />
          <Button label="Save" icon="check" size="sm" onPress={save} />
        </View>
      </View>
    );
  }

  return (
    <View>
      <ChipBar>
        {b.competitors.map((c) => <Chip key={c.name} label={c.name} selected={competitor === c.name} onPress={() => onPick(competitor === c.name ? '' : c.name)} />)}
      </ChipBar>
      {them && (
        <View style={s.matrix}>
          <View style={[s.mRow, s.mHead]}>
            <Text style={[s.mCell, s.mCrit, s.bold]}> </Text>
            <Text style={[s.mCell, s.bold, { color: t.c.success }]}>Us</Text>
            <Text style={[s.mCell, s.bold]}>{them.name}</Text>
          </View>
          {b.criteria.map((cr, i) => (
            <View key={cr} style={[s.mRow, i % 2 === 1 && { backgroundColor: t.c.surfaceAlt }]}>
              <Text style={[s.mCell, s.mCrit]}>{cr}</Text>
              <Text style={[s.mCell, { color: t.c.text, fontWeight: '600' }]}>{b.us[i] || '—'}</Text>
              <Text style={[s.mCell, { color: them.values[i] ? t.c.textSoft : t.c.faint }]}>{them.values[i] || 'Ask them'}</Text>
            </View>
          ))}
          {admin && (
            <Pressable onPress={() => setEditing(JSON.parse(JSON.stringify(b)))} style={s.edit} hitSlop={8}>
              <Text style={s.link}>Edit the matrix</Text>
            </Pressable>
          )}
          {!them.values.some(Boolean) && <Text style={s.sub}>Their column is empty: note what the student says about {them.name}{admin ? ' and fill it in' : ' and tell your admin'}.</Text>}
        </View>
      )}
    </View>
  );
}

const useStyles = makeStyles((t) => ({
  card: { backgroundColor: t.c.surface, borderWidth: 1.5, borderColor: t.c.border, borderRadius: radius.lg, padding: 12, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 14, fontWeight: '700', color: t.c.text },
  sub: { fontSize: 12.5, color: t.c.muted, lineHeight: 18, marginTop: 2 },
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginTop: space.sm, marginBottom: 6 },
  calc: { backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 12, marginVertical: space.sm, gap: 4 },
  line: { flexDirection: 'row', justifyContent: 'space-between' },
  lineLabel: { fontSize: 13.5, color: t.c.textSoft },
  lineValue: { fontSize: 13.5, color: t.c.text, fontVariant: ['tabular-nums'] },
  bold: { fontWeight: '800', color: t.c.text },
  matrix: { borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md, overflow: 'hidden', marginTop: space.sm },
  mRow: { flexDirection: 'row' },
  mHead: { borderBottomWidth: 1, borderBottomColor: t.c.border },
  mCell: { flex: 1, padding: 8, fontSize: 12.5, color: t.c.textSoft },
  mCrit: { flex: 1.1, color: t.c.muted, fontWeight: '600' },
  edit: { padding: 8, alignItems: 'flex-end' },
  link: { fontSize: 13, fontWeight: '700', color: t.c.link },
}));
