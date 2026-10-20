import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { prettyPhone } from '../format';
import { Banner, Button, Chip, ChipBar, Field, Sheet } from '../ui';
import { useWhatsApp, WaContact, fillWa } from '../whatsapp';

/*
 * One WhatsApp to one person: pick a saved template (★ = the usual one), see exactly what they will
 * get with their name filled in, change it if needed, send. Opened by the WhatsApp buttons on a
 * person (list rows, callbacks, the live feed).
 */

export default function WaSendSheet({ contact, onClose, onManage }: {
  contact: WaContact | null;
  onClose: () => void;
  /** Opens the templates manager (the campaign sheet's). */
  onManage: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const wa = useWhatsApp();
  const [pickedId, setPickedId] = useState<string>('');
  const [text, setText] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  useEffect(() => {
    if (!contact) return;
    const first = wa.templates.find((x) => x.isDefault) || wa.templates[0];
    setPickedId(first?.id || '');
    setText(first ? fillWa(first.text, contact, wa.me) : '');
  }, [contact]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!contact) return null;
  const who = contact.name || prettyPhone(contact.phone);
  const viaBridge = wa.configured && !!wa.status?.connected;

  const send = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      const ok = await wa.sendOne(contact, text.trim(), { how: wa.templates.find((x) => x.id === pickedId)?.title || 'WhatsApp' });
      if (ok) onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <Sheet
      visible={!!contact}
      onClose={onClose}
      title={`WhatsApp ${contact.name ? contact.name.split(' ')[0] : ''}`.trim()}
      subtitle={`${who}${contact.name ? ` · ${prettyPhone(contact.phone)}` : ''}`}
      footer={(
        <View style={s.footer}>
          <Button label="Templates" icon="edit_note" variant="secondary" onPress={onManage} style={{ flex: 1 }} />
          <Button label={viaBridge ? 'Send' : 'Open in WhatsApp'} icon="send" variant="success" onPress={send} loading={sending} disabled={!text.trim()} style={{ flex: 1.6 }} />
        </View>
      )}
    >
      {!viaBridge && (
        <Banner tone="info" icon="chat" message="The WhatsApp bridge isn’t connected, so this opens WhatsApp on this phone with the message ready — tap Send there." />
      )}
      <Text style={s.label}>Template</Text>
      <ChipBar>
        {wa.templates.map((x) => (
          <Chip key={x.id} label={`${x.isDefault ? '★ ' : ''}${x.title}`} selected={pickedId === x.id} onPress={() => { setPickedId(x.id); setText(fillWa(x.text, contact, wa.me)); }} />
        ))}
      </ChipBar>
      <Field label={`What ${contact.name ? contact.name.split(' ')[0] : 'they'} will get`} value={text} onChangeText={setText} multiline maxLength={1000} hint={`${text.length} characters`} />
      <View style={s.tip}>
        <Text style={s.tipText}>Templates fill in the first name for you — “Samiye Patel” gets “Hi Samiye”. Make new ones under Templates.</Text>
      </View>
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  label: { fontSize: 12, fontWeight: '700', color: t.c.muted, marginTop: space.sm, marginBottom: 8 },
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
  tip: { backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 10, marginTop: space.sm },
  tipText: { fontSize: 12, color: t.c.muted, lineHeight: 17 },
}));
