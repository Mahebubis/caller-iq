import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, NativeModules, PermissionsAndroid, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { makeStyles, radius, space, type, useTheme } from './theme';
import { prettyPhone } from './format';
import { Icon, IconName, useToast } from './ui';
import { Avatar, Gradient } from './art';
import { crm } from './crm';
import type { ActiveCall, Disposition } from './MiniCallBar';
import { DISPOSITIONS } from './MiniCallBar';
import type { DialerInfo } from './ImportsScreen';

const { CrmBridge } = NativeModules;

/*
 * The active call screen: a crimson-burgundy botanical backdrop, the contact in a glowing ring and a
 * frosted-glass grid of what Android lets another app do during a call — speaker, mute, the phone's
 * own keypad, a note, a callback, WhatsApp — over a glowing End call.
 *
 * It follows the phone's real call state (ActiveCall.phase, from "CallIQCallState"): "Dialing…"
 * until the line opens, a timer while it is live, and the moment it ends the timer stops and the
 * five quick outcomes come up by themselves. With the power dialer running it also shows where in
 * the list you are, and between calls who is next, with Call now / Pause / Skip / Stop.
 */

const clockOf = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

export default function CallScreen({ call, dialer, visible, onClose, onPick, onSchedule, onWhatsApp, onOpen, onCallAgain, onDialer }: {
  call: ActiveCall | null;
  dialer: DialerInfo | null;
  visible: boolean;
  onClose: () => void;
  onPick: (d: Disposition) => void;
  onSchedule: () => void;
  onWhatsApp: () => void;
  /** The full Focus workspace for this contact. */
  onOpen: () => void;
  onCallAgain: () => void;
  onDialer: (action: 'next' | 'callNow' | 'pause' | 'resume' | 'skip' | 'stop') => void;
}) {
  const t = useTheme();
  const s = useStyles();
  const toast = useToast();
  const [, setTick] = useState(0);
  const [speaker, setSpeaker] = useState(false);
  const [mute, setMute] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [endedByHand, setEndedByHand] = useState(false);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 500);
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => { clearInterval(timer); loop.stop(); };
  }, [visible, pulse]);

  // A new call starts clean; speaker and mute go back to normal when it ends.
  useEffect(() => {
    setEndedByHand(false);
    setNote(null);
  }, [call?.startedAt]);
  const ended = !!call && (call.phase === 'ended' || endedByHand);
  useEffect(() => {
    if (call && !ended) return;
    if (speaker) CrmBridge?.setSpeaker?.(false).catch(() => {});
    if (mute) CrmBridge?.setMute?.(false).catch(() => {});
    setSpeaker(false);
    setMute(false);
  }, [call, ended]); // eslint-disable-line react-hooks/exhaustive-deps

  const ring = (scale: number, opacity: number) => ({
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [opacity, 0] }),
    transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, scale] }) }],
  });

  /* ── between two power-dialer calls: who is next ── */
  if (!call) {
    if (!dialer) return null;
    const who = dialer.current;
    const secs = Math.max(0, Math.ceil((dialer.at - Date.now()) / 1000));
    const paused = dialer.phase === 'paused';
    return (
      <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
        <Gradient colors={t.grad.call} angle={180} leaves="corners" leafColor="rgba(255,255,255,0.06)" style={s.screen}>
          <TopBar title={`Power dialer · ${Math.min(dialer.pos + 1, dialer.total)} of ${dialer.total}`} onClose={onClose} />
          <View style={s.center}>
            <Text style={s.upNext}>{paused ? 'Paused' : 'Up next'}</Text>
            <View style={s.ringBox}>
              {!paused && <Animated.View style={[s.ring, ring(1.3, 0.6)]} />}
              <View style={s.ringCore}><Avatar name={who?.name} phone={who?.number} size={112} /></View>
            </View>
            <Text style={s.name} numberOfLines={1}>{who?.name || (who ? prettyPhone(who.number) : 'Finding the next person…')}</Text>
            {!!who?.name && <Text style={s.phone}>{prettyPhone(who.number)}</Text>}
            {!!who?.segment && <Text style={s.segment} numberOfLines={1}>{who.segment}</Text>}
            {!paused && <View style={s.timer}><Text style={s.timerText}>Calling in {secs}s</Text></View>}
            {!!dialer.next && <Text style={s.segment}>Then: {dialer.next.name || prettyPhone(dialer.next.number)}</Text>}
          </View>
          <View>
            <View style={s.dialerRow}>
              {paused
                ? <GlassButton icon="play_arrow" label="Resume" onPress={() => onDialer('resume')} />
                : <GlassButton icon="pause" label="Pause" onPress={() => onDialer('pause')} />}
              <GlassButton icon="skip_next" label="Skip" onPress={() => onDialer('skip')} />
              <GlassButton icon="stop" label="Stop" onPress={() => onDialer('stop')} />
            </View>
            {!paused && (
              <View style={s.endRow}>
                <Pressable onPress={() => onDialer('callNow')} accessibilityRole="button" accessibilityLabel="Call now" style={({ pressed }) => [s.callWrap, pressed && { transform: [{ scale: 0.94 }] }]}>
                  <Gradient colors={['#34D399', '#10B981', '#059669']} angle={135} corner={40} style={s.end}>
                    <Icon name="call" size={32} color="#FFFFFF" />
                  </Gradient>
                </Pressable>
                <Text style={s.endText}>Call now</Text>
              </View>
            )}
          </View>
        </Gradient>
      </Modal>
    );
  }

  /* ── on a call, or just after one ── */
  const now = Date.now();
  const liveFrom = call.liveAt || 0;
  const clock = call.phase === 'dialing' || !liveFrom ? null : clockOf((call.endedAt || now) - liveFrom);
  const status = ended ? 'Call ended' : call.phase === 'live' ? 'On call' : 'Dialing…';

  const toggleSpeaker = () => {
    const on = !speaker;
    CrmBridge?.setSpeaker?.(on).then(() => setSpeaker(on)).catch((e: any) => toast(e?.message || 'Speaker not available', 'error'));
  };
  const toggleMute = () => {
    const on = !mute;
    CrmBridge?.setMute?.(on).then(() => setMute(on)).catch((e: any) => toast(e?.message || 'Mute not available', 'error'));
  };
  const keypad = () => CrmBridge?.showInCallScreen?.(true).catch(() => toast('Open the phone’s call screen for the keypad', 'error'));
  const endCall = async () => {
    let done = await CrmBridge?.endCall?.().catch(() => false);
    if (!done && Platform.OS === 'android' && Number(Platform.Version) >= 28) {
      const ok = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ANSWER_PHONE_CALLS, {
        title: 'Hang up from Caller IQ',
        message: 'Allow Caller IQ to end the call when you tap End call.',
        buttonPositive: 'Allow',
      }).catch(() => 'denied');
      if (ok === PermissionsAndroid.RESULTS.GRANTED) done = await CrmBridge?.endCall?.().catch(() => false);
    }
    // The phone reports the hang-up a moment later; show the outcomes straight away.
    if (done) setEndedByHand(true);
    else {
      toast('This phone only lets its own call screen hang up — opening it');
      CrmBridge?.showInCallScreen?.(false).catch(() => {});
    }
  };
  const saveNote = async () => {
    const text = (note || '').trim();
    if (!text) { setNote(null); return; }
    try {
      await crm.noteAdd(call.number, text);
      toast('Note saved');
      setNote(null);
    } catch (e: any) {
      toast(`Not saved — ${e?.message || e}`, 'error');
    }
  };

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Gradient colors={t.grad.call} angle={180} leaves="corners" leafColor="rgba(255,255,255,0.06)" style={s.screen}>
        <TopBar
          title={call.dialer && dialer ? `Power dialer · ${Math.min(dialer.pos + 1, dialer.total)} of ${dialer.total}` : status}
          onClose={onClose}
          onMore={onOpen}
        />

        <View style={s.center}>
          <View style={s.ringBox}>
            {!ended && <Animated.View style={[s.ring, s.ringOuter, ring(1.5, 0.45)]} />}
            {!ended && <Animated.View style={[s.ring, ring(1.25, 0.7)]} />}
            <View style={[s.ringCore, ended && s.ringEnded]}><Avatar name={call.name} phone={call.number} size={112} /></View>
          </View>
          <Text style={s.name} numberOfLines={1}>{call.name || prettyPhone(call.number)}</Text>
          <Text style={s.phone}>{call.name ? prettyPhone(call.number) : 'Calling from Caller IQ'}</Text>
          {!!call.segment && <Text style={s.segment} numberOfLines={1}>{call.segment}</Text>}
          <View style={s.timer}>
            <View style={[s.dot, ended ? { backgroundColor: '#FDA4AF' } : call.phase !== 'live' && { backgroundColor: '#FBBF24' }]} />
            <Text style={s.timerText}>{ended ? `Ended${clock ? ` · ${clock}` : ''}` : clock || 'Dialing…'}</Text>
          </View>
        </View>

        {note != null ? (
          <View style={s.noteBox}>
            <TextInput value={note} onChangeText={setNote} placeholder="Note about this call" placeholderTextColor="rgba(255,255,255,0.55)" multiline autoFocus style={s.noteInput} />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <GlassButton icon="close" label="Cancel" onPress={() => setNote(null)} small />
              <GlassButton icon="check" label="Save note" onPress={saveNote} small />
            </View>
          </View>
        ) : ended ? (
          <View style={s.outcomes}>
            <Text style={s.outTitle}>How did it go?</Text>
            <View style={s.outGrid}>
              {DISPOSITIONS.map((d, i) => (
                <Pressable key={d.key} onPress={() => onPick(d.key)} style={({ pressed }) => [s.outBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel={`${i + 1}: ${d.label}`}>
                  <Text style={{ fontSize: 22 }}>{d.emoji}</Text>
                  <Text style={s.outText}>{d.label}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => setNote('')} style={({ pressed }) => [s.outBtn, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel="Add a note">
                <Icon name="edit_note" size={22} color="#FFFFFF" />
                <Text style={s.outText}>Add note</Text>
              </Pressable>
            </View>
            <View style={s.afterRow}>
              <Pressable onPress={onCallAgain} hitSlop={8} accessibilityRole="button"><Text style={s.link}>Call again</Text></Pressable>
              {call.dialer && dialer
                ? <Pressable onPress={() => onDialer('next')} hitSlop={8} accessibilityRole="button"><Text style={s.link}>Skip outcome · next call</Text></Pressable>
                : <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button"><Text style={s.link}>Later</Text></Pressable>}
            </View>
          </View>
        ) : (
          <View>
            <View style={s.grid}>
              <GlassButton icon="volume_up" label="Speaker" on={speaker} onPress={toggleSpeaker} />
              <GlassButton icon={mute ? 'mic_off' : 'mic'} label={mute ? 'Muted' : 'Mute'} on={mute} onPress={toggleMute} />
              <GlassButton icon="dialpad" label="Keypad" onPress={keypad} />
              <GlassButton icon="edit_note" label="Add Note" onPress={() => setNote('')} />
              <GlassButton icon="alarm" label="Callback" onPress={onSchedule} />
              <GlassButton icon="chat" label="WhatsApp" onPress={onWhatsApp} />
            </View>
            <View style={s.endRow}>
              <Pressable onPress={endCall} accessibilityRole="button" accessibilityLabel="End call" style={({ pressed }) => [s.endWrap, pressed && { transform: [{ scale: 0.94 }] }]}>
                <Gradient colors={['#FF7556', '#F44350', '#E62E5C']} angle={135} corner={40} style={s.end}>
                  <Icon name="phone_disabled" size={32} color="#FFFFFF" />
                </Gradient>
              </Pressable>
              <Text style={s.endText}>End Call</Text>
            </View>
          </View>
        )}
      </Gradient>
    </Modal>
  );
}

const TopBar = ({ title, onClose, onMore }: { title: string; onClose: () => void; onMore?: () => void }) => {
  const s = useStyles();
  return (
    <View style={s.top}>
      <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Minimise the call screen" style={s.topBtn}>
        <Icon name="chevron_left" size={26} color="#FFFFFF" />
      </Pressable>
      <Text style={s.topText} numberOfLines={1}>{title}</Text>
      {onMore ? (
        <Pressable onPress={onMore} hitSlop={12} accessibilityRole="button" accessibilityLabel="Open the sales workspace" style={s.topBtn}>
          <Icon name="more_vert" size={22} color="#FFFFFF" />
        </Pressable>
      ) : <View style={{ width: 40 }} />}
    </View>
  );
};

const GlassButton = ({ icon, label, onPress, on, small }: { icon: IconName; label: string; onPress: () => void; on?: boolean; small?: boolean }) => {
  const s = useStyles();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!on }} style={({ pressed }) => [s.glassItem, small && { flex: 1 }, pressed && { opacity: 0.7 }]}>
      <View style={[s.glass, small && { width: 48, height: 48, borderRadius: 24 }, on && s.glassOn]}>
        <Icon name={icon} size={small ? 22 : 26} color={on ? '#6E1432' : '#FFFFFF'} />
      </View>
      <Text style={s.glassText}>{label}</Text>
    </Pressable>
  );
};

const useStyles = makeStyles(() => ({
  screen: { flex: 1, paddingHorizontal: space.xl, paddingTop: space.xxl, paddingBottom: space.xxl, justifyContent: 'space-between' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  topBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center' },
  topText: { flex: 1, textAlign: 'center', color: 'rgba(255,255,255,0.88)', fontSize: 14, fontWeight: '700', letterSpacing: 0.4 },
  center: { alignItems: 'center' },
  upNext: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: space.sm },
  ringBox: { width: 200, height: 200, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  ring: { position: 'absolute', width: 150, height: 150, borderRadius: 75, borderWidth: 3, borderColor: '#FF8A5B' },
  ringOuter: { borderColor: '#F44350', borderWidth: 2 },
  ringCore: {
    borderRadius: 64, borderWidth: 4, borderColor: '#FF8A5B', padding: 4, backgroundColor: 'rgba(255,255,255,0.08)',
    elevation: 16, shadowColor: '#FF7556', shadowOpacity: 0.8, shadowRadius: 24, shadowOffset: { width: 0, height: 0 },
  },
  ringEnded: { borderColor: 'rgba(255,255,255,0.35)', elevation: 0 },
  name: { ...type.title, fontSize: 24, color: '#FFFFFF', textAlign: 'center' },
  phone: { fontSize: 15, color: 'rgba(255,255,255,0.8)', marginTop: 4, fontWeight: '600', letterSpacing: 0.3 },
  segment: { fontSize: 13, color: 'rgba(255,255,255,0.6)', marginTop: 4 },
  timer: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: space.md, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: radius.pill, paddingHorizontal: 14, paddingVertical: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#34D399' },
  timerText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: 0.6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: space.lg },
  dialerRow: { flexDirection: 'row' },
  glassItem: { width: '33.33%', alignItems: 'center', gap: 8 },
  glass: {
    width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  glassOn: { backgroundColor: '#FFFFFF' },
  glassText: { color: 'rgba(255,255,255,0.88)', fontSize: 12.5, fontWeight: '600' },
  endRow: { alignItems: 'center', marginTop: space.xl, gap: 8 },
  endWrap: { borderRadius: 40, elevation: 14, shadowColor: '#F44350', shadowOpacity: 0.7, shadowRadius: 20, shadowOffset: { width: 0, height: 6 } },
  callWrap: { borderRadius: 40, elevation: 14, shadowColor: '#10B981', shadowOpacity: 0.7, shadowRadius: 20, shadowOffset: { width: 0, height: 6 } },
  end: { width: 76, height: 76, alignItems: 'center', justifyContent: 'center' },
  endText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  link: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  afterRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.md, paddingHorizontal: 4 },
  noteBox: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.xl, padding: space.lg, gap: space.md },
  noteInput: { minHeight: 90, color: '#FFFFFF', fontSize: 15, textAlignVertical: 'top' },
  outcomes: { backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: radius.xl, padding: space.lg },
  outTitle: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: space.md },
  outGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  outBtn: { width: '30%', alignItems: 'center', paddingVertical: 12, borderRadius: radius.lg, backgroundColor: 'rgba(255,255,255,0.12)', gap: 4 },
  outText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
}));
