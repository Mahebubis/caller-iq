import React from 'react';
import { ActivityIndicator, Switch, Text, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from '../theme';
import { ago } from '../format';
import { Button, Icon, IconName, Sheet, SettingRow } from '../ui';
import { SetupInfo, SetupStep } from '../types';

/*
 * Phone setup — everything this phone needs, and one tap to allow it all. The wizard itself
 * (which step is next, what came back from Settings) lives in App.tsx; this only draws it.
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  setup: SetupInfo | null;
  wizardOn: boolean;
  wizardKey: string | null;
  stepNo: number;
  stepTotal: number;
  askConfirm: SetupStep | null;
  lastNote: string;
  connTest: { busy: boolean; ok?: boolean; message?: string };
  onStartWizard: () => void;
  onRunStep: (step: SetupStep) => void;
  onRunSingle: (step: SetupStep) => void;
  onSkip: (key: string) => void;
  onStop: () => void;
  onAnswerConfirm: (yes: boolean) => void;
  onConfirmDirect: (step: SetupStep) => void;
  onToggleMonitor: (on: boolean) => void;
  onTestConnection: () => void;
  onTestPopup: () => void;
}

export default function SetupSheet(p: Props) {
  const t = useTheme();
  const s = useStyles();
  const st = p.setup;
  const left = st ? st.steps.filter((x) => !x.ok).length : 0;
  const cur = p.wizardOn && !p.askConfirm ? st?.steps.find((x) => x.key === p.wizardKey) : undefined;

  return (
    <Sheet
      visible={p.visible}
      onClose={p.onClose}
      title="Phone setup"
      subtitle={st ? `${st.model} · Android ${st.android} — only what this phone needs` : 'Checking this phone…'}
      footer={<Button label="Done" variant="secondary" onPress={p.onClose} style={{ marginTop: space.md }} />}
    >
      {st && typeof st.monitorEnabled === 'boolean' && (
        <SettingRow
          icon="bolt"
          title="Keep CallIQ running"
          desc="Stops Android pausing the app between calls, so every call reaches the dashboard. Shows a quiet “CallIQ is tracking calls” notification."
          right={
            <Switch
              value={!!st.monitorEnabled}
              onValueChange={p.onToggleMonitor}
              trackColor={{ false: t.c.borderStrong, true: t.c.primaryLine }}
              thumbColor={st.monitorEnabled ? t.c.primary : t.c.surface}
              accessibilityLabel="Keep CallIQ running"
            />
          }
        />
      )}

      {/* The one button */}
      {st && left > 0 && !p.wizardOn && !p.askConfirm && (
        <Button
          label="Allow all permissions"
          icon="task_alt"
          size="lg"
          onPress={p.onStartWizard}
          style={{ marginTop: space.xs }}
        />
      )}
      {st && left > 0 && !p.wizardOn && !p.askConfirm && (
        <Text style={s.allowSub}>{left} step{left === 1 ? '' : 's'} · the app moves to the next one by itself</Text>
      )}
      {st && left === 0 && (
        <View style={s.allSet}>
          <Icon name="check_circle" size={24} color={t.c.success} />
          <View style={{ flex: 1 }}>
            <Text style={s.allSetTitle}>Everything is on</Text>
            <Text style={s.allSetSub}>Calls upload by themselves, and the popup appears after every call.</Text>
          </View>
        </View>
      )}

      {/* The step in progress */}
      {cur && (
        <View style={s.wizard}>
          <Text style={s.stepNo}>Step {p.stepNo} of {p.stepTotal}</Text>
          <Text style={s.wizardTitle}>{cur.title}</Text>
          <Text style={s.wizardHow}>{cur.how}</Text>
          <Text style={s.desc}>
            {cur.kind === 'dialog'
              ? 'Answer on the screen that just opened.'
              : cur.kind === 'screen'
                ? 'Flip the switch — CallIQ comes back by itself. If it does not, press Back.'
                : 'This phone does not tell apps when this is on. Flip it, then press Back.'}
          </Text>
          <View style={s.btnRow}>
            <Button label="Open again" icon="open_in_new" size="sm" onPress={() => p.onRunStep(cur)} />
            <Button label="Skip" variant="secondary" size="sm" onPress={() => p.onSkip(cur.key)} />
            <Button label="Stop" variant="secondary" size="sm" onPress={p.onStop} />
          </View>
        </View>
      )}

      {/* A switch the phone cannot read back */}
      {p.askConfirm && (
        <View style={[s.wizard, s.wizardAsk]}>
          <Text style={s.wizardTitle}>Is “{p.askConfirm.title}” on now?</Text>
          <Text style={s.wizardHow}>{p.askConfirm.how}</Text>
          <Text style={s.desc}>
            {st?.manufacturer || 'This'} phones do not let apps read this switch, so the app takes your word for it — the panel shows it as confirmed.
          </Text>
          <View style={s.btnRow}>
            <Button label="Yes, it’s on" icon="check" size="sm" onPress={() => p.onAnswerConfirm(true)} />
            <Button label="Open again" variant="secondary" size="sm" onPress={() => p.askConfirm && p.onRunStep(p.askConfirm)} />
            <Button label="Not yet" variant="secondary" size="sm" onPress={() => p.onAnswerConfirm(false)} />
          </View>
        </View>
      )}

      {/* The checklist */}
      <Text style={s.section}>Checklist</Text>
      {!st && <ActivityIndicator style={{ marginVertical: space.xxl }} color={t.c.primary} />}
      {(st?.steps || []).map((step) => {
        const tone: { fg: string; bg: string; icon: IconName } = step.ok ? { fg: t.c.success, bg: t.c.successSoft, icon: 'check' }
          : step.status === 'todo' ? { fg: t.c.danger, bg: t.c.dangerSoft, icon: 'error_outline' }
          : { fg: t.c.warning, bg: t.c.warningSoft, icon: 'help_outline' };
        return (
          <View key={step.key} style={[s.step, p.wizardOn && p.wizardKey === step.key && s.stepActive]}>
            <View style={[s.stepBadge, { backgroundColor: tone.bg }]}>
              <Icon name={tone.icon} size={16} color={tone.fg} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.stepTitle}>
                {step.title}
                {!step.required && <Text style={s.tagText}>  · recommended</Text>}
                {step.status === 'confirmed' && <Text style={s.tagText}>  · you confirmed</Text>}
                {step.status === 'unknown' && <Text style={s.tagText}>  · not confirmed</Text>}
              </Text>
              <Text style={s.desc}>{step.ok ? step.why : `${step.why} ${step.how}`}</Text>
            </View>
            {!step.ok && !p.wizardOn && !p.askConfirm && (
              <View style={{ gap: 6 }}>
                <Button label={step.kind === 'dialog' ? 'Allow' : 'Open'} size="sm" onPress={() => p.onRunSingle(step)} accessibilityLabel={`${step.kind === 'dialog' ? 'Allow' : 'Open'} ${step.title}`} />
                {step.status === 'unknown' && (
                  <Button label="It’s on" variant="secondary" size="sm" onPress={() => p.onConfirmDirect(step)} />
                )}
              </View>
            )}
          </View>
        );
      })}

      {/* Proof, not promises */}
      {st && (
        <View style={s.health}>
          <Text style={s.section}>Is it working?</Text>
          {typeof st.monitorEnabled === 'boolean' && (
            <HealthRow
              label="Kept running between calls"
              value={st.monitorRunning ? 'Yes' : st.monitorEnabled ? 'Not yet — close and reopen CallIQ' : 'Switched off'}
              bad={!st.monitorRunning}
            />
          )}
          <HealthRow label="Calls last uploaded" value={st.syncError ? `Failing — ${st.syncError}` : ago(st.syncOkAt, 'never')} bad={!!st.syncError} />
          <HealthRow
            label="Ran by itself in the background"
            value={st.bgRunAt ? ago(st.bgRunAt) : 'not yet — check again in 15 min'}
            bad={!!st.bgRunAt && Date.now() - st.bgRunAt > 6 * 3600 * 1000}
          />
          <HealthRow label="Setup reported to the panel" value={st.checkinError ? `Failing — ${st.checkinError}` : ago(st.checkinAt, 'never')} bad={!!st.checkinError} />
          <View style={[s.btnRow, { marginTop: space.md }]}>
            <Button label="Test connection" icon="dns" variant="secondary" size="sm" loading={p.connTest.busy} onPress={p.onTestConnection} />
            <Button label="Test the popup" icon="play_arrow" variant="secondary" size="sm" onPress={p.onTestPopup} />
          </View>
          {!!p.connTest.message && (
            <View style={s.testResult}>
              <Icon name={p.connTest.ok ? 'check_circle' : 'error_outline'} size={16} color={p.connTest.ok ? t.c.success : t.c.danger} />
              <Text style={[s.desc, { flex: 1, marginTop: 0, color: p.connTest.ok ? t.c.success : t.c.danger }]}>{p.connTest.message}</Text>
            </View>
          )}
          <Text style={[s.desc, { marginTop: space.sm }]}>The popup test runs exactly what a real hang-up runs. If the card appears here, it appears after calls.</Text>
        </View>
      )}

      {!!p.lastNote && (
        <View style={s.noteBox}>
          <Text style={s.section}>Last call</Text>
          <Text style={s.desc}>{p.lastNote}</Text>
        </View>
      )}
    </Sheet>
  );
}

