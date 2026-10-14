import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from '../theme';
import { prettyPhone } from '../format';
import { Icon, IconName, Sheet } from '../ui';
import { CallLogItem } from '../types';

/** The same four outcomes the post-call popup offers (CallIqConfig.DISPOSITIONS). */
const OUTCOMES: { label: string; icon: IconName; tone: 'success' | 'warning' | 'info' | 'primary'; hint: string }[] = [
  { label: 'Interested', icon: 'thumb_up', tone: 'success', hint: 'Wants to go ahead' },
  { label: 'Callback Scheduled', icon: 'event', tone: 'warning', hint: 'Shows under Callbacks until you get through' },
  { label: 'Resolved', icon: 'check_circle', tone: 'info', hint: 'Nothing more needed' },
  { label: 'Query', icon: 'help_outline', tone: 'primary', hint: 'Had a question' },
];

export default function TagCallSheet({ call, callers, calledBy, onPickCaller, onSelect, onClose }: {
  call: CallLogItem | null;
  callers: string[];
  calledBy: string;
  onPickCaller: (name: string) => void;
  onSelect: (outcome: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <Sheet visible={!!call} onClose={onClose} title="Tag this call" subtitle={call ? prettyPhone(call.number) || 'Private number' : ''}>
      {callers.length > 0 && (
        <>
          <Text style={s.label}>Called by</Text>
          <View style={s.callerRow}>
            {callers.map((name) => {
              const on = calledBy === name;
              return (
                <Pressable
                  key={name}
                  onPress={() => onPickCaller(name)}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={[s.callerChip, on && s.callerChipOn]}
                >
                  {on && <Icon name="check" size={16} color={t.c.onPrimary} />}
                  <Text style={[s.callerText, on && { color: t.c.onPrimary }]} numberOfLines={1}>{name}</Text>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <Text style={s.label}>Outcome</Text>
      {OUTCOMES.map((o) => {
        const [fg, bg] = {
          success: [t.c.success, t.c.successSoft],
          warning: [t.c.warning, t.c.warningSoft],
          info: [t.c.info, t.c.infoSoft],
          primary: [t.c.link, t.c.primarySoft],
        }[o.tone];
        const on = call?.outcome === o.label;
        return (
          <Pressable
            key={o.label}
            onPress={() => onSelect(o.label)}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            android_ripple={{ color: t.c.ripple }}
            style={({ pressed }) => [s.option, on && { borderColor: fg, backgroundColor: bg }, pressed && { opacity: 0.85 }]}
          >
            <View style={[s.optionIcon, { backgroundColor: bg }]}><Icon name={o.icon} size={20} color={fg} /></View>
            <View style={{ flex: 1 }}>
              <Text style={s.optionText}>{o.label}</Text>
              <Text style={s.optionHint}>{o.hint}</Text>
            </View>
            {on && <Icon name="check_circle" size={22} color={fg} />}
          </Pressable>
        );
      })}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  label: { ...type.overline, color: t.c.muted, marginBottom: space.sm + 2, marginTop: space.xs },
  callerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: space.lg },
  callerChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingHorizontal: 16, borderRadius: radius.pill,
    borderWidth: 1, borderColor: t.c.border, backgroundColor: t.c.surface,
  },
  callerChipOn: { backgroundColor: t.c.primary, borderColor: t.c.primary },
  callerText: { fontSize: 13.5, fontWeight: '600', color: t.c.textSoft },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: t.c.border, backgroundColor: t.c.surface,
    borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 12, marginBottom: space.sm, overflow: 'hidden',
  },
  optionIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  optionText: { fontSize: 15, fontWeight: '600', color: t.c.text },
  optionHint: { fontSize: 12, color: t.c.muted, marginTop: 1 },
}));
