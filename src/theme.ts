import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';

/*
 * The whole app's look in one place — the "Sunset Coral & Warm Peach" design system: warm peach
 * pages, crisp white cards with a soft coral-tinted shadow, blush inputs and pills, a sunset-coral
 * gradient for everything you press, a deep plum hero on Home and a crimson-burgundy call screen.
 * Screens never write a raw colour — they read `t.c.*` / `t.grad.*` through useTheme() /
 * makeStyles(), so the theme (light / dark), the accent colour and the font size restyle
 * everything at once.
 *
 * makeStyles also sets the app typeface (Plus Jakarta Sans, registered in MainApplication) on every
 * text style and scales sizes for the Small / Medium / Large setting.
 */

export interface Palette {
  bg: string;            // page behind the cards (top of the peach gradient)
  bgEnd: string;         // bottom of the page gradient
  surface: string;       // cards, header, tab bar, sheets
  surfaceAlt: string;    // inputs, pills, quiet fills inside a card
  input: string;         // search bars and form inputs
  border: string;        // the hairline round inputs and quiet cards
  borderStrong: string;
  divider: string;

  text: string;
  textSoft: string;
  muted: string;
  faint: string;

  primary: string;       // filled buttons, selected state (the accent)
  primaryPressed: string;
  onPrimary: string;     // text/icons on `primary`
  primarySoft: string;
  primaryLine: string;
  link: string;          // accent-coloured text and icons on a surface

  emerald: string;       // live / calling / "Call" fills
  amber: string;         // callbacks / syncing dots
  coral: string;         // danger fills and dots
  blue: string; blueSoft: string;   // "Assigned", trends

  success: string; successSoft: string;
  warning: string; warningSoft: string;
  danger: string; dangerSoft: string;
  orange: string; orangeSoft: string;
  violet: string; violetSoft: string;
  info: string; infoSoft: string;

  shadow: string;        // tint of card shadows
  scrim: string;
  toastBg: string;
  toastText: string;
  skeleton: string;
  shimmer: string;       // the light band that sweeps across a skeleton
  ripple: string;
}

/* ── accents: the six swatches in Settings → Appearance ── */
export type AccentKey = 'sunset' | 'rose' | 'purple' | 'ocean' | 'amber' | 'emerald';
interface Accent { label: string; grad: string[]; base: string; dark: string; ink: string; inkDark: string; soft: string; softDark: string; line: string; lineDark: string }
export const ACCENTS: { [k in AccentKey]: Accent } = {
  sunset: { label: 'Sunset Coral', grad: ['#FF7556', '#F44350', '#E62E5C'], base: '#F44350', dark: '#E62E5C', ink: '#DE2F3C', inkDark: '#FF8A8F', soft: '#FFE6E3', softDark: '#3A1520', line: '#FBC4C0', lineDark: '#6B2433' },
  rose: { label: 'Rose Pink', grad: ['#FB7185', '#EC4899', '#DB2777'], base: '#EC4899', dark: '#DB2777', ink: '#C81E6A', inkDark: '#F9A8D4', soft: '#FCE7F3', softDark: '#3A1530', line: '#F9C3DE', lineDark: '#6B2452' },
  purple: { label: 'Royal Purple', grad: ['#A78BFA', '#8B5CF6', '#6D28D9'], base: '#7C3AED', dark: '#6D28D9', ink: '#6D28D9', inkDark: '#C4B5FD', soft: '#EDE9FE', softDark: '#2A1E45', line: '#D4C8FC', lineDark: '#4C3A85' },
  ocean: { label: 'Ocean Blue', grad: ['#38BDF8', '#3B82F6', '#2563EB'], base: '#3B82F6', dark: '#2563EB', ink: '#1D4ED8', inkDark: '#93C5FD', soft: '#E3EEFF', softDark: '#152742', line: '#BFD7FE', lineDark: '#2A4A7A' },
  amber: { label: 'Amber Gold', grad: ['#FBBF24', '#F59E0B', '#D97706'], base: '#E58E0B', dark: '#D97706', ink: '#B45309', inkDark: '#FCD34D', soft: '#FEF3C7', softDark: '#33240A', line: '#FCE29A', lineDark: '#6B4A12' },
  emerald: { label: 'Emerald', grad: ['#34D399', '#10B981', '#059669'], base: '#10B981', dark: '#059669', ink: '#047857', inkDark: '#6EE7B7', soft: '#D1FAE5', softDark: '#0F2E25', line: '#A7F0CF', lineDark: '#1F5A46' },
};

export type FontSize = 'small' | 'medium' | 'large';
export const FONT_SCALE: { [k in FontSize]: number } = { small: 0.92, medium: 1, large: 1.1 };
export const FONT = 'Plus Jakarta Sans';

