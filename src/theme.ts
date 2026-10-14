import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';

/*
 * The whole app's look in one place: a light and a dark palette built on one indigo brand colour,
 * plus the spacing, corner and type scales every screen uses. Screens never write a raw colour —
 * they read `t.c.*` through useTheme() / makeStyles(), so switching theme restyles everything.
 *
 * Surfaces are layered (page → card → quiet fill) and separated by 1px hairlines, never by blurry
 * shadows. Text colours on their "soft" tints pass WCAG AA (4.5:1) at 12px; the bright accents
 * (emerald, amber, coral) are for fills, dots and icons, where that rule doesn't apply.
 */

export interface Palette {
  bg: string;            // page behind the cards
  surface: string;       // cards, header, tab bar, sheets
  surfaceAlt: string;    // inputs, pills, quiet fills inside a card
  border: string;        // the 1px hairline round every card and input
  borderStrong: string;
  divider: string;

  text: string;
  textSoft: string;
  muted: string;
  faint: string;

  primary: string;       // filled buttons, selected state
  primaryPressed: string;
  onPrimary: string;     // text/icons on `primary`
  primarySoft: string;
  primaryLine: string;
  link: string;          // primary-coloured text and icons on a surface

  emerald: string;       // live / calling / "Call" fills
  amber: string;         // syncing / uploading dots
  coral: string;         // danger fills and dots
  blue: string; blueSoft: string;   // "Scheduled"

  success: string; successSoft: string;
  warning: string; warningSoft: string;
  danger: string; dangerSoft: string;
  orange: string; orangeSoft: string;
  violet: string; violetSoft: string;
  info: string; infoSoft: string;

  scrim: string;
  toastBg: string;
  toastText: string;
  skeleton: string;
  shimmer: string;       // the light band that sweeps across a skeleton
  ripple: string;
}

const light: Palette = {
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  surfaceAlt: '#F1F5F9',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',
  divider: '#EEF2F6',

  text: '#0F172A',
  textSoft: '#334155',
  muted: '#64748B',
  faint: '#94A3B8',

  primary: '#4F46E5',
  primaryPressed: '#4338CA',
  onPrimary: '#FFFFFF',
  primarySoft: '#EEF2FF',
  primaryLine: '#C7D2FE',
  link: '#4F46E5',

  emerald: '#10B981',
  amber: '#F59E0B',
  coral: '#EF4444',
  blue: '#1D4ED8', blueSoft: '#EFF6FF',

  success: '#047857', successSoft: '#ECFDF5',
  warning: '#B45309', warningSoft: '#FFFBEB',
  danger: '#DC2626', dangerSoft: '#FEF2F2',
  orange: '#C2410C', orangeSoft: '#FFF7ED',
  violet: '#6D28D9', violetSoft: '#F5F3FF',
  info: '#0E7490', infoSoft: '#ECFEFF',

  scrim: 'rgba(15, 23, 42, 0.5)',
  toastBg: '#0F172A',
  toastText: '#FFFFFF',
  skeleton: '#E2E8F0',
  shimmer: 'rgba(255, 255, 255, 0.65)',
  ripple: 'rgba(79, 70, 229, 0.10)',
};

const dark: Palette = {
  bg: '#090D16',
  surface: '#111827',
  surfaceAlt: '#1E293B',
  border: '#1F2937',
  borderStrong: '#334155',
  divider: '#1A2232',

  text: '#F1F5F9',
  textSoft: '#CBD5E1',
  muted: '#94A3B8',
  faint: '#64748B',

  primary: '#4F46E5',
  primaryPressed: '#6366F1',
  onPrimary: '#FFFFFF',
  primarySoft: '#1E1B4B',
  primaryLine: '#3730A3',
  link: '#A5B4FC',

  emerald: '#10B981',
  amber: '#F59E0B',
  coral: '#EF4444',
  blue: '#93C5FD', blueSoft: '#172554',

  success: '#34D399', successSoft: '#064E3B',
  warning: '#FBBF24', warningSoft: '#2A2111',
  danger: '#F87171', dangerSoft: '#2E1517',
  orange: '#FB923C', orangeSoft: '#2C1C10',
  violet: '#C4B5FD', violetSoft: '#241D3F',
  info: '#67E8F9', infoSoft: '#0F2930',

  scrim: 'rgba(0, 0, 0, 0.62)',
  toastBg: '#F1F5F9',
  toastText: '#090D16',
  skeleton: '#1E293B',
  shimmer: 'rgba(255, 255, 255, 0.06)',
  ripple: 'rgba(165, 180, 252, 0.14)',
};

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };
export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };

/** Type scale. Roboto at these weights reads crisper than the old 800s everywhere. */
export const type = {
  display: { fontSize: 26, fontWeight: '700' as const, letterSpacing: -0.4 },
  title: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.2 },
  heading: { fontSize: 16, fontWeight: '700' as const },
  subheading: { fontSize: 14.5, fontWeight: '600' as const },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyStrong: { fontSize: 14, fontWeight: '600' as const },
  caption: { fontSize: 12.5, fontWeight: '400' as const, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '600' as const },
  overline: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.7, textTransform: 'uppercase' as const },
  /** A card's title — a list name, a contact. */
  cardTitle: { fontSize: 17, fontWeight: '600' as const, letterSpacing: -0.2 },
  /** Headline numbers: heavy, with tabular digits so counts don't jiggle as they change. */
  metric: { fontSize: 22, fontWeight: '800' as const, letterSpacing: -0.4, fontVariant: ['tabular-nums' as const] },
};

export interface StatusTone { fg: string; bg: string }

export interface Theme {
  dark: boolean;
  c: Palette;
  /**
   * Status of one person on a calling list, worded as the admin panel words it. "Needs callback"
   * is the one solid badge, so it can never be mistaken for a green "Called" at a glance.
   */
  status: { [k: string]: StatusTone };
}

const makeTheme = (isDark: boolean, c: Palette): Theme => ({
  dark: isDark,
  c,
  status: {
    'Needs callback': { fg: isDark ? '#2A0B0B' : '#FFFFFF', bg: c.danger },
    'Missed call': { fg: c.danger, bg: c.dangerSoft },
    Scheduled: { fg: c.blue, bg: c.blueSoft },
    Connected: { fg: c.success, bg: c.successSoft },
    Called: { fg: c.success, bg: c.successSoft },
    'Not connected': { fg: c.orange, bg: c.orangeSoft },
    Calling: { fg: c.success, bg: c.successSoft },
    'Not called': { fg: c.muted, bg: c.surfaceAlt },
    'No phone': { fg: c.faint, bg: c.surfaceAlt },
  },
});

// Two fixed objects, so styles built from them can be cached per theme (see makeStyles).
export const lightTheme = makeTheme(false, light);
export const darkTheme = makeTheme(true, dark);

export type ThemePref = 'system' | 'light' | 'dark';

export const ThemeContext = createContext<Theme>(lightTheme);
export const useTheme = () => useContext(ThemeContext);

/**
 * Styles that depend on the theme, built once per theme rather than on every render:
 *   const useStyles = makeStyles((t) => ({ card: { backgroundColor: t.c.surface } }));
 *   const s = useStyles();
 */
export function makeStyles<T extends StyleSheet.NamedStyles<T>>(factory: (t: Theme) => T): () => T {
  const cache = new Map<Theme, T>();
  return () => {
    const t = useTheme();
    let s = cache.get(t);
    if (!s) {
      s = StyleSheet.create(factory(t));
      cache.set(t, s);
    }
    return s;
  };
}
