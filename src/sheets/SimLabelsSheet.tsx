import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { space } from '../theme';
import { Button, Field, Sheet } from '../ui';

/** Friendly names for each SIM slot; sent with every call so the panel shows them too. */
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

  // Start from the labels in use each time the sheet opens.
  useEffect(() => {
    if (visible) { setA(sim1); setB(sim2); }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try { await onSave(a.trim(), b.trim()); } finally { setSaving(false); }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="SIM labels"
      subtitle="Sent with every call so the dashboard shows which line was used."
      footer={
        <View style={{ flexDirection: 'row', gap: 10, marginTop: space.lg }}>
          <Button label="Cancel" variant="secondary" onPress={onClose} style={{ flex: 1 }} />
          <Button label="Save labels" icon="check" onPress={save} loading={saving} disabled={!a.trim() && !b.trim()} style={{ flex: 1 }} />
        </View>
      }
    >
      <Field label="SIM 1 (slot 1)" value={a} onChangeText={setA} placeholder="e.g. SIM 1: Inbound leads" maxLength={60} />
      <Field label="SIM 2 (slot 2)" value={b} onChangeText={setB} placeholder="e.g. SIM 2: Admissions" maxLength={60} hint="Leave one empty to keep its current label." />
    </Sheet>
  );
}
