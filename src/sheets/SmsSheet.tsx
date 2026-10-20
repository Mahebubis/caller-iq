import React, { useEffect, useState } from 'react';
import { Linking, NativeModules, Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { prettyPhone } from '../format';
import { SmsTarget } from '../types';
import { OFFER } from '../sales';
import { Button, Chip, ChipBar, Field, IconButton, Sheet } from '../ui';

const { CallBridge } = NativeModules;

/*
 * The quick SMS after an unanswered call: pick a template, check the text, send. The text opens
 * ready to go in the phone's messaging app (no SMS permission needed), and the send is logged on
 * the contact's row in the panel. Templates are this phone's own and can be edited here;
 * [Name], [Segment] and [Me] are filled in for each contact.
 */

interface Template { title: string; text: string }

const CACHE_TEMPLATES = 'sms_templates_v1';
const DEFAULT_TEMPLATES: Template[] = [
  { title: 'Missed call', text: 'Hi [Name], we tried returning your missed call. Please let us know a good time to reach you.' },
  { title: 'Couldn’t reach you', text: 'Hi [Name], this is [Me] from Internship Studio. I tried calling you about [Segment] — when is a good time to talk?' },
  { title: 'Will call back', text: 'Hi [Name], thanks for your time. I’ll call you back as we discussed. — [Me]' },
];

const fill = (text: string, target: SmsTarget, me: string) => text
  .replace(/\[Name\]/gi, (target.name || '').trim().split(/\s+/)[0] || 'there')
  .replace(/\[Segment\]/gi, OFFER)
  .replace(/\[Me\]/gi, me || 'our team');

export default function SmsSheet({ target, myName, onSent, onClose }: {
  target: SmsTarget | null;
  myName: string;
  onSent: (template: string, body: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const [templates, setTemplates] = useState<Template[]>(DEFAULT_TEMPLATES);
  const [picked, setPicked] = useState<number>(0);
  const [body, setBody] = useState<string>('');
  const [editing, setEditing] = useState<boolean>(false);
  const [sending, setSending] = useState<boolean>(false);

  useEffect(() => {
    CallBridge?.loadUiCache?.(CACHE_TEMPLATES).then((raw: string) => {
      try {
        const saved = raw ? JSON.parse(raw) : null;
        if (Array.isArray(saved) && saved.length) setTemplates(saved);
      } catch (_) {}
    }).catch(() => {});
  }, []);

  // Each time it opens: the first template, filled in for this contact.
  useEffect(() => {
    if (!target) return;
    setPicked(0);
    setEditing(false);
    setBody(fill(templates[0]?.text || '', target, myName));
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (i: number) => {
    setPicked(i);
    if (target) setBody(fill(templates[i].text, target, myName));
  };

  const saveTemplates = (next: Template[]) => {
    setTemplates(next);
    CallBridge?.saveUiCache?.(CACHE_TEMPLATES, JSON.stringify(next));
  };
  const editTemplate = (i: number, patch: Partial<Template>) => saveTemplates(templates.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const send = async () => {
    if (!target || !body.trim()) return;
    setSending(true);
    try {
      await Linking.openURL(`sms:${target.number}?body=${encodeURIComponent(body.trim())}`);
      await onSent(templates[picked]?.title || 'Custom', body.trim());
    } finally {
      setSending(false);
    }
  };

  const who = target ? target.name || prettyPhone(target.number) : '';
  return (
    <Sheet
      visible={!!target}
      onClose={onClose}
      title={editing ? 'SMS templates' : 'Send a quick SMS'}
      subtitle={editing ? 'Saved on this phone. [Name], [Segment] and [Me] are filled in for each contact.' : `${who}${target?.name ? ` · ${prettyPhone(target.number)}` : ''}`}
      footer={editing ? (
        <View style={s.footer}>
          <Button label="Add template" icon="add" variant="secondary" onPress={() => saveTemplates([...templates, { title: 'New template', text: 'Hi [Name], ' }])} style={{ flex: 1 }} />
          <Button label="Done" icon="check" onPress={() => { setEditing(false); pick(Math.min(picked, templates.length - 1)); }} style={{ flex: 1 }} />
        </View>
      ) : (
        <View style={s.footer}>
          <Button label="Templates" icon="edit_note" variant="secondary" onPress={() => setEditing(true)} style={{ flex: 1 }} />
          <Button label="Send SMS" icon="sms" variant="success" onPress={send} loading={sending} disabled={!body.trim()} style={{ flex: 2 }} />
        </View>
      )}
    >
      {editing ? templates.map((tp, i) => (
        <View key={i} style={s.tplCard}>
          <View style={s.tplHead}>
            <View style={{ flex: 1 }}>
              <Field label="Name" value={tp.title} onChangeText={(v) => editTemplate(i, { title: v })} maxLength={40} />
            </View>
            <IconButton
              icon="delete_outline"
              label={`Delete template ${tp.title}`}
              color={t.c.danger}
              disabled={templates.length <= 1}
              onPress={() => saveTemplates(templates.filter((_, j) => j !== i))}
            />
          </View>
          <Field label="Text" value={tp.text} onChangeText={(v) => editTemplate(i, { text: v })} multiline maxLength={480} />
        </View>
      )) : (
        <>
          <ChipBar>
            {templates.map((tp, i) => <Chip key={i} label={tp.title} selected={picked === i} onPress={() => pick(i)} />)}
          </ChipBar>
          <Field label="Message" value={body} onChangeText={setBody} multiline maxLength={480} hint={`${body.length} characters · opens in your messaging app to send`} />
          <Pressable onPress={() => setEditing(true)} hitSlop={8} accessibilityRole="button">
            <Text style={s.link}>Edit templates</Text>
          </Pressable>
        </>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
  tplCard: { borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md, padding: 12, paddingTop: 0, marginBottom: space.md },
  tplHead: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  link: { fontSize: 13, fontWeight: '600', color: t.c.link, marginTop: space.md },
}));
