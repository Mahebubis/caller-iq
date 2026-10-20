import React, { memo } from 'react';
import { processColor, requireNativeComponent, StyleProp, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { makeStyles, useTheme } from './theme';

/*
 * The Sunset Coral artwork, on top of the two native views in CiqArtViews.kt:
 *   <Gradient>  a gradient surface (buttons, chips, hero, call screen) with optional leaf sprays
 *   <Leaves>    just the translucent botanical leaves, for the corners of a plain screen or sheet
 *   <Donut>     a ring chart
 *   <Avatar>    round initials in one of the five avatar tints
 *   <Logo>      "Call" in charcoal + "IQ" in coral
 */

const NativeArt = requireNativeComponent<any>('CiqArt');
const NativeDonut = requireNativeComponent<any>('CiqDonut');

const colorsOf = (cs: string[]) => cs.map((c) => processColor(c) as number);

type LeafSpot = 'none' | 'corners' | 'bottom' | 'top' | 'bottom-right';

export const Gradient = ({ colors, angle = 90, corner = 0, leaves = 'none', leafColor, style, children, pointerEvents }: {
  colors: string[];
  /** CSS angle: 90 = left → right, 180 = top → bottom, 145 = the hero's diagonal. */
  angle?: number;
  corner?: number;
  leaves?: LeafSpot;
  leafColor?: string;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
  pointerEvents?: 'box-none' | 'none' | 'auto';
}) => (
  <View style={[{ borderRadius: corner }, style]} pointerEvents={pointerEvents}>
    <NativeArt
      style={[StyleSheet.absoluteFill, { borderRadius: corner }]}
      colors={colorsOf(colors)}
      angle={angle}
      corner={corner}
      leaves={leaves}
      leafColor={leafColor ? processColor(leafColor) : undefined}
      pointerEvents="none"
    />
    {children}
  </View>
);

/** Leaves alone, filling the parent (put it first, behind the content). */
export const Leaves = ({ spot = 'bottom', color }: { spot?: LeafSpot; color?: string }) => {
  const t = useTheme();
  return (
    <NativeArt
      style={StyleSheet.absoluteFill}
      colors={colorsOf(['#00000000', '#00000000'])}
      leaves={spot}
      leafColor={processColor(color || (t.dark ? 'rgba(255,138,143,0.07)' : 'rgba(244,67,80,0.07)'))}
      pointerEvents="none"
    />
  );
};

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
  return (
    <Text style={[s.logo, { fontSize: size }]} accessibilityRole="header" numberOfLines={1}>
      <Text style={{ color: light ? '#FFFFFF' : t.dark ? '#F8EEF1' : '#1E1B26' }}>Call</Text>
      <Text style={{ color: light ? '#FF9A8F' : '#F44350' }}>IQ</Text>
    </Text>
  );
};

const useStyles = makeStyles(() => ({
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontWeight: '800', letterSpacing: 0.2 },
  logo: { fontWeight: '800', letterSpacing: -0.5 },
}));
