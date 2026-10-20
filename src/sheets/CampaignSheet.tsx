import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Switch, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { num, plural, prettyPhone } from '../format';
import { Banner, Button, Chip, ChipBar, Field, Icon, IconButton, ProgressBar, Sheet } from '../ui';
import { fillWa, useWhatsApp, WaContact, WaMedia } from '../whatsapp';
import { native } from '../crm';
import { PLACEHOLDERS, WaTemplate } from '../waTemplates';

/*
 * Bulk WhatsApp campaign, from the Lists tab's bulk bar: pick one of the team's saved templates (or
 * write one, and save it), with {name} / [Name] and the rest filled in per person, pick how far apart the messages go out (a random
 * gap between the two delays, so WhatsApp does not read it as a bot), and start. The bridge does
 * the sending in the background; this sheet follows it with Pause / Resume / Cancel.
 */

const DELAY_MIN = 5;
const DELAY_MAX = 120;
const SEND_SEC = 2;   // roughly how long one send itself takes, on top of the gap

const minutes = (sec: number) => (sec < 90 ? `${Math.max(1, Math.round(sec))} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} h`);

export default function CampaignSheet({ contacts, onClose, onSetup }: {
  contacts: WaContact[] | null;
  onClose: () => void;
  onSetup: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const wa = useWhatsApp();
  const [tpl, setTpl] = useState<string>('');
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [minDelay, setMinDelay] = useState<number>(12);
  const [maxDelay, setMaxDelay] = useState<number>(25);
  const [spin, setSpin] = useState<boolean>(true);
  const [batch, setBatch] = useState<number>(20);
  const [rest, setRest] = useState<number>(3);   // minutes
  // A PDF, image or voice note sent to everyone, with the message as its caption.
  const [media, setMedia] = useState<WaMedia | null>(null);
  const [starting, setStarting] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [started, setStarted] = useState<boolean>(false);
  const [, setTick] = useState(0);
  // Templates: which one is loaded, the manager, and saving a new one.
  const [pickedId, setPickedId] = useState<string>('');
  const [managing, setManaging] = useState<WaTemplate[] | null>(null);
  const [savingAs, setSavingAs] = useState<string | null>(null);
  const [tplNote, setTplNote] = useState<string>('');

  const c = wa.status?.campaign;
  const running = !!c?.running;
  const progress = running || started;

  useEffect(() => {
    if (!contacts) return;
    const first = wa.templates.find((x) => x.isDefault) || wa.templates[0];
    setTpl(first?.text || wa.template);
    setPickedId(first?.id || '');
    setSel({ start: (first?.text || '').length, end: (first?.text || '').length });
    setManaging(null);
    setSavingAs(null);
    setTplNote('');
    setError('');
    setStarted(false);
    setMedia(null);
  }, [contacts]); // eslint-disable-line react-hooks/exhaustive-deps

  const attach = async () => {
    try {
      const f = await native.pickMediaFile();
      if (f) setMedia({ b64: f.b64, mime: f.mime, name: f.name, bytes: f.bytes, voice: /^audio\//.test(f.mime) });
    } catch (e: any) {
      setError(e?.message || String(e));
    }
  };

  // "Next in 14 s" keeps counting between polls.
  useEffect(() => {
    if (!contacts || !running) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [!!contacts, running]); // eslint-disable-line react-hooks/exhaustive-deps

  // One message per number.
  const list = useMemo(() => {
    const seen = new Set<string>();
    return (contacts || []).filter((x) => {
      const d = (x.phone || '').replace(/\D/g, '').slice(-10);
      if (d.length < 10 || seen.has(d)) return false;
      seen.add(d);
      return true;
    });
  }, [contacts]);

  const picked = wa.templates.find((x) => x.id === pickedId) || null;
  const pick = (x: WaTemplate) => { setPickedId(x.id); setTpl(x.text); setSel({ start: x.text.length, end: x.text.length }); setTplNote(''); };
  const saved = (where: 'team' | 'phone', what: string) => setTplNote(where === 'team' ? `${what} — shared with the team` : `${what} on this phone (the panel needs the latest crm_lib.php to share it)`);
  const saveAsNew = async () => {
    const title = (savingAs || '').trim();
    if (!title || !tpl.trim()) return;
    const x: WaTemplate = { id: `t${Date.now()}`, title: title.slice(0, 60), text: tpl.trim() };
    saved(await wa.setTemplates([...wa.templates, x]), `Saved “${x.title}”`);
    setPickedId(x.id);
    setSavingAs(null);
  };
  const updatePicked = async () => {
    if (!picked) return;
    saved(await wa.setTemplates(wa.templates.map((x) => (x.id === picked.id ? { ...x, text: tpl.trim() } : x))), `Updated “${picked.title}”`);
  };
  const saveManaged = async () => {
    if (!managing) return;
    const list = managing.filter((x) => x.text.trim());
    if (!list.some((x) => x.isDefault) && list[0]) list[0] = { ...list[0], isDefault: true };
    saved(await wa.setTemplates(list), 'Templates saved');
    setManaging(null);
  };

  const insert = (v: string) => {
    const next = tpl.slice(0, sel.start) + v + tpl.slice(sel.end);
    setTpl(next);
    const at = sel.start + v.length;
    setSel({ start: at, end: at });
  };

  const setMin = (v: number) => {
    const m = Math.max(DELAY_MIN, Math.min(DELAY_MAX, v));
    setMinDelay(m);
    if (maxDelay < m) setMaxDelay(m);
  };
  const setMax = (v: number) => setMaxDelay(Math.max(minDelay, Math.min(DELAY_MAX, v)));

  const avgGap = (minDelay + maxDelay) / 2 + SEND_SEC;
  const rests = batch > 0 ? Math.floor(Math.max(0, list.length - 1) / batch) : 0;
  const estimate = (list.length > 1 ? (list.length - 1) * avgGap : SEND_SEC) + rests * rest * 60 * 1.25;

  const start = async () => {
    if (!list.length || !tpl.trim()) return;
    setStarting(true);
    setError('');
    try {
      await wa.startCampaign(list, tpl.trim(), minDelay, maxDelay, spin, batch, rest * 60, media);
      setStarted(true);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setStarting(false);
    }
  };

  const confirmCancel = () => Alert.alert(
    'Cancel the campaign?',
    `${c ? c.total - c.done : 0} messages not sent yet will not go out. Those already sent stay sent.`,
    [{ text: 'Keep sending', style: 'cancel' }, { text: 'Cancel campaign', style: 'destructive', onPress: () => wa.control('cancel') }],
  );

  const sample = list[0];
  const ready = wa.configured && !!wa.status?.connected;

  /* ── progress ── */
  if (progress && c) {
    const done = c.done;
    const left = Math.max(0, c.total - done);
    const eta = left > 0 ? Math.max(0, (c.nextAt ? (c.nextAt - Date.now()) / 1000 : 0)) + (left - 1) * ((c.minDelaySec + c.maxDelaySec) / 2 + SEND_SEC) : 0;
    const lastFail = [...c.results].reverse().find((r) => !r.ok);
    return (
      <Sheet
        visible={!!contacts}
        onClose={onClose}
        title={running ? (c.paused ? 'Campaign paused' : 'Sending on WhatsApp') : c.cancelled ? 'Campaign cancelled' : 'Campaign finished'}
        subtitle={running ? 'Runs on the bridge — you can close this and keep calling.' : `${plural(c.sent, 'message')} sent`}
        footer={running ? (
          <View style={s.footer}>
            {c.paused
              ? <Button label="Resume" icon="play_arrow" variant="success" onPress={() => wa.control('resume')} style={{ flex: 1 }} />
              : <Button label="Pause" icon="pause" variant="secondary" onPress={() => wa.control('pause')} style={{ flex: 1 }} />}
            <Button label="Cancel" icon="stop" variant="secondary" onPress={confirmCancel} style={{ flex: 1 }} />
          </View>
        ) : (
          <View style={s.footer}>
            <Button label="Done" icon="check" onPress={onClose} style={{ flex: 1 }} />
          </View>
        )}
      >
        <View style={s.stats}>
          <Stat label="Sent" value={`${num(c.sent)}/${num(c.total)}`} color={t.c.success} />
          <Stat label="Failed" value={num(c.failed)} color={c.failed ? t.c.danger : t.c.muted} />
          <Stat label="Time left" value={running && left ? `~${minutes(eta)}` : '—'} color={t.c.link} />
        </View>
        <ProgressBar value={c.total ? done / c.total : 0} color={t.c.emerald} />
        {running && (
          <Text style={s.now}>
            {c.paused ? 'Paused — nothing is sent until you resume.'
              : c.currentPhone && !c.nextAt ? `Sending to ${prettyPhone(c.currentPhone)}…`
              : c.nextAt ? `${c.cooling ? 'Resting after a batch — next' : 'Next message'} in ${Math.max(0, Math.ceil((c.nextAt - Date.now()) / 1000))} s` : 'Starting…'}
          </Text>
        )}
        {!!lastFail && (
          <Text style={s.fail} numberOfLines={2}>Last failure: {prettyPhone(lastFail.phone)} — {lastFail.error}</Text>
        )}
        {!wa.status?.connected && running && (
          <Banner tone="warning" icon="link_off" title="WhatsApp disconnected" message="The campaign is held until the bridge is linked again." actionLabel="Open" onAction={onSetup} />
        )}
      </Sheet>
    );
  }

  /* ── the templates manager ── */
  if (managing) {
    return (
      <Sheet
        visible={!!contacts}
        onClose={() => setManaging(null)}
        title="WhatsApp templates"
        subtitle="Shared with the team. {name} or [Name] = first name · {fullname} · {segment} · {phone} · {me}. ★ = used for one-tap WhatsApp."
        footer={(
          <View style={s.footer}>
            <Button label="Add template" icon="add" variant="secondary" onPress={() => setManaging([...managing, { id: `t${Date.now()}`, title: 'New template', text: 'Hi {name}, ' }])} style={{ flex: 1 }} />
            <Button label="Save" icon="check" onPress={saveManaged} style={{ flex: 1 }} />
          </View>
        )}
      >
        {managing.map((x, i) => (
          <View key={x.id} style={s.tplCard}>
            <View style={s.tplHead}>
              <View style={{ flex: 1 }}><Field label="Name" value={x.title} onChangeText={(v) => setManaging(managing.map((y, j) => (j === i ? { ...y, title: v } : y)))} maxLength={60} /></View>
              <IconButton
                icon={x.isDefault ? 'star' : 'star_border'}
                label={x.isDefault ? 'The one-tap template' : 'Use for one-tap WhatsApp'}
                color={x.isDefault ? t.c.amber : undefined}
                onPress={() => setManaging(managing.map((y, j) => ({ ...y, isDefault: j === i })))}
              />
              <IconButton icon="delete_outline" label={`Delete ${x.title}`} color={t.c.danger} disabled={managing.length <= 1} onPress={() => setManaging(managing.filter((_, j) => j !== i))} />
            </View>
            <Field label="Message" value={x.text} onChangeText={(v) => setManaging(managing.map((y, j) => (j === i ? { ...y, text: v } : y)))} multiline maxLength={1000} />
          </View>
        ))}
      </Sheet>
    );
  }

  /* ── compose ── */
  return (
    <Sheet
      visible={!!contacts}
      onClose={onClose}
      title="WhatsApp campaign"
      subtitle={`${plural(list.length, 'contact')}${contacts && contacts.length > list.length ? ` · ${contacts.length - list.length} skipped (no number or listed twice)` : ''}`}
      footer={
        <View style={s.footer}>
          <Button
            label={running ? 'Another campaign is running' : `Send to ${plural(list.length, 'person', 'people')}`}
            icon="send"
            variant="success"
            onPress={start}
            loading={starting}
            disabled={!ready || running || !list.length || !tpl.trim()}
            style={{ flex: 1 }}
          />
        </View>
      }
    >
      {!ready && (
        <Banner
          tone="warning"
          icon="qr_code"
          title={wa.configured ? 'WhatsApp is not connected' : 'Set up the WhatsApp bridge'}
          message={wa.configured ? wa.bridgeError || 'Scan the QR to link a WhatsApp account first.' : 'Campaigns send through the bridge on your computer.'}
          actionLabel={wa.configured ? 'Scan QR' : 'Set up'}
          onAction={onSetup}
        />
      )}
      {!!error && <Banner tone="danger" icon="error_outline" message={error} />}

      <View style={s.tplRow}>
        <Text style={[s.label, { flex: 1, marginTop: 0 }]}>Template</Text>
        <Pressable onPress={() => setManaging(wa.templates.map((x) => ({ ...x })))} hitSlop={8} accessibilityRole="button"><Text style={s.link}>Manage</Text></Pressable>
      </View>
      <ChipBar>
        {wa.templates.map((x) => <Chip key={x.id} label={`${x.isDefault ? '★ ' : ''}${x.title}`} selected={pickedId === x.id} onPress={() => pick(x)} />)}
      </ChipBar>
      <Field
        label="Message"
        value={tpl}
        onChangeText={(v) => { setTpl(v); setTplNote(''); }}
        onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        multiline
        maxLength={1000}
        hint={`${tpl.length} characters · write {name} or [Name] — “Samiye Patel” gets “Hi Samiye”`}
      />
      <ChipBar>
        {PLACEHOLDERS.map((v) => <Chip key={v.token} label={v.label} icon="add" onPress={() => insert(v.token)} />)}
      </ChipBar>
      {savingAs != null ? (
        <View style={s.saveRow}>
          <View style={{ flex: 1 }}><Field label="Template name" value={savingAs} onChangeText={setSavingAs} placeholder="e.g. Webinar follow-up" maxLength={60} autoFocus /></View>
          <Button label="Save" icon="check" size="sm" onPress={saveAsNew} disabled={!savingAs.trim() || !tpl.trim()} style={{ marginTop: 26 }} />
        </View>
      ) : (
        <View style={s.saveRow}>
          <Button label="Save as new template" icon="add" size="sm" variant="secondary" onPress={() => setSavingAs('')} disabled={!tpl.trim()} />
          {!!picked && picked.text !== tpl.trim() && !!tpl.trim() && (
            <Button label={`Update “${picked.title}”`} icon="check" size="sm" variant="soft" onPress={updatePicked} />
          )}
        </View>
      )}
      {!!tplNote && <Text style={s.tplNote}>{tplNote}</Text>}
      {media ? (
        <View style={s.file}>
          <Icon name={/^audio\//.test(media.mime) ? 'mic' : 'upload_file'} size={20} color={t.c.link} />
          <View style={{ flex: 1 }}>
            <Text style={s.fileName} numberOfLines={1}>{media.name}</Text>
            <Text style={s.spinDesc}>{Math.max(1, Math.round((media.bytes || 0) / 1024))} KB · sent to everyone{/^audio\//.test(media.mime) ? (media.voice ? ' as a voice note' : ' as an audio file') : ', message as its caption'}</Text>
          </View>
          {/^audio\//.test(media.mime) && (
            <Switch value={!!media.voice} onValueChange={(v) => setMedia({ ...media, voice: v })} trackColor={{ false: t.c.borderStrong, true: t.c.primaryLine }} thumbColor={media.voice ? t.c.primary : t.c.surface} accessibilityLabel="Send as a voice note" />
          )}
          <IconButton icon="close" label="Remove the file" size={32} onPress={() => setMedia(null)} />
        </View>
      ) : (
        <Button label="Attach a PDF, image or voice note" icon="upload_file" size="sm" variant="secondary" onPress={attach} style={{ alignSelf: 'flex-start', marginTop: space.sm }} />
      )}
      {!!sample && !!tpl.trim() && (
        <View style={s.preview}>
          <Text style={s.previewLabel}>Preview · {sample.name || prettyPhone(sample.phone)}</Text>
          <Text style={s.previewText}>{fillWa(tpl, sample, wa.me)}</Text>
        </View>
      )}

      <Text style={s.label}>Anti-ban delay between messages</Text>
      <Stepper label="At least" value={minDelay} onChange={setMin} />
      <Stepper label="At most" value={maxDelay} onChange={setMax} />
      <Stepper label="Rest after every" value={batch} unit="msgs" min={0} max={200} step={5} onChange={setBatch} />
      <Stepper label="Rest for" value={rest} unit="min" min={1} max={30} step={1} onChange={setRest} />
      <View style={s.spinRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.spinTitle}>Vary the greeting</Text>
          <Text style={s.spinDesc}>Hi / Hello / Hey, so the messages are not all identical.</Text>
        </View>
        <Switch
          value={spin}
          onValueChange={setSpin}
          trackColor={{ false: t.c.borderStrong, true: t.c.primaryLine }}
          thumbColor={spin ? t.c.primary : t.c.surface}
          accessibilityLabel="Vary the greeting"
        />
      </View>
      <View style={s.estimate}>
        <Icon name="timer" size={18} color={t.c.muted} />
        <Text style={s.estimateText}>About {minutes(estimate)} for {plural(list.length, 'message')}. Keep campaigns small: bulk sending from a normal WhatsApp account can get it banned.</Text>
      </View>
    </Sheet>
  );
}

const Stepper = ({ label, value, onChange, unit = 's', min = DELAY_MIN, max = DELAY_MAX, step }: {
  label: string; value: number; onChange: (v: number) => void; unit?: string; min?: number; max?: number; step?: number;
}) => {
  const s = useStyles();
  const down = step ?? (value > 30 ? 5 : 1);
  const up = step ?? (value >= 30 ? 5 : 1);
  return (
    <View style={s.stepper}>
      <Text style={s.stepLabel}>{label}</Text>
      <IconButton icon="remove" label={`${label}: less`} size={36} tone="outlined" disabled={value <= min} onPress={() => onChange(Math.max(min, value - down))} />
      <Text style={s.stepValue}>{value} {unit}</Text>
      <IconButton icon="add" label={`${label}: more`} size={36} tone="outlined" disabled={value >= max} onPress={() => onChange(Math.min(max, value + up))} />
    </View>
  );
};

const Stat = ({ label, value, color }: { label: string; value: string; color: string }) => {
  const s = useStyles();
  return (
    <View style={s.stat}>
      <Text style={[s.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
};

const useStyles = makeStyles((t) => ({
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginBottom: 4, marginTop: space.lg },
  preview: { backgroundColor: t.c.successSoft, borderRadius: radius.md, padding: 12, marginTop: space.sm },
  previewLabel: { fontSize: 11, fontWeight: '700', color: t.c.success, marginBottom: 4 },
  previewText: { fontSize: 13.5, color: t.c.text, lineHeight: 19 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  stepLabel: { flex: 1, fontSize: 14, color: t.c.text },
  stepValue: { width: 64, textAlign: 'center', fontSize: 15, fontWeight: '700', color: t.c.text, fontVariant: ['tabular-nums'] },
  spinRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  spinTitle: { fontSize: 14, color: t.c.text, fontWeight: '600' },
  spinDesc: { fontSize: 12, color: t.c.muted, marginTop: 2 },
  estimate: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 12, marginTop: space.sm },
  estimateText: { flex: 1, fontSize: 12.5, color: t.c.textSoft, lineHeight: 18 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md, padding: 10, marginTop: space.sm },
  fileName: { fontSize: 13.5, fontWeight: '700', color: t.c.text },
  tplRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.sm, marginBottom: 8 },
  link: { fontSize: 13, fontWeight: '700', color: t.c.link },
  saveRow: { flexDirection: 'row', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  tplNote: { fontSize: 12, color: t.c.success, marginTop: 6, fontWeight: '600' },
  tplCard: { borderWidth: 1, borderColor: t.c.border, borderRadius: radius.lg, padding: 12, paddingTop: 0, marginBottom: space.md },
  tplHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  stats: { flexDirection: 'row', gap: 8, marginBottom: space.md },
  stat: { flex: 1, backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11.5, color: t.c.muted, marginTop: 2 },
  now: { fontSize: 13, fontWeight: '600', color: t.c.success, marginTop: space.md },
  fail: { fontSize: 12, color: t.c.danger, marginTop: space.sm },
}));
