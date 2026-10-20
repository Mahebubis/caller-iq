import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Image, Text, View } from 'react-native';
import { makeStyles, radius, space, useTheme } from '../theme';
import { prettyPhone } from '../format';
import { Banner, Button, Field, Icon, Sheet } from '../ui';
import { useWhatsApp } from '../whatsapp';

/*
 * The top bar's WhatsApp badge opens this: where the bridge is (address + key), whether it is
 * linked to a WhatsApp account, and — while it is not — the live QR to scan from the phone that
 * owns the account (WhatsApp → Linked devices → Link a device).
 */

export default function WhatsAppSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles();
  const wa = useWhatsApp();
  const [url, setUrl] = useState<string>('');
  const [key, setKey] = useState<string>('');
  const [editing, setEditing] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);

  useEffect(() => {
    if (!visible) return;
    setUrl(wa.config.url);
    setKey(wa.config.key);
    setEditing(!wa.configured);
    if (wa.configured) wa.refresh();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    try {
      await wa.saveConfig({ url, key });
      setEditing(!url.trim());
    } finally {
      setSaving(false);
    }
  };

  const st = wa.status;
  const c = st?.campaign;
  const confirmLogout = () => Alert.alert(
    'Unlink WhatsApp?',
    'The bridge stops sending from this WhatsApp account. Scan a new QR to link it, or another account, again.',
    [{ text: 'Cancel', style: 'cancel' }, { text: 'Unlink', style: 'destructive', onPress: wa.logout }],
  );

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="WhatsApp bot"
      subtitle={st?.connected ? `Connected${st.me ? ` as ${prettyPhone(st.me.slice(-10))}` : ''}` : wa.configured ? 'Scan the QR to link a WhatsApp account' : 'Send WhatsApp messages in the background'}
    >
      {editing ? (
        <View>
          <Text style={s.body}>
            Run the WhatsApp bridge (the whatsapp-bridge folder) on a computer this phone can reach, then enter its address and key.
            Without it, the WhatsApp buttons open WhatsApp on this phone with the message ready.
          </Text>
          <Field
            label="Bridge address"
            value={url}
            onChangeText={setUrl}
            placeholder="192.168.1.20:3001"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Field
            label="Bridge key"
            value={key}
            onChangeText={setKey}
            placeholder="The BRIDGE_KEY it was started with"
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
          />
          <View style={s.row}>
            {wa.configured && <Button label="Cancel" variant="secondary" onPress={() => setEditing(false)} style={{ flex: 1 }} />}
            <Button label="Save & connect" icon="check" onPress={save} loading={saving} disabled={!url.trim()} style={{ flex: 2 }} />
          </View>
        </View>
      ) : (
        <View>
          {!!wa.bridgeError && (
            <Banner tone="danger" icon="link_off" title="Bridge not reachable" message={wa.bridgeError} actionLabel="Retry" onAction={wa.refresh} />
          )}

          {st?.connected ? (
            <View style={[s.state, { borderColor: t.c.success, backgroundColor: t.c.successSoft }]}>
              <Icon name="check_circle" size={28} color={t.c.success} />
              <View style={{ flex: 1 }}>
                <Text style={[s.stateTitle, { color: t.c.success }]}>Connected</Text>
                <Text style={s.stateText}>
                  {st.me ? `Messages go out from ${prettyPhone(st.me.slice(-10))}. ` : ''}The WhatsApp buttons on unanswered calls send in the background.
                </Text>
              </View>
            </View>
          ) : st?.qrDataUrl ? (
            <View style={s.qrBox}>
              <Image source={{ uri: st.qrDataUrl }} style={s.qr} resizeMode="contain" accessibilityLabel="WhatsApp QR code" />
              <Text style={s.qrHint}>On the phone with the WhatsApp account: WhatsApp → ⋮ → Linked devices → Link a device, then point it here.</Text>
            </View>
          ) : !wa.bridgeError ? (
            <View style={s.qrBox}>
              <ActivityIndicator color={t.c.primary} />
              <Text style={s.qrHint}>
                {st?.phase === 'authenticated' ? 'Linked — loading chats…' : st?.error || 'Starting WhatsApp Web on the bridge… the QR appears here in a moment.'}
              </Text>
            </View>
          ) : null}

          {!!c?.running && (
            <View style={s.state}>
              <Icon name="campaign" size={24} color={t.c.link} />
              <View style={{ flex: 1 }}>
                <Text style={s.stateTitle}>Campaign {c.paused ? 'paused' : 'running'}</Text>
                <Text style={s.stateText}>Sent {c.sent}/{c.total}{c.failed ? ` · ${c.failed} failed` : ''}</Text>
              </View>
              <Button label="View" size="sm" variant="soft" onPress={() => { onClose(); wa.openCampaign([]); }} />
            </View>
          )}

          <Text style={s.addr} numberOfLines={1}>{wa.config.url}</Text>
          <View style={s.row}>
            <Button label="Change bridge" icon="settings" variant="secondary" onPress={() => setEditing(true)} style={{ flex: 1 }} />
            {st?.connected && <Button label="Unlink" icon="link_off" variant="secondary" onPress={confirmLogout} style={{ flex: 1 }} />}
          </View>
        </View>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  body: { fontSize: 13.5, color: t.c.textSoft, lineHeight: 20, marginBottom: space.md },
  row: { flexDirection: 'row', gap: 10, marginTop: space.md },
  state: {
    flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md,
    backgroundColor: t.c.surfaceAlt, padding: 14, marginBottom: space.md,
  },
  stateTitle: { fontSize: 15, fontWeight: '700', color: t.c.text },
  stateText: { fontSize: 12.5, color: t.c.textSoft, marginTop: 2, lineHeight: 18 },
  qrBox: { alignItems: 'center', gap: 12, paddingVertical: space.md, marginBottom: space.md },
  // The QR stays black on white in dark mode too, or phones can't read it.
  qr: { width: 260, height: 260, backgroundColor: '#FFFFFF', borderRadius: radius.md },
  qrHint: { fontSize: 12.5, color: t.c.muted, textAlign: 'center', lineHeight: 18, paddingHorizontal: space.md },
  addr: { fontSize: 11.5, color: t.c.faint },
}));
