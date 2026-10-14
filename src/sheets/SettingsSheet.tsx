import React, { useState } from 'react';
import { Platform, Switch, Text, TextInput, View } from 'react-native';
import { makeStyles, radius, space, type, ThemePref, useTheme } from '../theme';
import { ago } from '../format';
import { Button, Chip, Field, Icon, Segmented, Sheet, SettingRow } from '../ui';
import { SimDiagnostics, SimNicknameMap, UssdSettings } from '../types';

/*
 * Settings. Appearance is for everyone; the rest (server, popup, SIM detection, balance checks,
 * diagnostics) sits behind the admin PIN.
 */

const THEMES = [
  { key: 'system', label: 'System', icon: 'contrast' },
  { key: 'light', label: 'Light', icon: 'light_mode' },
  { key: 'dark', label: 'Dark', icon: 'dark_mode' },
] as const;

interface Props {
  visible: boolean;
  onClose: () => void;
  themePref: ThemePref;
  onThemePref: (p: ThemePref) => void;
  appVersion: string;

  unlocked: boolean;
  onUnlock: (pin: string) => boolean;

  endpoint: string;
  onSaveEndpoint: (url: string) => Promise<void>;
  syncing: boolean;
  pendingQueueCount: number;
  onFlush: () => void;

  popupEnabled: boolean;
  popupForMissed: boolean;
  popupTimeout: number;
  overlayGranted: boolean;
  onPopupSettings: (enabled: boolean, forMissed: boolean, timeoutSec: number) => void;
  onEnableOverlay: () => void;
  onPreviewPopup: () => void;

  simDiag: SimDiagnostics;
  simNicknames: SimNicknameMap;
  ussd: UssdSettings | null;
  checkingSlot: number | null;
  onToggleUssd: (on: boolean) => void;
  onUssdCode: (slot: number, code: string) => void;
  onCheckBalance: (slot: number) => void;

  logs: string[];
}