/** One line of "Is it working?" — label left, the phone's own evidence right. */
const HealthRow = ({ label, value, bad }: { label: string; value: string; bad?: boolean }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={s.healthRow}>
      <Icon name={bad ? 'error_outline' : 'check_circle'} size={16} color={bad ? t.c.danger : t.c.success} />
      <Text style={s.healthLabel}>{label}</Text>
      <Text style={[s.healthValue, bad && { color: t.c.danger }]} numberOfLines={3}>{value}</Text>
    </View>
  );
};

const useStyles = makeStyles((t) => ({
  allowSub: { fontSize: 12, color: t.c.muted, textAlign: 'center', marginTop: 8, marginBottom: space.md },
  allSet: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.c.successSoft, borderRadius: radius.md, padding: 14, marginBottom: space.md },
  allSetTitle: { fontSize: 15, fontWeight: '700', color: t.c.success },
  allSetSub: { fontSize: 12.5, color: t.c.textSoft, marginTop: 2 },

  wizard: { backgroundColor: t.c.primarySoft, borderRadius: radius.md, padding: 14, marginBottom: space.md, borderWidth: 1, borderColor: t.c.primaryLine },
  wizardAsk: { backgroundColor: t.c.warningSoft, borderColor: t.c.warning },
  stepNo: { ...type.overline, color: t.c.link },
  wizardTitle: { ...type.heading, color: t.c.text, marginTop: 4 },
  wizardHow: { fontSize: 13.5, color: t.c.textSoft, marginTop: 6, lineHeight: 19 },
  btnRow: { flexDirection: 'row', gap: 8, marginTop: space.md, flexWrap: 'wrap' },

  section: { ...type.overline, color: t.c.muted, marginTop: space.md, marginBottom: space.sm + 2 },
  step: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border,
    borderRadius: radius.md, padding: 12, marginBottom: space.sm,
  },
  stepActive: { backgroundColor: t.c.primarySoft, borderColor: t.c.primaryLine },
  stepBadge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  stepTitle: { fontSize: 14, fontWeight: '600', color: t.c.text },
  tagText: { fontSize: 12, fontWeight: '400', color: t.c.muted },
  desc: { fontSize: 12.5, color: t.c.muted, marginTop: 3, lineHeight: 18 },

  health: { backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, paddingHorizontal: 14, paddingBottom: 14, marginTop: space.sm, borderWidth: 1, borderColor: t.c.border },
  healthRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 6 },
  healthLabel: { fontSize: 12.5, color: t.c.muted, flexShrink: 1, maxWidth: '50%' },
  healthValue: { fontSize: 12.5, color: t.c.text, fontWeight: '600', flex: 1, textAlign: 'right' },
  testResult: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: space.sm },
  noteBox: { backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, paddingHorizontal: 14, paddingBottom: 12, marginTop: space.md },
}));
