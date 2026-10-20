import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, NativeModules, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from '../theme';
import { ago, callbackTime, prettyPhone, serverTime } from '../format';
import { AttemptBadge, Button, Chip, ChipBar, Field, Icon, IconButton, Pill, ProgressBar, Segmented } from '../ui';
import { useToast } from '../ui';
import { MAX_ATTEMPTS, ScheduleTarget, SmsTarget } from '../types';
import {
  BANT, bantPct, crm, EMPTY_META, heatScore, hourWindow, LOST_REASONS, LostReason, Meta, native, SENTIMENTS, Sentiment, Stage, STAGES,
  TimelineItem, waited,
} from '../crm';
import {
  CACHE_LINKS, DEFAULT_LINKS, fillSales, Lang, LANGS, OBJECTIONS, Objection, PITCHES, SalesLinks, SCRIPTS, TEMPLATES, TemplateKey,
} from '../sales';
import { usePoints, useUndo } from '../engage';
import { useWaSend } from '../whatsapp';
import { AttachPanel, BattlePanel, DripPanel, OfferCalculator } from './FocusExtras';

const { CallBridge } = NativeModules;

/*
 * Focus mode: one contact, everything needed to win them, full screen. The call script in four
 * languages (teleprompter), a rebuttal for each objection, BANT qualification and buyer sentiment
 * (which make the heat score), the deal stage (Converted asks for a referral, Not interested for
 * the reason), WhatsApp pitches to send mid-call, a 4-hour offer hold with an automatic reminder,
 * notes typed or dictated, voice notes, and the whole timeline. Every change is saved to the panel
 * straight away and can be undone. Also: files and voice notes to send, a 3-step follow-up drip, the
 * offer calculator and the competitor battle matrix (FocusExtras.tsx).
 */

export interface FocusTarget {
  number: string;
  name?: string;
  segment?: string;
  email?: string;
  /** Position (#) in the view it was opened from; 0 when pinned. */
  index?: number;
  pinned?: boolean;
  importId?: number;
  rowId?: number;
  attempts?: number;
  importStatus?: string;
  statusLabel?: string;
  bestHour?: number | null;
  waitingSince?: number;
  dueAt?: number;
  meta?: Partial<Meta> | null;
  /** Opened right after a sale from the call bar: ask for a referral straight away. */
  prompt?: 'referral';
}

interface Props {
  target: FocusTarget | null;
  myName: string;
  onClose: () => void;
  onDial: (number: string) => void;
  onSchedule: (t: ScheduleTarget) => void;
  onSms: (t: SmsTarget) => void;
  /** The contact's deal fields changed: lists and boards update their copy. */
  onMeta?: (number: string, meta: Meta) => void;
  onEditRow?: (t: FocusTarget, patch: { name?: string; phone?: string; status?: string }) => Promise<void>;
  onPin?: (t: FocusTarget, pinned: boolean) => Promise<void>;
  /** A referral was added to a list: it should show at the top. */
  onReferral?: (importId: number) => void;
  /** Settings unlocked: the team's plans and battle matrix can be edited here. */
  admin?: boolean;
}

const IMPORT_STATUSES = [
  { key: 'needs_callback', label: 'Needs callback' }, { key: 'missed_call', label: 'Missed call' }, { key: 'not_called', label: 'Not called' },
  { key: 'pending_followup', label: 'Pending follow-up' }, { key: 'called', label: 'Called' },
];
const OFFER_HOURS = 4;
const OFFER_REMIND_MIN = 30;

const KIND_ICON: { [k: string]: { icon: any; label: string } } = {
  call: { icon: 'call', label: 'Call' }, note: { icon: 'edit_note', label: 'Note' }, dictation: { icon: 'edit_note', label: 'Dictated' },
  memo: { icon: 'phone_in_talk', label: 'Voice note' }, wa_out: { icon: 'chat', label: 'WhatsApp sent' }, wa_in: { icon: 'chat_bubble_outline', label: 'WhatsApp reply' },
  sms: { icon: 'sms', label: 'SMS' }, status: { icon: 'sell', label: 'Update' }, offer: { icon: 'timer', label: 'Offer' }, referral: { icon: 'groups', label: 'Referral' },
};

