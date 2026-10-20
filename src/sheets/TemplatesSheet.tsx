import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { Button, Field, IconButton, Sheet } from '../ui';
import { useWhatsApp } from '../whatsapp';
import { WaTemplate } from '../waTemplates';

/*
 * The team's WhatsApp templates: name, text, which one is the usual (★), add and delete. Saved for
 * the whole team in the panel (and on this phone).
 */

export default function TemplatesSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const wa = useWhatsApp();
  const [list, setList] = useState<WaTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!visible) return;
    setList(wa.templates.map((x) => ({ ...x })));
    setNote('');
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy(true);
    try {
      const next = list.filter((x) => x.text.trim());
      if (!next.some((x) => x.isDefault) && next[0]) next[0] = { ...next[0], isDefault: true };
      const where = await wa.setTemplates(next);
      if (where === 'team') onClose();
      else setNote('Saved on this phone. To share with the team, upload the latest crm_lib.php to the panel.');
    } finally {
      setBusy(false);
    }
  };
  const patch = (i: number, p: Partial<WaTemplate>) => setList(list.map((x, j) => (j === i ? { ...x, ...p } : x)));

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="WhatsApp templates"
      subtitle="Shared with the team. Write [Name] or {name} for the first name, [Full Name], [Me] for your name; [Segment] says “internship”. ★ = the usual one."
      footer={(
        <View style={s.footer}>
          <Button label="Add template" icon="add" variant="secondary" onPress={() => setList([...list, { id: `t${Date.now()}`, title: 'New template', text: 'Hi [Name], ' }])} style={{ flex: 1 }} />
          <Button label="Save" icon="check" onPress={save} loading={busy} style={{ flex: 1 }} />
        </View>
      )}
    >
      {!!note && <Text style={s.note}>{note}</Text>}
      {list.map((x, i) => (
        <View key={x.id} style={s.card}>
          <View style={s.head}>
            <View style={{ flex: 1 }}><Field label="Name" value={x.title} onChangeText={(v) => patch(i, { title: v })} maxLength={60} /></View>
            <IconButton
              icon={x.isDefault ? 'star' : 'star_border'}
              label={x.isDefault ? 'The usual template' : 'Make this the usual template'}
              color={x.isDefault ? t.c.amber : undefined}
              onPress={() => setList(list.map((y, j) => ({ ...y, isDefault: j === i })))}
            />
            <IconButton icon="delete_outline" label={`Delete ${x.title}`} color={t.c.danger} disabled={list.length <= 1} onPress={() => setList(list.filter((_, j) => j !== i))} />
          </View>
          <Field label="Message" value={x.text} onChangeText={(v) => patch(i, { text: v })} multiline maxLength={1000} />
        </View>
      ))}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  footer: { flexDirection: 'row', gap: 10, marginTop: space.lg },
  card: { borderWidth: 1, borderColor: t.c.border, borderRadius: radius.lg, padding: 12, paddingTop: 0, marginBottom: space.md },
  head: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  note: { fontSize: 12.5, color: t.c.warning, fontWeight: '600', marginBottom: space.sm },
}));
