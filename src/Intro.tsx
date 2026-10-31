import React, { useEffect, useMemo, useRef } from 'react';
import { AccessibilityInfo, Animated, Dimensions, Easing, NativeModules, Platform, Pressable, requireNativeComponent, StatusBar, StyleSheet, Text, View } from 'react-native';
import { BRAND, Mark } from './art';

const NativeGlow = requireNativeComponent<any>('CiqGlow');
import { textStyle, useTheme } from './theme';

const { CallBridge } = NativeModules;

/*
 * The CallIQ brand intro, played each time the app is opened (App.tsx decides when) over the app
 * while it loads underneath:
 *
 *   1 Night    the system splash (Android 12+) shows the mark on night; this screen starts with
 *              the same mark at the same size and place, so the hand-over cannot be seen. Older
 *              Android has no system splash: there the mark draws itself in.
 *   2 Glow     an ember glow blooms behind the mark as it breathes.
 *   3 Signal   three sound-wave rings ripple out and a burst of ember, flame and glow sparks spreads.
 *   4 Welcome  the mark lifts; "Welcome to CallIQ" and the tagline rise in.
 *   5 Enter    everything fades and opens slightly onto the app.
 *
 * About 3.3 s; a tap anywhere skips it. Transform and opacity only, all on the native driver. With
 * "Remove animations" on, it is a short quiet fade instead.
 */

// The system splash draws the 108-unit icon at 288 dp; the mark's arcs span 41.6 units, so 111 dp.
// CiqMarkView's arcs span 0.64 of its size: 173 dp keeps the two the same.
const MARK = 173;
// The core sits 4% of the mark's size left of its centre (the spark takes the right): effects start there.
const CORE_DX = -MARK * 0.04;
// The glow's diameter against the mark's size.
const GLOW = 3.2;
const SPARKS = 18;
const RINGS = 3;