export default function SettingsSheet(p: Props) {
  const t = useTheme();
  const s = useStyles();
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [url, setUrl] = useState(p.endpoint);
  const [urlError, setUrlError] = useState('');
  const [savingUrl, setSavingUrl] = useState(false);

  // The saved endpoint can arrive after the sheet was first drawn.
  React.useEffect(() => { if (p.visible) { setUrl(p.endpoint); setUrlError(''); } }, [p.visible, p.endpoint]);

  const unlock = () => {
    if (p.onUnlock(pin)) { setPin(''); setPinError(''); }
    else setPinError('That PIN is not right.');
  };

  const saveUrl = async () => {
    const v = url.trim();
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v)) { setUrlError('Enter a full web address starting with https://'); return; }
    setUrlError('');
    setSavingUrl(true);
    try { await p.onSaveEndpoint(v); } finally { setSavingUrl(false); }
  };

  const switchColors = (on: boolean) => ({
    trackColor: { false: t.c.borderStrong, true: t.c.primaryLine },
    thumbColor: on ? t.c.primary : t.c.surface,
  });

  return (
    <Sheet visible={p.visible} onClose={p.onClose} title="Settings" subtitle={`Caller IQ ${p.appVersion ? `v${p.appVersion}` : ''}`}>
      <Text style={s.section}>Appearance</Text>
      <Segmented options={THEMES} value={p.themePref} onChange={p.onThemePref} />

      {!p.unlocked ? (
        <View style={s.lockCard}>
          <View style={s.lockIcon}><Icon name="lock" size={22} color={t.c.link} /></View>
          <Text style={s.lockTitle}>Admin settings</Text>
          <Text style={s.lockSub}>Server, popup, SIM and diagnostics settings need the admin PIN.</Text>
          <TextInput
            style={[s.pinInput, !!pinError && { borderColor: t.c.danger }]}
            value={pin}
            onChangeText={(v) => { setPin(v.replace(/\D/g, '')); setPinError(''); }}
            placeholder="••••"
            placeholderTextColor={t.c.faint}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={4}
            onSubmitEditing={unlock}
            accessibilityLabel="Admin PIN"
          />
          {!!pinError && <Text style={s.pinError}>{pinError}</Text>}
          <Button label="Unlock" icon="lock_open" onPress={unlock} disabled={pin.length < 4} style={{ alignSelf: 'stretch', marginTop: space.md }} />
        </View>
      ) : (
        <>
          {/* ── Server ── */}
          <Text style={s.section}>Server</Text>
          <Field
            label="Call log endpoint"
            value={url}
            onChangeText={(v) => { setUrl(v); setUrlError(''); }}
            placeholder="https://…/api/caller-iq/log_call.php"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            error={urlError}
            hint="Lists and callbacks are read from the same folder on this server."
          />
          <View style={s.btnRow}>
            <Button label="Save endpoint" icon="check" size="sm" onPress={saveUrl} loading={savingUrl} disabled={url.trim() === p.endpoint} />
            <Button
              label={p.syncing ? 'Uploading…' : `Upload queue now${p.pendingQueueCount ? ` (${p.pendingQueueCount})` : ''}`}
              icon="cloud_upload"
              variant="secondary"
              size="sm"
              loading={p.syncing}
              onPress={p.onFlush}
            />
          </View>

          {/* ── Post-call popup ── */}
          <Text style={s.section}>Post-call popup</Text>
          <SettingRow
            icon="notifications"
            title="Ask for the outcome after every call"
            desc={p.overlayGranted ? 'Shows over whatever is on screen when the call ends.' : 'Needs “Display over other apps” — a notification is used until then.'}
            right={<Switch value={p.popupEnabled} onValueChange={(v) => p.onPopupSettings(v, p.popupForMissed, p.popupTimeout)} {...switchColors(p.popupEnabled)} accessibilityLabel="Ask for the outcome after every call" />}
          />
          <SettingRow
            icon="phone_missed"
            title="Also after missed & rejected calls"
            desc="Useful for scheduling a callback straight away."
            right={<Switch value={p.popupForMissed} onValueChange={(v) => p.onPopupSettings(p.popupEnabled, v, p.popupTimeout)} {...switchColors(p.popupForMissed)} accessibilityLabel="Also after missed and rejected calls" />}
          />
          <Text style={s.label}>Closes itself after</Text>
          <View style={s.chipWrap}>
            {[20, 30, 45, 60, 120].map((sec) => (
              <Chip key={sec} label={`${sec}s`} selected={p.popupTimeout === sec} onPress={() => p.onPopupSettings(p.popupEnabled, p.popupForMissed, sec)} />
            ))}
          </View>
          <View style={s.btnRow}>
            {!p.overlayGranted && <Button label="Allow display over apps" icon="open_in_new" size="sm" onPress={p.onEnableOverlay} />}
            <Button label="Preview popup" icon="play_arrow" variant="secondary" size="sm" onPress={p.onPreviewPopup} />
          </View>

          {/* ── SIM detection ── */}
          <Text style={s.section}>SIM detection</Text>
          {(p.simDiag.sims || []).length === 0 ? (
            <Text style={s.desc}>No SIMs reported. Grant the Phone permission so calls can be matched to a SIM.</Text>
          ) : (
            (p.simDiag.sims || []).map((sim) => (
              <View key={sim.slot} style={s.simRow}>
                <Text style={s.simSlot}>SIM {sim.slot}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{sim.carrier || sim.displayName || `Slot ${sim.slot}`}</Text>
                  <Text style={s.desc}>
                    sub id {sim.subscriptionId}
                    {sim.number ? ` · ${sim.number}` : ''}
                    {p.simNicknames[`SIM ${sim.slot}`] ? ` · ${p.simNicknames[`SIM ${sim.slot}`]}` : ''}
                  </Text>
                </View>
              </View>
            ))
          )}
          {!!p.simDiag.liveSlot && <Text style={s.desc}>Last call was placed on SIM {p.simDiag.liveSlot}.</Text>}
          <Text style={s.desc}>
            {Object.keys(p.simDiag.learned || {}).length} phone account{Object.keys(p.simDiag.learned || {}).length === 1 ? '' : 's'} learned from this
            phone’s call log. The Calls tab shows how each call was matched.
          </Text>

          {/* ── SIM balance (USSD) ── */}
          <Text style={s.section}>SIM balance & validity</Text>
          {!p.ussd?.supported ? (
            <Text style={s.desc}>This phone is too old for automatic balance checks (needs Android 8).</Text>
          ) : (
            <>
              <SettingRow
                icon="sim_card"
                title="Check each SIM once a day"
                desc="Runs the operator’s own code (like *121#) in the background and sends the reply to the dashboard."
                right={<Switch value={p.ussd.enabled} onValueChange={p.onToggleUssd} {...switchColors(p.ussd.enabled)} accessibilityLabel="Check each SIM once a day" />}
              />
              {!p.ussd.callPermission && (
                <Text style={s.desc}>The Phone-calls permission is needed — the check runs on the line. Tap “Check now” and allow it.</Text>
              )}
              {(p.ussd.sims || []).map((sim) => (
                <View key={sim.slot} style={[s.simRow, { alignItems: 'flex-start' }]}>
                  <Text style={s.simSlot}>SIM {sim.slot}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowTitle}>{sim.carrier || `Slot ${sim.slot}`}</Text>
                    <TextInput
                      style={s.codeInput}
                      value={sim.code}
                      onChangeText={(v) => p.onUssdCode(sim.slot, v)}
                      placeholder="*121#"
                      placeholderTextColor={t.c.faint}
                      autoCapitalize="none"
                      accessibilityLabel={`Balance code for SIM ${sim.slot}`}
                    />
                    {!!sim.lastReply && <Text style={s.desc}>Last reply{sim.lastCheckedAt ? ` (${ago(sim.lastCheckedAt)})` : ''}: {sim.lastReply}</Text>}
                  </View>
                  <Button label="Check now" size="sm" loading={p.checkingSlot === sim.slot} onPress={() => p.onCheckBalance(sim.slot)} />
                </View>
              ))}
              <Text style={s.desc}>
                Codes that answer with a menu (“reply 1 for balance”) cannot be read automatically — only one-shot codes. Jio answers little
                over USSD; record those by hand in the dashboard.
              </Text>
            </>
          )}

          {/* ── Diagnostics ── */}
          <Text style={s.section}>Activity log</Text>
          <View style={s.logBox}>
            {p.logs.length === 0 ? (
              <Text style={s.logText}>No events yet.</Text>
            ) : (
              p.logs.map((log, i) => <Text key={i} style={s.logText} selectable>{log}</Text>)
            )}
          </View>
        </>
      )}
    </Sheet>
  );
}

