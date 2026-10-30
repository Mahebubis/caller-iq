import { createContext, useContext } from 'react';
import { StyleSheet } from 'react-native';

/*
 * The whole app's look in one place. A quiet warm frame (header, tab bar, page) stepped from the
 * coral brand, white working surfaces with a 1px warm edge and no shadow, and the accent kept for
 * the one action and the main data. Nothing at rest has a gradient, a glow or a shadow; only what
 * floats (a menu, a sheet, a toast) casts one.
 * Screens never write a raw colour — they read `t.c.*` / `t.grad.*` through useTheme() /
 * makeStyles(), so the theme (light / dark), the accent colour and the font size restyle
 * everything at once. `t.grad.*` is kept for the components that take colour stops; every stop
 * pair is one flat colour.
 *
 * makeStyles also sets the app typeface (Plus Jakarta Sans, registered in MainApplication) on every
 * text style and scales sizes for the Small / Medium / Large setting.
 */

export interface Palette {
  bg: string;            // the frame and the page behind the cards
  bgEnd: string;         // same as bg (the page no longer fades)
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
  shimmer: string;       // unused: skeletons are flat (kept so callers still type-check)
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

/*
 * Light: a warm cream page (#FBF5EF), white cards lifted by a soft warm shadow, cream wells inside
 * them. Text in warm inks, each tier 4.5:1 or more on white and on the cream. Filled controls use
 * the accent's ink step, the shade that holds white text at 4.5:1 for every accent.
 */
const light = (a: Accent): Palette => ({
  bg: '#FBF5EF',
  bgEnd: '#FBF5EF',
  surface: '#FFFFFF',
  surfaceAlt: '#F7EEE6',
  input: '#FFFFFF',
  border: '#F0E4DA',
  borderStrong: '#E3D3C6',
  divider: '#F5ECE4',

  text: '#1F1714',
  textSoft: '#45372F',
  muted: '#6B5D55',
  faint: '#7C6E66',

  primary: a.ink,
  primaryPressed: a.dark,
  onPrimary: '#FFFFFF',
  primarySoft: a.soft,
  primaryLine: a.line,
  link: a.ink,

  emerald: '#1E8A57',
  amber: '#B7791F',
  coral: '#D9373F',
  blue: '#1D5FBF', blueSoft: '#E8F0FB',

  success: '#247B50', successSoft: '#DCFAE5',
  warning: '#92400E', warningSoft: '#FFF6E0',
  danger: '#C4242A', dangerSoft: '#FFEDEA',
  orange: '#A8470F', orangeSoft: '#FFEFE3',
  violet: '#8A3B6B', violetSoft: '#F8EBF2',
  info: '#0E6B85', infoSoft: '#E4F4F8',

  shadow: '#7A3E1D',
  scrim: 'rgba(31, 23, 20, 0.5)',
  toastBg: '#1F1714',
  toastText: '#FFFFFF',
  skeleton: '#F3E8DE',
  shimmer: 'rgba(255, 255, 255, 0)',
  ripple: 'rgba(31, 23, 20, 0.06)',
});

/* Dark: a deep coffee page, warm brown cards one lightness step up, cream text. */
const dark = (a: Accent): Palette => ({
  bg: '#15100D',
  bgEnd: '#15100D',
  surface: '#221B17',
  surfaceAlt: '#2D2520',
  input: '#221B17',
  border: '#352B24',
  borderStrong: '#4A3D34',
  divider: '#2D2520',

  text: '#FBF3EC',
  textSoft: '#E6D9CF',
  muted: '#BFAFA4',
  faint: '#A08F84',

  primary: a.ink,
  primaryPressed: a.dark,
  onPrimary: '#FFFFFF',
  primarySoft: a.softDark,
  primaryLine: a.lineDark,
  link: a.inkDark,

  emerald: '#3FC07A',
  amber: '#E3A33B',
  coral: '#E5566F',
  blue: '#8DB8F2', blueSoft: '#16243A',

  success: '#3FC07A', successSoft: '#172A1D',
  warning: '#F2B544', warningSoft: '#2E2410',
  danger: '#E5566F', dangerSoft: '#2C1A20',
  orange: '#F0975A', orangeSoft: '#33200F',
  violet: '#E39AC4', violetSoft: '#2E1A26',
  info: '#6CCFE3', infoSoft: '#10282E',

  shadow: '#000000',
  scrim: 'rgba(0, 0, 0, 0.62)',
  toastBg: '#FBF3EC',
  toastText: '#15100D',
  skeleton: '#2D2520',
  shimmer: 'rgba(255, 255, 255, 0)',
  ripple: 'rgba(255, 255, 255, 0.08)',
});

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 };
/** Corners: chunky and friendly. Cards 24, inner wells 18, tiles 16, sheets 28; controls fully round. */
export const radius = { sm: 8, md: 12, lg: 18, xl: 24, xxl: 28, pill: 999 };

/**
 * Type scale (Plus Jakarta Sans). Sizes here are Medium; makeStyles scales them. Big and confident
 * where it counts — screen titles and headline numbers in ExtraBold — and calm everywhere else.
 */