const light = (a: Accent): Palette => ({
  bg: '#FFF6F2',
  bgEnd: '#FDECE6',
  surface: '#FFFFFF',
  surfaceAlt: '#F9EAE4',
  input: '#F7E6DF',
  border: '#F2D8CE',
  borderStrong: '#E9C3B5',
  divider: '#F6E3DB',

  text: '#1F1924',
  textSoft: '#4A3B44',
  muted: '#7D6E75',
  faint: '#B3A1A8',

  primary: a.base,
  primaryPressed: a.dark,
  onPrimary: '#FFFFFF',
  primarySoft: a.soft,
  primaryLine: a.line,
  link: a.ink,

  emerald: '#10B981',
  amber: '#F59E0B',
  coral: '#F43F5E',
  blue: '#2563EB', blueSoft: '#EBF3FE',

  success: '#059669', successSoft: '#E0F8EF',
  warning: '#D97706', warningSoft: '#FEF3C7',
  danger: '#E11D48', dangerSoft: '#FFE4E8',
  orange: '#EA580C', orangeSoft: '#FFEDD5',
  violet: '#7C3AED', violetSoft: '#F1EAFE',
  info: '#0E7490', infoSoft: '#E0F7FA',

  shadow: '#EB5757',
  scrim: 'rgba(31, 25, 36, 0.5)',
  toastBg: '#1F1924',
  toastText: '#FFFFFF',
  skeleton: '#F4E1D9',
  shimmer: 'rgba(255, 255, 255, 0.7)',
  ripple: 'rgba(244, 67, 80, 0.10)',
});

const dark = (a: Accent): Palette => ({
  bg: '#160E14',
  bgEnd: '#1D1119',
  surface: '#22161E',
  surfaceAlt: '#2E1E28',
  input: '#2E1E28',
  border: '#3A2632',
  borderStrong: '#4E3443',
  divider: '#2E1E28',

  text: '#F8EEF1',
  textSoft: '#E2CFD6',
  muted: '#B39CA6',
  faint: '#7D6670',

  primary: a.base,
  primaryPressed: a.dark,
  onPrimary: '#FFFFFF',
  primarySoft: a.softDark,
  primaryLine: a.lineDark,
  link: a.inkDark,

  emerald: '#10B981',
  amber: '#F59E0B',
  coral: '#F43F5E',
  blue: '#93C5FD', blueSoft: '#152742',

  success: '#34D399', successSoft: '#0F2E25',
  warning: '#FBBF24', warningSoft: '#33240A',
  danger: '#FB7185', dangerSoft: '#3A1220',
  orange: '#FB923C', orangeSoft: '#36200F',
  violet: '#C4B5FD', violetSoft: '#2A1E45',
  info: '#67E8F9', infoSoft: '#0F2930',

  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.62)',
  toastBg: '#F8EEF1',
  toastText: '#160E14',
  skeleton: '#2E1E28',
  shimmer: 'rgba(255, 255, 255, 0.06)',
  ripple: 'rgba(255, 138, 143, 0.14)',
});

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };
/** Corners: inputs 12, cards 18–20, sheets 24, pills round. */
export const radius = { sm: 8, md: 12, lg: 18, xl: 20, xxl: 24, pill: 999 };

/** Type scale (Plus Jakarta Sans). Sizes here are Medium; makeStyles scales them. */
export const type = {
  display: { fontSize: 26, fontWeight: '800' as const, letterSpacing: -0.5 },
  title: { fontSize: 20, fontWeight: '800' as const, letterSpacing: -0.3 },
  heading: { fontSize: 16, fontWeight: '700' as const },
  subheading: { fontSize: 14.5, fontWeight: '600' as const },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyStrong: { fontSize: 14, fontWeight: '600' as const },
  caption: { fontSize: 12.5, fontWeight: '500' as const, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '600' as const },
  overline: { fontSize: 11, fontWeight: '700' as const, letterSpacing: 0.7, textTransform: 'uppercase' as const },
  /** A card's title — a list name, a contact. */
  cardTitle: { fontSize: 16.5, fontWeight: '700' as const, letterSpacing: -0.2 },
  /** Headline numbers: heavy, with tabular digits so counts don't jiggle as they change. */
  metric: { fontSize: 22, fontWeight: '800' as const, letterSpacing: -0.4, fontVariant: ['tabular-nums' as const] },
};

export interface StatusTone { fg: string; bg: string }

export interface Theme {
  dark: boolean;
  c: Palette;
  accent: AccentKey;
  fontScale: number;
  /** Gradients (colour stops) for CiqArt: buttons, the Home hero, the call screen, quick tiles. */
  grad: {
    primary: string[];
    page: string[];
    header: string[];
    call: string[];
    tiles: { start: string[]; lists: string[]; callbacks: string[]; reports: string[] };
  };
  /** Initials avatars cycle through these (fg on bg). */
  avatars: StatusTone[];
  /** Status of one person on a calling list, worded as the admin panel words it. */
  status: { [k: string]: StatusTone };
}

