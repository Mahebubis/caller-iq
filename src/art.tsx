import React, { memo } from 'react';
import { processColor, requireNativeComponent, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { makeStyles, useTheme } from './theme';

/*
 * The app's artwork:
 *   <Gradient>  a filled surface. The design is flat now, so it paints its first colour stop;
 *               the angle and leaf props are accepted and ignored so callers need no change.
 *   <Leaves>    draws nothing (the leaf sprays were retired with the flat design).
 *   <Donut>     a ring chart, drawn natively by CiqArtViews.kt
 *   <Avatar>    round initials in one of the person tints
 *   <Mark>      the CallIQ mark ("Signal C"), drawn natively by CiqMark.kt; `play` draws it in
 *   <Logo>      the lockup: the mark, then "Call" in ink + "IQ" in ember
 */

const NativeDonut = requireNativeComponent<any>('CiqDonut');
const NativeMark = requireNativeComponent<any>('CiqMark');

/** The brand colours of the mark, for the intro and anything drawn around the logo. */
export const BRAND = { night: '#0F0A08', ember: '#FF5A4E', flame: '#FF8A5B', glow: '#FFC27A', emberInk: '#E8443A' };

export const Mark = ({ size, tone = 'dark', play = false, style }: { size: number; tone?: 'dark' | 'light'; play?: boolean; style?: StyleProp<ViewStyle> }) => (
  <NativeMark tone={tone} play={play} style={[{ width: size, height: size }, style]} />
);

const colorsOf = (cs: string[]) => cs.map((c) => processColor(c) as number);

type LeafSpot = 'none' | 'corners' | 'bottom' | 'top' | 'bottom-right';

export const Gradient = ({ colors, corner = 0, style, children, pointerEvents }: {
  colors: string[];
  angle?: number;
  corner?: number;
  leaves?: LeafSpot;
  leafColor?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  pointerEvents?: 'box-none' | 'none' | 'auto';
}) => (
  <View style={[{ borderRadius: corner, backgroundColor: colors[0] }, style]} pointerEvents={pointerEvents}>
    {children}
  </View>
);

export const Leaves = (_: { spot?: LeafSpot; color?: string }) => null;

export const Donut = ({ values, colors, size = 140, thickness = 18, track, children }: {
  values: number[];
  colors: string[];
  size?: number;
  thickness?: number;
  track?: string;
  children?: React.ReactNode;
}) => {
  const t = useTheme();
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <NativeDonut
        style={StyleSheet.absoluteFill}
        values={values}
        colors={colorsOf(colors)}
        thickness={thickness}
        trackColor={processColor(track || t.c.surfaceAlt)}
      />
      {children}
    </View>
  );
};

export const initialsOf = (name?: string, phone?: string) => {
  const parts = (name || '').trim().split(/\s+/).filter((p) => /[A-Za-z\u00C0-\u024F\u0900-\u097F]/.test(p));
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (phone || '').replace(/\D/g, '').slice(-2) || '#';
};
/** The same person always gets the same tint. */
const hashOf = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); };

export const Avatar = memo(({ name, phone, size = 40 }: { name?: string; phone?: string; size?: number }) => {
  const t = useTheme();
  const s = useStyles();
  const tone = t.avatars[hashOf(`${name || ''}${phone || ''}`) % t.avatars.length];
  return (
    <View style={[s.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: tone.bg }]}>
      <Text style={[s.avatarText, { color: tone.fg, fontSize: Math.round(size * 0.36) }]} numberOfLines={1}>{initialsOf(name, phone)}</Text>
    </View>
  );
});

export const Logo = ({ size = 20, light }: { size?: number; light?: boolean }) => {
  const t = useTheme();
  const s = useStyles();
  const onDark = light || t.dark;
  return (
    <View style={s.lockup} accessible accessibilityRole="header" accessibilityLabel="CallIQ">
      <Mark size={Math.round(size * 1.45)} tone={onDark ? 'dark' : 'light'} />
      <Text style={[s.logo, { fontSize: size }]} numberOfLines={1}>
        <Text style={{ color: light ? '#FFFFFF' : t.c.text }}>Call</Text>
        <Text style={{ color: onDark ? BRAND.ember : BRAND.emberInk }}>IQ</Text>
      </Text>
    </View>
  );
};

const useStyles = makeStyles(() => ({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '600', letterSpacing: 0.2 },
  lockup: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  logo: { fontWeight: '800', letterSpacing: -0.6 },
}));