export default function FocusSheet(p: Props) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const wa = useWaSend();
  const points = usePoints();
  const undo = useUndo();
  const tg = p.target;

  const [meta, setMeta] = useState<Meta>(EMPTY_META);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [lang, setLang] = useState<Lang>('en');
  const [step, setStep] = useState<number>(0);
  const [objection, setObjection] = useState<Objection | null>(null);
  const [links, setLinks] = useState<SalesLinks>(DEFAULT_LINKS);
  const [editLinks, setEditLinks] = useState<boolean>(false);
  const [note, setNote] = useState<string>('');
  const [busy, setBusy] = useState<string>('');
  const [recording, setRecording] = useState<number>(0);
  const [playing, setPlaying] = useState<number>(0);
  const [editing, setEditing] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>('');
  const [editPhone, setEditPhone] = useState<string>('');
  const [referral, setReferral] = useState<boolean>(false);
  const [refName, setRefName] = useState<string>('');
  const [refPhone, setRefPhone] = useState<string>('');
  const [pinned, setPinned] = useState<boolean>(false);
  const [, setTick] = useState(0);
  const live = useRef<any>({});
  live.current = { meta, tg };

  /* Opening: what the list knew straight away, then the panel's full copy and the timeline. */
  const load = useCallback(async (number: string) => {
    setLoading(true);
    try {
      const d = await crm.timeline(number);
      setItems(d.items);
      if (d.meta) setMeta({ ...EMPTY_META, ...d.meta });
    } catch (e: any) {
      toast(`Timeline not loaded — ${e?.message || e}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!tg) return;
    setMeta({ ...EMPTY_META, ...(tg.meta || {}) } as Meta);
    setItems([]);
    setStep(0);
    setObjection(null);
    setNote('');
    setEditing(false);
    setReferral(tg.prompt === 'referral');
    setPinned(!!tg.pinned);
    load(tg.number);
    CallBridge?.loadUiCache?.(CACHE_LINKS).then((raw: string) => {
      try {
        const saved = raw ? { ...DEFAULT_LINKS, ...JSON.parse(raw) } : DEFAULT_LINKS;
        setLinks(saved);
        setLang(saved.lang || 'en');
      } catch (_) {}
    }).catch(() => {});
  }, [tg?.number]); // eslint-disable-line react-hooks/exhaustive-deps

  // Offer countdown and "waiting" keep ticking.
  useEffect(() => {
    if (!tg) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [!!tg]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = native.events?.addListener('CallIQAudioDone', () => setPlaying(0));
    return () => sub?.remove();
  }, []);

  const saveLinks = (next: SalesLinks) => {
    setLinks(next);
    CallBridge?.saveUiCache?.(CACHE_LINKS, JSON.stringify(next));
  };
  const pickLang = (l: Lang) => { setLang(l); saveLinks({ ...links, lang: l }); };

  const vars = useMemo(() => ({ name: tg?.name, segment: tg?.segment, me: p.myName }), [tg?.name, tg?.segment, p.myName]);

  /* ── saving deal fields, with undo ── */
  const save = useCallback(async (patch: Parameters<typeof crm.metaSet>[1], label: string, withUndo = true) => {
    const target = live.current.tg as FocusTarget | null;
    if (!target) return;
    const before: Meta = live.current.meta;
    // Shown at once; the panel's answer replaces it.
    setMeta((m) => {
      const next = { ...m, ...patch } as any;
      if (patch.bant != null || patch.sentiment != null) next.heat = heatScore(next.bant, next.sentiment);
      if (patch.lost_reason) next.stage = 'lost';
      return next;
    });
    try {
      const r = await crm.metaSet(target.number, patch);
      if (r.meta) {
        const m = { ...EMPTY_META, ...r.meta };
        setMeta(m);
        p.onMeta?.(target.number, m);
      }
      points.celebrate(r.awarded);
      if (withUndo) {
        undo.push(label, async () => {
          const back = await crm.metaSet(target.number, {
            stage: (before.stage || 'new') as Stage, sentiment: before.sentiment, bant: before.bant,
            lost_reason: before.lost_reason, dnd: !!before.dnd, ...(before.offer_until ? {} : { offer_clear: true }),
          });
          const m = { ...EMPTY_META, ...back.meta };
          setMeta(m);
          p.onMeta?.(target.number, m);
        });
      }
    } catch (e: any) {
      setMeta(before);
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  }, [p, points, undo, toast]);

  if (!tg) return null;

  const number = tg.number;
  const who = tg.name || prettyPhone(number);
  const pct = bantPct(meta.bant);
  const offerUntil = serverTime(meta.offer_until);
  const offerLeft = offerUntil - Date.now();
  const lostMode = meta.stage === 'lost';
  const replied = !!meta.replied_at && !meta.dnd && (!meta.reply_ack_at || serverTime(meta.reply_ack_at) < serverTime(meta.replied_at));

  const setStage = (st: Stage) => {
    if (st === meta.stage) return;
    save({ stage: st }, `Moved ${who} to ${STAGES.find((x) => x.key === st)?.label}`);
    if (st === 'converted') {
      setReferral(true);
      points.confetti();
    }
  };

  const sendTemplate = async (key: TemplateKey, link?: string, how?: string) => {
    if (!!meta.dnd && key !== 'thanks') {
      toast(`${who} opted out (DND) — message not sent`, 'error');
      return;
    }
    setBusy(key);
    try {
      const text = fillSales(TEMPLATES[lang][key], { ...vars, link, price: links.priceText, until: offerUntil ? callbackTime(offerUntil) : '' });
      // Links go inside the text; a direct file link (PDF, image) is also sent as the file itself.
      const isFile = !!link && /\.(pdf|png|jpe?g|webp|mp4)(\?|$)/i.test(link);
      await wa.sendOne({ name: tg.name, phone: number, segment: tg.segment }, text, { mediaUrl: isFile ? link : undefined, how: how || 'WhatsApp pitch' });
      load(number);
    } finally {
      setBusy('');
    }
  };

  const startOffer = async () => {
    await save({ offer_hours: OFFER_HOURS }, `Offer held for ${who}`);
    const until = Date.now() + OFFER_HOURS * 3600 * 1000;
    const text = fillSales(TEMPLATES[lang].offer, { ...vars, until: callbackTime(until) });
    const ok = await wa.schedule(`offer_${number.slice(-10)}`, { name: tg.name, phone: number, segment: tg.segment }, text, until - OFFER_REMIND_MIN * 60 * 1000);
    toast(ok ? `Offer held ${OFFER_HOURS} h — WhatsApp reminder ${OFFER_REMIND_MIN} min before it ends` : `Offer held ${OFFER_HOURS} h (set up the WhatsApp bridge for the automatic reminder)`);
  };
  const clearOffer = () => {
    save({ offer_clear: true }, 'Offer cleared', false);
    wa.unschedule(`offer_${number.slice(-10)}`);
  };

  const toggleBant = (bit: number) => save({ bant: meta.bant ^ bit }, 'Qualification changed');
  const pickSentiment = (k: Sentiment) => save({ sentiment: meta.sentiment === k ? '' : k }, 'Sentiment changed');
  const pickLost = (k: LostReason) => save({ lost_reason: k }, `Marked not interested: ${k}`);
  const toggleDnd = () => {
    const on = !meta.dnd;
    save({ dnd: on }, on ? `${who} marked DND` : 'DND removed');
    wa.setDnd(number, on);
  };

  const saveNote = async (kind: 'note' | 'dictation' = 'note') => {
    const text = note.trim();
    if (!text) return;
    setBusy('note');
    try {
      await crm.noteAdd(number, text, kind);
      setNote('');
      load(number);
      toast('Note saved');
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    } finally {
      setBusy('');
    }
  };
  const dictate = async () => {
    try {
      const heard = await native.recognizeSpeech(LANGS.find((l) => l.key === lang)?.speech || 'en-IN', `Note for ${who}`);
      if (heard) setNote((n) => (n ? `${n} ${heard}` : heard));
    } catch (e: any) {
      toast(e?.message || String(e), 'error');
    }
  };
  const toggleMemo = async () => {
    try {
      if (!recording) {
        await native.startMemo();
        setRecording(Date.now());
        return;
      }
      const m = await native.stopMemo();
      setRecording(0);
      setBusy('memo');
      await crm.memoUpload(number, m.b64, m.mime, m.durationMs);
      toast('Voice note saved');
      load(number);
    } catch (e: any) {
      setRecording(0);
      toast(e?.message || String(e), 'error');
    } finally {
      setBusy('');
    }
  };
  const play = async (id: number) => {
    try {
      if (playing === id) { await native.stopAudio(); setPlaying(0); return; }
      setPlaying(id);
      const m = await crm.memoGet(id);
      await native.playAudio(m.b64);
    } catch (e: any) {
      setPlaying(0);
      toast(e?.message || String(e), 'error');
    }
  };

  const addReferral = async () => {
    if (!tg.importId || !refPhone.trim()) return;
    setBusy('referral');
    try {
      const r = await crm.referral(number, tg.importId, refName.trim(), refPhone.trim());
      points.celebrate(r.awarded);
      setReferral(false);
      setRefName('');
      setRefPhone('');
      p.onReferral?.(tg.importId);
      toast(`${refName.trim() || 'Referral'} added at the top of the list`);
      // The thank-you to the customer who referred them.
      wa.sendOne({ name: tg.name, phone: number, segment: tg.segment }, fillSales(TEMPLATES[lang].thanks, vars), { how: 'Thank-you', quiet: true });
    } catch (e: any) {
      toast(`Not added — ${e?.message || e}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const startEdit = () => { setEditName(tg.name || ''); setEditPhone(number); setEditing(true); };
  const saveEdit = async (status?: string) => {
    if (!p.onEditRow) return;
    setBusy('edit');
    try {
      await p.onEditRow(tg, status ? { status } : { name: editName.trim(), phone: editPhone.trim() });
      if (!status) setEditing(false);
    } finally {
      setBusy('');
    }
  };
  const togglePin = async () => {
    if (!p.onPin) return;
    const next = !pinned;
    setPinned(next);
    try { await p.onPin(tg, next); } catch (_) { setPinned(!next); }
  };

  const script = SCRIPTS[lang];
  const stepText = fillSales(script[Math.min(step, script.length - 1)].text, vars);
  const obj = OBJECTIONS.find((o) => o.key === objection);
  const waitingMs = tg.waitingSince ? Date.now() - tg.waitingSince : 0;
  const heatColor = meta.heat >= 70 ? t.c.danger : meta.heat >= 40 ? t.c.orange : t.c.blue;

  return (
    <Modal visible={!!tg} animationType="slide" onRequestClose={p.onClose}>
      <View style={s.screen}>
        {/* Header */}
        <View style={s.head}>
          <IconButton icon="arrow_back" label="Close the workspace" tone="outlined" onPress={p.onClose} />
          <View style={{ flex: 1 }}>
            <Text style={s.title} numberOfLines={1}>{tg.pinned || pinned ? '★ ' : tg.index ? `#${tg.index} ` : ''}{who}</Text>
            <Text style={s.sub} numberOfLines={1}>{tg.name ? `${prettyPhone(number)} · ` : ''}{tg.segment || 'No list'}</Text>
          </View>
          {!!p.onPin && tg.rowId != null && (
            <IconButton icon={pinned ? 'star' : 'star_border'} label={pinned ? 'Unpin from the top' : 'Pin as VIP at the top'} tone={pinned ? 'soft' : 'outlined'} color={pinned ? t.c.amber : undefined} onPress={togglePin} />
          )}
          {!!p.onEditRow && tg.rowId != null && <IconButton icon="edit_note" label="Edit name, number or status" tone="outlined" onPress={editing ? () => setEditing(false) : startEdit} />}
        </View>

        <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
          <View style={s.badges}>
            <AttemptBadge n={tg.attempts || 0} max={MAX_ATTEMPTS} />
            <Pill label={`Heat ${meta.heat}`} icon="bolt" fg={heatColor} bg={t.c.surfaceAlt} />
            {!!tg.statusLabel && <Pill label={replied ? 'Replied - Priority' : tg.statusLabel} fg={replied ? t.c.violet : t.c.textSoft} bg={replied ? t.c.violetSoft : t.c.surfaceAlt} dot />}
            {tg.bestHour != null && <Pill label={`Best time ${hourWindow(tg.bestHour)}`} icon="schedule" fg={t.c.success} bg={t.c.successSoft} />}
            {waitingMs > 0 && <Pill label={`Waiting ${waited(waitingMs)}`} icon="timer" fg={waitingMs > 30 * 60000 ? t.c.danger : t.c.warning} bg={waitingMs > 30 * 60000 ? t.c.dangerSoft : t.c.warningSoft} pulse={waitingMs > 30 * 60000} />}
            {!!meta.dnd && <Pill label="DND" icon="block" fg="#FFFFFF" bg={t.c.coral} />}
          </View>

          {replied && (
            <View style={s.reply}>
              <Text style={s.replyHead}>💬 Replied {ago(serverTime(meta.replied_at))}</Text>
              <Text style={s.replyText}>“{meta.reply_text}”</Text>
            </View>
          )}

          {editing && (
            <View style={s.card}>
              <Field label="Name" value={editName} onChangeText={setEditName} autoCapitalize="words" />
              <Field label="Phone" value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" />
              <Button label="Save name & number" icon="check" onPress={() => saveEdit()} loading={busy === 'edit'} />
              <Text style={s.label}>Status</Text>
              <ChipBar>
                {IMPORT_STATUSES.map((x) => <Chip key={x.key} label={x.label} selected={tg.importStatus === x.key} onPress={() => saveEdit(x.key)} />)}
              </ChipBar>
            </View>
          )}

          {/* The four main actions */}
          <View style={s.actions}>
            <Button label="Call" icon="call" variant="success" pill onPress={() => p.onDial(number)} style={{ flex: 1.3 }} />
            <Button label="WhatsApp" icon="chat" variant="secondary" pill loading={busy === 'missed'} onPress={() => sendTemplate('missed', undefined, 'WhatsApp')} style={{ flex: 1.3 }} />
            <IconButton icon="sms" label="Send an SMS" tone="outlined" onPress={() => p.onSms({ number, name: tg.name, segment: tg.segment })} />
            <IconButton icon="alarm" label="Schedule a callback" tone="outlined" onPress={() => p.onSchedule({ number, name: tg.name, segment: tg.segment, dueAt: tg.dueAt })} />
          </View>

          {/* Script */}
          <Segmented options={LANGS.map((l) => ({ key: l.key, label: l.label }))} value={lang} onChange={pickLang} />
          <View style={s.prompter}>
            <View style={s.stepRow}>
              {script.map((x, i) => (
                <Pressable key={x.title} onPress={() => setStep(i)} style={[s.stepChip, i === step && s.stepChipOn]} accessibilityRole="button">
                  <Text style={[s.stepChipText, i === step && { color: t.c.onPrimary }]}>{i + 1}. {x.title}</Text>
                </Pressable>
              ))}
            </View>
            <Text style={s.prompterText}>{stepText}</Text>
            <View style={s.stepNav}>
              <Button label="Back" size="sm" variant="secondary" disabled={step === 0} onPress={() => setStep(step - 1)} />
              <Button label="Next line" size="sm" disabled={step >= script.length - 1} onPress={() => setStep(step + 1)} />
            </View>
          </View>

          {/* Objections */}
          <Text style={s.section}>Objection busters</Text>
          <ChipBar>
            {OBJECTIONS.map((o) => <Chip key={o.key} label={o.label[lang]} selected={objection === o.key} onPress={() => setObjection(objection === o.key ? null : o.key)} />)}
          </ChipBar>
          {obj && (
            <View style={s.rebuttal}>
              <Text style={s.rebuttalText}>{fillSales(obj.reply[lang], vars)}</Text>
              {obj.key === 'details' && <Button label="Send details now" icon="send" size="sm" variant="success" loading={busy === 'brochure'} onPress={() => sendTemplate('brochure', links.brochure)} />}
              {obj.key === 'later' && <Button label="Schedule the callback" icon="alarm" size="sm" variant="secondary" onPress={() => p.onSchedule({ number, name: tg.name, segment: tg.segment })} />}
            </View>
          )}

          {/* Competitor they mentioned → the matrix to read out, logged for Analytics */}
          <Text style={s.section}>Competitor mentioned</Text>
          <BattlePanel
            competitor={meta.competitor || ''}
            admin={!!p.admin}
            onPick={(name) => save({ competitor: name }, name ? `Competitor: ${name}` : 'Competitor cleared')}
          />

          {/* Qualification */}
          <Text style={s.section}>Qualification · {pct}%</Text>
          <View style={s.bantRow}>
            {BANT.map((b) => {
              const on = !!(meta.bant & b.bit);
              return (
                <Pressable key={b.key} onPress={() => toggleBant(b.bit)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} style={[s.bant, on && s.bantOn]}>
                  <Icon name={on ? 'check_box' : 'check_box_outline_blank'} size={20} color={on ? t.c.onPrimary : t.c.muted} />
                  <Text style={[s.bantText, on && { color: t.c.onPrimary }]}>{b.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <ProgressBar value={pct / 100} color={pct >= 75 ? t.c.emerald : pct >= 50 ? t.c.amber : t.c.primary} />
          <ChipBar style={{ marginTop: space.md }}>
            {SENTIMENTS.map((x) => <Chip key={x.key} label={x.label} selected={meta.sentiment === x.key} onPress={() => pickSentiment(x.key)} />)}
          </ChipBar>

          {/* Stage */}
          <Text style={s.section}>Stage</Text>
          <ChipBar>
            {STAGES.map((x) => <Chip key={x.key} label={x.label} selected={(meta.stage || 'new') === x.key} onPress={() => setStage(x.key)} />)}
          </ChipBar>
          {lostMode && (
            <View style={s.card}>
              <Text style={s.label}>Why not?</Text>
              <ChipBar>
                {LOST_REASONS.map((x) => <Chip key={x.key} label={x.label} selected={meta.lost_reason === x.key} onPress={() => pickLost(x.key)} />)}
              </ChipBar>
            </View>
          )}
          {referral && (
            <View style={[s.card, { borderColor: t.c.emerald }]}>
              <Text style={s.cardTitle}>🎉 Sale closed! Anyone else who’d like this?</Text>
              <Text style={s.sub}>A friend added here goes to the top of {tg.segment || 'the list'} and earns referral points. {who} gets a thank-you on WhatsApp.</Text>
              <Field label="Friend’s name" value={refName} onChangeText={setRefName} autoCapitalize="words" />
              <Field label="Friend’s phone" value={refPhone} onChangeText={setRefPhone} keyboardType="phone-pad" />
              <View style={s.row}>
                <Button label="Not now" variant="secondary" onPress={() => setReferral(false)} style={{ flex: 1 }} />
                <Button label="Add referral" icon="add" variant="success" loading={busy === 'referral'} disabled={!tg.importId || !refPhone.trim()} onPress={addReferral} style={{ flex: 1.4 }} />
              </View>
            </View>
          )}

          {/* Mid-call pitches */}
          <View style={s.sectionRow}>
            <Text style={[s.section, { flex: 1 }]}>Send on WhatsApp now</Text>
            <Pressable onPress={() => setEditLinks(!editLinks)} hitSlop={8}><Text style={s.link}>{editLinks ? 'Done' : 'Links'}</Text></Pressable>
          </View>
          {editLinks && (
            <View style={s.card}>
              <Field label="Brochure / details link" value={links.brochure} onChangeText={(v) => saveLinks({ ...links, brochure: v })} autoCapitalize="none" placeholder="https://… (a PDF is sent as a file)" />
              <Field label="Plans / price link" value={links.pricing} onChangeText={(v) => saveLinks({ ...links, pricing: v })} autoCapitalize="none" />
              <Field label="Price line" value={links.priceText} onChangeText={(v) => saveLinks({ ...links, priceText: v })} placeholder="e.g. Basic ₹4,999 · Pro ₹7,999 · EMI from ₹999/month" />
              <Field label="Demo link" value={links.demo} onChangeText={(v) => saveLinks({ ...links, demo: v })} autoCapitalize="none" />
            </View>
          )}
          <View style={s.pitchGrid}>
            {PITCHES.map((x) => (
              <Button
                key={x.key}
                label={x.label}
                icon="send"
                size="sm"
                variant="soft"
                loading={busy === x.key}
                onPress={() => sendTemplate(x.key, x.link ? links[x.link] as string : undefined)}
                style={s.pitch}
              />
            ))}
          </View>

          <View style={{ marginTop: space.sm }}>
            <AttachPanel contact={{ name: tg.name, phone: number, segment: tg.segment }} lang={lang} vars={vars} onSent={() => load(number)} />
          </View>

          {/* Plan / offer calculator */}
          <Text style={s.section}>Offer calculator</Text>
          <OfferCalculator
            contact={{ name: tg.name, phone: number, segment: tg.segment }}
            lang={lang}
            vars={vars}
            offerUntil={offerUntil}
            admin={!!p.admin}
            onSent={() => load(number)}
          />

          {/* Offer hold */}
          <Text style={s.section}>Offer hold</Text>
          {offerUntil && offerLeft > 0 ? (
            <View style={[s.card, s.row, { alignItems: 'center', borderColor: offerLeft < 30 * 60000 ? t.c.coral : t.c.amber }]}>
              <Icon name="timer" size={24} color={offerLeft < 30 * 60000 ? t.c.danger : t.c.warning} />
              <View style={{ flex: 1 }}>
                <Text style={s.countdown}>{clockLeft(offerLeft)}</Text>
                <Text style={s.sub}>Price held until {callbackTime(offerUntil)}</Text>
              </View>
              <Button label="Clear" size="sm" variant="secondary" onPress={clearOffer} />
            </View>
          ) : (
            <Button label={`Hold the offer for ${OFFER_HOURS} hours`} icon="timer" variant="secondary" onPress={startOffer} />
          )}

          {/* Follow-up drip */}
          <Text style={s.section}>Follow-up drip</Text>
          <DripPanel contact={{ name: tg.name, phone: number, segment: tg.segment }} lang={lang} vars={vars} dnd={!!meta.dnd} />

          {/* Notes */}
          <Text style={s.section}>Notes</Text>
          <View style={s.noteBox}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Type, or tap the mic to dictate"
              placeholderTextColor={t.c.faint}
              multiline
              style={s.noteInput}
            />
            <View style={s.row}>
              <IconButton icon="mic" label="Dictate with the microphone" tone="soft" onPress={dictate} />
              <IconButton
                icon={recording ? 'stop' : 'fiber_manual_record'}
                label={recording ? 'Stop and save the voice note' : 'Record a voice note'}
                tone={recording ? 'soft' : 'outlined'}
                color={t.c.danger}
                onPress={toggleMemo}
              />
              {!!recording && <Text style={s.rec}>● {waited(Date.now() - recording).replace('m', ' min')}</Text>}
              {busy === 'memo' && <ActivityIndicator color={t.c.primary} />}
              <View style={{ flex: 1 }} />
              <Button label="Save note" icon="check" size="sm" onPress={() => saveNote()} loading={busy === 'note'} disabled={!note.trim()} />
            </View>
          </View>

          <View style={[s.row, { marginTop: space.md }]}>
            <Button label={meta.dnd ? 'Remove DND' : 'Mark DND'} icon="block" size="sm" variant="secondary" onPress={toggleDnd} style={{ flex: 1 }} />
          </View>

          {/* Timeline */}
          <Text style={s.section}>Timeline</Text>
          {loading && !items.length ? <ActivityIndicator color={t.c.primary} style={{ marginVertical: space.lg }} /> : null}
          {!loading && !items.length && <Text style={s.sub}>Nothing yet — calls, messages, notes and replies collect here.</Text>}
          {items.map((it, i) => {
            const k = KIND_ICON[it.kind] || KIND_ICON.status;
            return (
              <View key={`${it.kind}-${it.at}-${i}`} style={s.tl}>
                <View style={s.tlIcon}><Icon name={k.icon} size={16} color={it.kind === 'wa_in' ? t.c.violet : t.c.link} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={s.tlHead}>{k.label}{it.by ? ` · ${it.by}` : ''} · {ago(serverTime(it.at))}</Text>
                  {it.kind === 'memo' && it.id ? (
                    <Pressable onPress={() => play(it.id!)} style={s.memo} accessibilityRole="button">
                      <Icon name={playing === it.id ? 'stop' : 'play_arrow'} size={18} color={t.c.link} />
                      <Text style={s.link}>{playing === it.id ? 'Stop' : 'Play'} · {Math.round((it.duration_ms || 0) / 1000)} s</Text>
                    </Pressable>
                  ) : (
                    <Text style={s.tlText}>{it.text}</Text>
                  )}
                </View>
              </View>
            );
          })}
        </ScrollView>
      </View>
    </Modal>
  );
}

const clockLeft = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const x = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')} left`;
};

const useStyles = makeStyles((t) => ({
  screen: { flex: 1, backgroundColor: t.c.bg },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.lg, paddingVertical: 10,
    backgroundColor: t.c.surface, borderBottomWidth: 1, borderBottomColor: t.c.border,
  },
  title: { ...type.heading, color: t.c.text },
  sub: { fontSize: 12.5, color: t.c.muted, marginTop: 2, lineHeight: 18 },
  body: { padding: space.lg, paddingBottom: 120 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: space.md },
  reply: { backgroundColor: t.c.violetSoft, borderRadius: radius.md, padding: 12, marginBottom: space.md },
  replyHead: { fontSize: 12, fontWeight: '800', color: t.c.violet },
  replyText: { fontSize: 14, color: t.c.text, marginTop: 4 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: space.lg },
  card: { backgroundColor: t.c.surface, borderWidth: 1.5, borderColor: t.c.border, borderRadius: radius.lg, padding: 14, marginTop: space.sm, gap: 4 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: t.c.text },
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginTop: space.sm, marginBottom: 6 },
  section: { ...type.overline, color: t.c.muted, marginTop: space.xl, marginBottom: space.sm },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end' },
  link: { fontSize: 13, fontWeight: '700', color: t.c.link },
  row: { flexDirection: 'row', gap: 10, marginTop: space.sm },
  prompter: { backgroundColor: t.c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.c.border, padding: 14, marginTop: space.md },
  stepRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  stepChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: t.c.surfaceAlt },
  stepChipOn: { backgroundColor: t.c.primary },
  stepChipText: { fontSize: 12, fontWeight: '700', color: t.c.textSoft },
  prompterText: { fontSize: 19, lineHeight: 28, color: t.c.text, fontWeight: '500', marginVertical: space.md },
  stepNav: { flexDirection: 'row', justifyContent: 'space-between' },
  rebuttal: { backgroundColor: t.c.blueSoft, borderRadius: radius.md, padding: 14, marginTop: space.sm, gap: 10 },
  rebuttalText: { fontSize: 15, lineHeight: 22, color: t.c.text },
  bantRow: { flexDirection: 'row', gap: 6, marginBottom: space.sm },
  bant: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 10, borderRadius: radius.md, backgroundColor: t.c.surfaceAlt, borderWidth: 1, borderColor: t.c.border },
  bantOn: { backgroundColor: t.c.primary, borderColor: t.c.primary },
  bantText: { fontSize: 11.5, fontWeight: '700', color: t.c.textSoft },
  pitchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pitch: { flexBasis: '47%', flexGrow: 1 },
  countdown: { fontSize: 20, fontWeight: '800', color: t.c.text, fontVariant: ['tabular-nums'] },
  noteBox: { backgroundColor: t.c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.c.border, padding: 12 },
  noteInput: { minHeight: 70, color: t.c.text, fontSize: 14.5, textAlignVertical: 'top' },
  rec: { fontSize: 13, fontWeight: '800', color: t.c.danger, alignSelf: 'center' },
  tl: { flexDirection: 'row', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: t.c.divider },
  tlIcon: { width: 28, height: 28, borderRadius: 14, backgroundColor: t.c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  tlHead: { fontSize: 11.5, color: t.c.muted, fontWeight: '600' },
  tlText: { fontSize: 13.5, color: t.c.text, marginTop: 2, lineHeight: 19 },
  memo: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
}));
