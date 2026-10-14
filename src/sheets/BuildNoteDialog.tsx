import React from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from '../theme';
import { dateTime } from '../format';
import { Button, Icon } from '../ui';
import { BuildInfo } from '../types';

/** "This is the latest build" — whatever was in BUILD_NOTE.txt when this APK was built. */
export default function BuildNoteDialog({ info, visible, onClose }: { info: BuildInfo | null; visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Modal visible={visible && !!info} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={s.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={s.card} onPress={() => {}} accessible={false}>
          <View style={s.badge}>
            <Icon name="verified" size={16} color={t.c.link} />
            <Text style={s.badgeText}>Latest build installed</Text>
          </View>
          <Text style={s.note}>{info?.note}</Text>
          <View style={s.metaRow}>
            <Text style={s.meta}>Version {info?.versionName} ({info?.versionCode})</Text>
            <Text style={s.meta}>Installed {dateTime(info?.installedAt || 0)}</Text>
          </View>
          <Button label="Got it" onPress={onClose} style={{ marginTop: space.xl }} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const useStyles = makeStyles((t) => ({
  scrim: { flex: 1, backgroundColor: t.c.scrim, justifyContent: 'center', padding: space.xxl },
  card: { backgroundColor: t.c.surface, borderRadius: radius.xl, padding: space.xxl, elevation: 10 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: t.c.primarySoft, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 5 },
  badgeText: { ...type.overline, color: t.c.link },
  note: { ...type.title, color: t.c.text, marginTop: space.lg, lineHeight: 27 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.lg, flexWrap: 'wrap', gap: 6 },
  meta: { fontSize: 12, color: t.c.muted, fontWeight: '500' },
}));