/** `resume`: opened again while the app was already running, so no system splash to take over from. */
export default function Intro({ onDone, resume }: { onDone: () => void; resume?: boolean }) {
  const t = useTheme();
  const { width: W, height: H } = Dimensions.get('screen');
  // Where the system splash put the mark: the centre of the whole screen, in this view's terms.
  const top = Platform.OS === 'android' ? (StatusBar.currentHeight || 0) : 0;
  const centreY = H / 2 - top;

  const fade = useRef(new Animated.Value(1)).current;        // the whole intro
  const open = useRef(new Animated.Value(0)).current;        // the exit's slight opening
  const glow = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const words = useRef(new Animated.Value(0)).current;
  const tagline = useRef(new Animated.Value(0)).current;
  const rings = useRef(Array.from({ length: RINGS }, () => new Animated.Value(0))).current;
  const burst = useRef(new Animated.Value(0)).current;
  const finished = useRef(false);
  const drawIn = !!resume || (Platform.OS === 'android' && Number(Platform.Version) < 31);

  const sparks = useMemo(() => Array.from({ length: SPARKS }, (_, i) => {
    const a = (i / SPARKS) * Math.PI * 2 + ((i * 37) % 11) * 0.04;
    const d = 118 + ((i * 53) % 7) * 12;
    return {
      dx: Math.cos(a) * d,
      dy: Math.sin(a) * d,
      size: 3 + ((i * 29) % 4),
      color: [BRAND.ember, BRAND.flame, BRAND.glow, '#FFFFFF'][i % 4],
    };
  }), []);

  const handOver = () => {
    if (finished.current) return;
    finished.current = true;
    CallBridge?.setSystemBarsTheme?.(t.dark, t.c.bg);
    onDone();
  };

  /** A tap (or reduced motion): stop the show and fade out quickly from wherever it is. */
  const finish = (quick?: boolean) => {
    if (finished.current) return;
    show.current?.stop();
    Animated.parallel([
      Animated.timing(fade, { toValue: 0, duration: quick ? 240 : 420, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.timing(open, { toValue: 1, duration: quick ? 240 : 420, easing: Easing.out(Easing.quad), useNativeDriver: true }),
    ]).start(handOver);
  };

  /*
   * The whole intro, exit included, is queued at mount as one animation on the native driver, so
   * it starts on the first frame and keeps time even while the app's start-up keeps the JS thread
   * busy. JS only hears back at the very end, to hand the system bars to the app.
   */
  const show = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => {
    CallBridge?.setSystemBarsTheme?.(true, BRAND.night);
    const ease = Easing.bezier(0.2, 0, 0, 1);
    const d = drawIn ? 450 : 0;                 // no system splash: time for the mark to draw itself in
    show.current = Animated.sequence([
      Animated.parallel([
        // 2 Glow, and the mark breathing.
        Animated.timing(glow, { toValue: 1, duration: 900, delay: d + 150, easing: ease, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(d + 250),
          Animated.timing(breath, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(breath, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        ]),
        // 3 Signal: the rings, one after another, and the burst of sparks.
        ...rings.map((r, i) => Animated.timing(r, { toValue: 1, duration: 1500, delay: d + 480 + i * 260, easing: Easing.out(Easing.cubic), useNativeDriver: true })),
        Animated.timing(burst, { toValue: 1, duration: 1350, delay: d + 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        // 4 Welcome: the mark lifts, the words rise in.
        Animated.timing(lift, { toValue: 1, duration: 620, delay: d + 1050, easing: ease, useNativeDriver: true }),
        Animated.timing(words, { toValue: 1, duration: 620, delay: d + 1200, easing: ease, useNativeDriver: true }),
        Animated.timing(tagline, { toValue: 1, duration: 620, delay: d + 1450, easing: ease, useNativeDriver: true }),
      ]),
      Animated.delay(550),
      // 5 Enter: everything fades and opens slightly onto the app.
      Animated.parallel([
        Animated.timing(fade, { toValue: 0, duration: 420, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(open, { toValue: 1, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]),
    ]);
    show.current.start(({ finished: done }) => { if (done) handOver(); });
    // "Remove animations" on: no travel — the welcome at once, then a short quiet fade.
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!reduce || finished.current) return;
      show.current?.stop();
      [glow, words, tagline, lift].forEach((v) => v.setValue(1));
      setTimeout(() => finish(), 900);
    }).catch(() => {});
    return () => show.current?.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const up = lift.interpolate({ inputRange: [0, 1], outputRange: [0, -64] });
  const breathe = breath.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, s.stage, { opacity: fade }]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={() => finish(true)} accessibilityRole="button" accessibilityLabel="Welcome to CallIQ. Tap to skip">
        <Animated.View style={[s.centre, { top: centreY - MARK / 2, transform: [{ translateY: up }, { scale: open.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] }) }] }]} pointerEvents="none">
          <View style={[StyleSheet.absoluteFill, s.core]}>
          {/* The glow: one native radial gradient (smooth, no banding) that blooms behind the mark. */}
          <Animated.View
            style={[s.disc, {
              width: MARK * GLOW, height: MARK * GLOW,
              opacity: glow,
              transform: [{ scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }],
            }]}
          >
            <NativeGlow color={BRAND.ember} style={StyleSheet.absoluteFill} />
          </Animated.View>
          {/* The signal: rings rippling out from the core. */}
          {rings.map((r, i) => (
            <Animated.View
              key={i}
              style={[s.disc, s.ring, {
                width: MARK, height: MARK, borderRadius: MARK / 2,
                opacity: r.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.6, 0] }),
                transform: [{ scale: r.interpolate({ inputRange: [0, 1], outputRange: [0.45, 2.7] }) }],
              }]}
            />
          ))}
          {/* The sparks. */}
          {sparks.map((p, i) => (
            <Animated.View
              key={`p${i}`}
              style={[s.disc, {
                width: p.size, height: p.size, borderRadius: p.size / 2, backgroundColor: p.color,
                opacity: burst.interpolate({ inputRange: [0, 0.12, 0.7, 1], outputRange: [0, 1, 0.6, 0] }),
                transform: [
                  { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [p.dx * 0.25, p.dx] }) },
                  { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [p.dy * 0.25, p.dy] }) },
                ],
              }]}
            />
          ))}
          </View>
          <Animated.View style={{ transform: [{ scale: breathe }] }}>
            <Mark size={MARK} play={drawIn} />
          </Animated.View>
        </Animated.View>

        {/* The welcome. */}
        <View style={[s.words, { top: centreY + MARK / 2 - 64 + 12, width: W }]} pointerEvents="none">
          <Animated.Text style={[textStyle(t, s.welcome), { opacity: words, transform: [{ translateY: words.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }]}>
            Welcome to
          </Animated.Text>
          <Animated.Text style={[textStyle(t, s.word), { opacity: words, transform: [{ translateY: words.interpolate({ inputRange: [0, 1], outputRange: [22, 0] }) }] }]}>
            Call<Text style={{ color: BRAND.ember }}>IQ</Text>
          </Animated.Text>
          <Animated.Text style={[textStyle(t, s.tagline), { opacity: tagline, transform: [{ translateY: tagline.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
            Smarter calls. Warmer leads.
          </Animated.Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  stage: { backgroundColor: BRAND.night, zIndex: 100, elevation: 100 },
  centre: { position: 'absolute', left: 0, right: 0, height: MARK, alignItems: 'center', justifyContent: 'center' },
  core: { alignItems: 'center', justifyContent: 'center', transform: [{ translateX: CORE_DX }] },
  disc: { position: 'absolute' },
  ring: { borderWidth: 1.5, borderColor: BRAND.ember },
  words: { position: 'absolute', left: 0, alignItems: 'center' },
  welcome: { fontSize: 15, fontWeight: '700', color: BRAND.glow, letterSpacing: 0.2 },
  word: { fontSize: 42, fontWeight: '800', letterSpacing: -1.4, color: '#FFFFFF', marginTop: 2 },
  tagline: { fontSize: 15.5, fontWeight: '500', color: 'rgba(255,255,255,0.72)', marginTop: 10 },
});