const makeTheme = (isDark: boolean, accent: AccentKey, fontScale: number): Theme => {
  const a = ACCENTS[accent];
  const c = isDark ? dark(a) : light(a);
  return {
    dark: isDark,
    c,
    accent,
    fontScale,
    grad: {
      primary: a.grad,
      page: [c.bg, c.bgEnd],
      header: isDark ? ['#24083F', '#2E0D30', '#3E0A27'] : ['#3A0CA3', '#4A154B', '#6B1143'],
      call: ['#4A102A', '#6E1432', '#38091B'],
      tiles: {
        start: ['#10B981', '#059669'],
        lists: ['#8B5CF6', '#6D28D9'],
        callbacks: ['#F97316', '#EA580C'],
        reports: ['#EC4899', '#DB2777'],
      },
    },
    avatars: isDark
      ? [{ fg: '#FFB4AE', bg: '#3A1520' }, { fg: '#F9A8D4', bg: '#3A1530' }, { fg: '#5EEAD4', bg: '#0F2E2B' }, { fg: '#FDBA74', bg: '#36200F' }, { fg: '#C4B5FD', bg: '#2A1E45' }]
      : [{ fg: '#DE2F3C', bg: '#FFE6E3' }, { fg: '#DB2777', bg: '#FCE7F3' }, { fg: '#0F766E', bg: '#D5F5EF' }, { fg: '#EA580C', bg: '#FFEDD5' }, { fg: '#7C3AED', bg: '#EDE9FE' }],
    status: {
      'Needs callback': { fg: c.warning, bg: c.warningSoft },
      'Missed call': { fg: c.danger, bg: c.dangerSoft },
      Scheduled: { fg: c.warning, bg: c.warningSoft },
      Connected: { fg: c.success, bg: c.successSoft },
      Called: { fg: c.success, bg: c.successSoft },
      'Not connected': { fg: c.orange, bg: c.orangeSoft },
      Calling: { fg: c.success, bg: c.successSoft },
      'Not called': { fg: isDark ? '#B8C2D0' : '#64748B', bg: isDark ? '#273042' : '#F1F5F9' },
      'WhatsApp sent': { fg: c.info, bg: c.infoSoft },
      'No phone': { fg: c.faint, bg: c.surfaceAlt },
    },
  };
};

/* One object per (dark, accent, size), so styles built from them can be cached (see makeStyles). */
const themes = new Map<string, Theme>();
export const getTheme = (isDark: boolean, accent: AccentKey = 'sunset', size: FontSize = 'medium'): Theme => {
  const key = `${isDark}|${accent}|${size}`;
  let t = themes.get(key);
  if (!t) {
    t = makeTheme(isDark, ACCENTS[accent] ? accent : 'sunset', FONT_SCALE[size] || 1);
    themes.set(key, t);
  }
  return t;
};
export const lightTheme = getTheme(false);
export const darkTheme = getTheme(true);

export type ThemePref = 'system' | 'light' | 'dark';

export const ThemeContext = createContext<Theme>(lightTheme);
export const useTheme = () => useContext(ThemeContext);

/** The warm card shadow (`0 8px 24px rgba(235, 87, 87, 0.07)`), as Android elevation tinted coral. */
export const elevation = (t: Theme, level: 1 | 2 | 3 = 1) => ({
  elevation: level === 1 ? 3 : level === 2 ? 6 : 10,
  shadowColor: t.c.shadow,
  shadowOpacity: t.dark ? 0.4 : level === 3 ? 0.35 : 0.12,
  shadowRadius: level === 1 ? 12 : 16,
  shadowOffset: { width: 0, height: level === 1 ? 4 : 6 },
});
/** The glow under a coral gradient button or the call FAB. */
export const glow = (t: Theme) => ({
  elevation: 8,
  shadowColor: t.c.primary,
  shadowOpacity: 0.35,
  shadowRadius: 16,
  shadowOffset: { width: 0, height: 6 },
});

/* Text styles get the typeface and the size setting. Icons (MaterialIconsRound) keep theirs. */
const typeset = (style: any, scale: number) => {
  if (!style || typeof style !== 'object' || Array.isArray(style)) return style;
  const isText = style.fontSize != null || style.fontWeight != null || style.lineHeight != null || style.letterSpacing != null;
  if (!isText || style.fontFamily) return style;
  const out = { ...style, fontFamily: FONT };
  if (scale !== 1) {
    if (typeof out.fontSize === 'number') out.fontSize = Math.round(out.fontSize * scale * 2) / 2;
    if (typeof out.lineHeight === 'number') out.lineHeight = Math.round(out.lineHeight * scale);
  }
  return out;
};

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
      const raw: any = factory(t);
      Object.keys(raw).forEach((k) => { raw[k] = typeset(raw[k], t.fontScale); });
      s = StyleSheet.create(raw) as T;
      cache.set(t, s);
    }
    return s;
  };
}

/** For the few text styles written inline: the typeface and the size setting. */
export const textStyle = (t: Theme, style: any) => typeset(style, t.fontScale);