const useStyles = makeStyles((t) => ({
  section: { ...type.overline, color: t.c.muted, marginTop: space.xl, marginBottom: space.sm + 2 },
  label: { ...type.label, color: t.c.textSoft, marginTop: space.sm, marginBottom: space.sm },
  desc: { fontSize: 12.5, color: t.c.muted, marginTop: 4, lineHeight: 18 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: t.c.text },
  btnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: space.md },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  lockCard: {
    alignItems: 'center', marginTop: space.xl, padding: space.xl, borderRadius: radius.lg,
    backgroundColor: t.c.surfaceAlt, borderWidth: 1, borderColor: t.c.border,
  },
  lockIcon: { width: 48, height: 48, borderRadius: 24, backgroundColor: t.c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  lockTitle: { ...type.heading, color: t.c.text, marginTop: space.md },
  lockSub: { fontSize: 12.5, color: t.c.muted, textAlign: 'center', marginTop: 4, lineHeight: 18 },
  pinInput: {
    alignSelf: 'stretch', marginTop: space.lg, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md, backgroundColor: t.c.surface,
    paddingVertical: 12, fontSize: 22, textAlign: 'center', letterSpacing: 10, color: t.c.text,
  },
  pinError: { fontSize: 12.5, color: t.c.danger, marginTop: 6 },

  simRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border,
    borderRadius: radius.md, padding: 12, marginBottom: space.sm,
  },
  simSlot: {
    fontSize: 11, fontWeight: '700', color: t.c.link, backgroundColor: t.c.primarySoft, overflow: 'hidden',
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
  },
  codeInput: {
    marginTop: 6, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8,
    fontSize: 14, color: t.c.text, backgroundColor: t.c.surfaceAlt,
  },

  logBox: { backgroundColor: t.dark ? '#05070D' : '#0E1525', borderRadius: radius.md, padding: 12 },
  logText: { color: '#B9C4FF', fontSize: 10.5, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 4 },
}));