export const type = {
  display: { fontSize: 28, fontWeight: '800' as const, letterSpacing: -0.7 },
  title: { fontSize: 22, fontWeight: '800' as const, letterSpacing: -0.4 },
  heading: { fontSize: 17, fontWeight: '700' as const, letterSpacing: -0.2 },
  subheading: { fontSize: 15, fontWeight: '600' as const },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyStrong: { fontSize: 14, fontWeight: '600' as const },
  caption: { fontSize: 12.5, fontWeight: '500' as const, lineHeight: 18 },
  label: { fontSize: 12, fontWeight: '600' as const },
  /** A section's name over its block ("Callbacks", "Calling lists"). */
  overline: { fontSize: 17, fontWeight: '800' as const, letterSpacing: -0.3 },
  /** A card's title — a list name, a contact. */
  cardTitle: { fontSize: 16.5, fontWeight: '700' as const, letterSpacing: -0.2 },
  /** Headline numbers: ExtraBold with tabular digits so counts don't jiggle as they change. */
  metric: { fontSize: 28, fontWeight: '800' as const, letterSpacing: -0.8, fontVariant: ['tabular-nums' as const] },
};

/** The pastel pairs for coloured tiles and cards: a soft fill and the deep ink of the same hue. */
export interface Tint { bg: string; fg: string }

export interface StatusTone { fg: string; bg: string }

export interface Theme {
  dark: boolean;
  c: Palette;
  accent: AccentKey;
  fontScale: number;
  /** Colour stops for <Gradient> callers; each pair is one flat colour (no gradients at rest). */
  grad: {
    primary: string[];
    page: string[];
    header: string[];
    call: string[];
    tiles: { start: string[]; lists: string[]; callbacks: string[]; reports: string[] };
  };
  /** Initials avatars cycle through these (fg on bg). */
  avatars: StatusTone[];
  /** Pastel fills with their deep ink, for coloured tiles, stat cards and list covers. */
  tints: { mint: Tint; rose: Tint; butter: Tint; sky: Tint; berry: Tint; peach: Tint };
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
      primary: [c.primary, c.primary],
      page: [c.bg, c.bg],
      header: [c.bg, c.bg],
      // The live call: one deep warm field, so the person's name and the timer carry the screen.
      call: isDark ? ['#100A08', '#100A08'] : ['#24130F', '#24130F'],
      tiles: {
        start: [c.success, c.success],
        lists: [c.surface, c.surface],
        callbacks: [c.surface, c.surface],
        reports: [c.surface, c.surface],
      },
    },
    /* People keep a stable pale tint of their own hue, at least 60 degrees apart round the wheel
       (coral, gold, green, teal, blue, berry); identity, never data, so they stay pale. */
    avatars: isDark
      ? [{ fg: '#F2A29B', bg: '#33191A' }, { fg: '#E8C27A', bg: '#2E2412' }, { fg: '#8FD3A6', bg: '#16291D' }, { fg: '#7CCFD6', bg: '#122A2C' }, { fg: '#A9C3F0', bg: '#172236' }, { fg: '#E6A6CB', bg: '#2E1A26' }]
      : [{ fg: '#A9302C', bg: '#FDE2DC' }, { fg: '#8A5A0B', bg: '#FCEBC6' }, { fg: '#23704A', bg: '#D7F2E1' }, { fg: '#0F6670', bg: '#D5F0F2' }, { fg: '#2457A6', bg: '#DFE9FB' }, { fg: '#8A3B6B', bg: '#F6DFEC' }],
    tints: isDark
      ? {
        mint: { bg: '#16301F', fg: '#8FE0AE' }, rose: { bg: '#3A1C1A', fg: '#FFADA3' }, butter: { bg: '#352A10', fg: '#F7D27A' },
        sky: { bg: '#172A45', fg: '#A9C8F7' }, berry: { bg: '#36192B', fg: '#F2AED3' }, peach: { bg: '#3A2314', fg: '#FFBE8F' },
      }
      : {
        mint: { bg: '#DDF5E6', fg: '#1C6B43' }, rose: { bg: '#FFE4DE', fg: '#A62F27' }, butter: { bg: '#FFF0C9', fg: '#7A5206' },
        sky: { bg: '#DDEBFF', fg: '#1F4F99' }, berry: { bg: '#F8E1EE', fg: '#83305F' }, peach: { bg: '#FFE6D1', fg: '#8F4310' },
      },
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

export type ThemePref = 'system' | 'light' | 'dark';

export const ThemeContext = createContext<Theme>(lightTheme);
export const useTheme = () => useContext(ThemeContext);

/**
 * How a surface lifts off the cream page: a soft warm shadow (level 1 cards, 2 tiles and the dock,
 * 3 things that float over content). On dark, where shadows vanish, a 1px edge does the work.
 */
export const elevation = (t: Theme, level: 1 | 2 | 3 = 1) => (t.dark
  ? { elevation: level === 3 ? 8 : 0, shadowColor: '#000000', borderWidth: 1, borderColor: t.c.border }
  : {
    elevation: level === 1 ? 2 : level === 2 ? 5 : 10,
    shadowColor: t.c.shadow,
    shadowOpacity: level === 1 ? 0.07 : level === 2 ? 0.1 : 0.16,
    shadowRadius: level === 1 ? 12 : 18,
    shadowOffset: { width: 0, height: level === 1 ? 4 : 8 },
  });
/** A coloured lift under the one primary action (a filled button, the centre call button). */
export const glow = (t: Theme) => ({
  elevation: 6,
  shadowColor: t.c.primary,
  shadowOpacity: 0.3,
  shadowRadius: 12,
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
