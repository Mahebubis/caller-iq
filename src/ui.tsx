import React, { createContext, memo, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  GestureResponderEvent,
  Modal,
  Pressable,
  PressableProps,
  ScrollView,
  StyleProp,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { makeStyles, radius, space, type, useTheme } from './theme';

/*
 * The building blocks every screen is made of, so a button, a card or a search box looks and
 * behaves the same everywhere.
 */

/* ── Icons ──────────────────────────────────────────────────────────────────
 * Material Icons (Round), shipped as app/src/main/assets/fonts/MaterialIconsRound.otf — React
 * Native picks up fonts from that folder by file name, so no native library is needed. Codepoints
 * come from Google's MaterialIconsRound-Regular.codepoints. */
const GLYPHS = {
  add: 0xe145,
  alarm: 0xe855,
  arrow_back: 0xe5c4,
  autorenew: 0xe863,
  block: 0xe14b,
  bolt: 0xea0b,
  call: 0xe0b0,
  call_made: 0xe0b2,
  call_missed: 0xe0b4,
  call_received: 0xe0b5,
  chat_bubble_outline: 0xe0cb,
  check: 0xe5ca,
  check_box: 0xe834,
  check_box_outline_blank: 0xe835,
  check_circle: 0xe86c,
  checklist: 0xe6b1,
  chevron_right: 0xe5cc,
  close: 0xe5cd,
  cloud_done: 0xe2bf,
  cloud_off: 0xe2c1,
  cloud_upload: 0xe2c3,
  contrast: 0xeb37,
  dark_mode: 0xe51c,
  delete_outline: 0xe92e,
  dns: 0xe875,
  drive_file_move: 0xe675,
  edit_note: 0xe745,
  error_outline: 0xe001,
  event: 0xe878,
  format_list_bulleted: 0xe241,
  groups: 0xf233,
  help_outline: 0xe8fd,
  history: 0xe889,
  inbox: 0xe156,
  info_outline: 0xe88f,
  insights: 0xf092,
  light_mode: 0xe518,
  lock: 0xe897,
  lock_open: 0xe898,
  notifications: 0xe7f4,
  notifications_active: 0xe7f7,
  open_in_new: 0xe89e,
  pause: 0xe034,
  person_outline: 0xe7ff,
  phone_callback: 0xe649,
  phone_disabled: 0xe9cc,
  phone_in_talk: 0xe61d,
  phone_missed: 0xe61f,
  play_arrow: 0xe037,
  refresh: 0xe5d5,
  restart_alt: 0xf053,
  schedule: 0xe8b5,
  search: 0xe8b6,
  select_all: 0xe162,
  sell: 0xf05b,
  settings: 0xe8b8,
  shopping_bag: 0xf1cc,
  sim_card: 0xe32b,
  skip_next: 0xe044,
  smartphone: 0xe32c,
  sms: 0xe625,
  snooze: 0xe046,
  sort: 0xe164,
  stop: 0xe047,
  sync_problem: 0xe629,
  task_alt: 0xe2e6,
  terminal: 0xeb8e,
  thumb_up: 0xe8dc,
  timer: 0xe425,
  tune: 0xe429,
  verified: 0xef76,
  visibility_off: 0xe8f5,
  warning_amber: 0xf083,
  wifi_off: 0xe648,
};
export type IconName = keyof typeof GLYPHS;

export const Icon = memo(({ name, size = 20, color, style }: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) => {
  const t = useTheme();
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      allowFontScaling={false}
      style={[
        {
          fontFamily: 'MaterialIconsRound',
          fontWeight: 'normal',
          fontSize: size,
          lineHeight: size,
          width: size,
          height: size,
          textAlign: 'center',
          includeFontPadding: false,
          color: color || t.c.textSoft,
        },
        style,
      ]}
    >
      {String.fromCharCode(GLYPHS[name])}
    </Text>
  );
});

/* ── Press guard ─────────────────────────────────────────────────────────────
 * A second tap while the first is still running (or within 600 ms) is ignored, so a nervous
 * double-tap never sends two requests or opens the dialer twice. */
export const useGuardedPress = (onPress?: () => any) => {
  const busy = useRef(false);
  return useCallback(() => {
    if (busy.current || !onPress) return;
    busy.current = true;
    let out: any;
    try { out = onPress(); } catch (e) { busy.current = false; throw e; }
    const release = () => setTimeout(() => { busy.current = false; }, 600);
    if (out && typeof out.then === 'function') out.then(release, release);
    else release();
  }, [onPress]);
};

/* ── Tactile press ───────────────────────────────────────────────────────────
 * Everything tappable squishes while held and springs back with a little overshoot when let go —
 * the same feel on every card, row, chip and button. Runs on the native driver; a short press
 * delay keeps a list from squishing the card under the finger when it is only being scrolled. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export const Tactile = ({ style, scaleTo = 0.96, onPressIn, onPressOut, children, ...rest }: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((pressed: boolean) => StyleProp<ViewStyle>);
  scaleTo?: number;
  children: React.ReactNode;
}) => {
  const scale = useRef(new Animated.Value(1)).current;
  const [pressed, setPressed] = useState(false);
  return (
    <AnimatedPressable
      unstable_pressDelay={40}
      {...rest}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        Animated.spring(scale, { toValue: scaleTo, speed: 50, bounciness: 0, useNativeDriver: true }).start();
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        Animated.spring(scale, { toValue: 1, speed: 14, bounciness: 12, useNativeDriver: true }).start();
        onPressOut?.(e);
      }}
      style={[typeof style === 'function' ? style(pressed) : style, { transform: [{ scale }] }]}
    >
      {children}
    </AnimatedPressable>
  );
};

/** A status dot with a soft ring that keeps radiating out of it — for "calling" and "syncing". */
export const PulseDot = ({ color, size = 7 }: { color: string; size?: number }) => {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1400, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [v]);
  const dot = { width: size, height: size, borderRadius: size / 2, backgroundColor: color };
  return (
    <View style={{ width: size, height: size }}>
      <Animated.View
        style={[dot, {
          position: 'absolute',
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
        }]}
      />
      <View style={dot} />
    </View>
  );
};

/**
 * Fades and lifts a list item in the first time it mounts, staggered down the first screenful.
 * Rows are keyed by id, so a refresh that changes nothing never re-plays it.
 */
export const Appear = ({ index = 0, children, style }: { index?: number; children: React.ReactNode; style?: StyleProp<ViewStyle> }) => {
  const animate = index < 10;
  const v = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (!animate) return;
    Animated.timing(v, { toValue: 1, duration: 340, delay: index * 45, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }] }]}>
      {children}
    </Animated.View>
  );
};

/* ── Buttons ── */

type Variant = 'primary' | 'success' | 'secondary' | 'soft' | 'ghost' | 'danger';

export const Button = ({
  label, onPress, variant = 'primary', size = 'md', icon, loading, disabled, pill, style, accessibilityLabel,
}: {
  label: string;
  onPress?: () => any;
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  /** Fully rounded ends, for the one main action of an empty or error state. */
  pill?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) => {
  const t = useTheme();
  const s = useStyles();
  const press = useGuardedPress(onPress);
  const filled = variant === 'primary' || variant === 'success' || variant === 'danger';
  const fg = variant === 'primary' ? t.c.onPrimary
    : variant === 'danger' || variant === 'success' ? '#FFFFFF'
    : variant === 'soft' || variant === 'ghost' ? t.c.link
    : t.c.textSoft;
  const off = disabled || loading;
  return (
    <Tactile
      onPress={press}
      disabled={off}
      unstable_pressDelay={0}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      hitSlop={size === 'sm' ? 6 : 0}
      android_ripple={{ color: filled ? 'rgba(255,255,255,0.18)' : t.c.ripple }}
      style={(pressed) => [
        s.btn,
        size === 'sm' ? s.btnSm : size === 'lg' ? s.btnLg : s.btnMd,
        pill && { borderRadius: radius.pill },
        variant === 'primary' && { backgroundColor: pressed ? t.c.primaryPressed : t.c.primary },
        variant === 'success' && { backgroundColor: t.c.emerald },
        variant === 'danger' && { backgroundColor: t.c.coral },
        variant === 'secondary' && s.btnSecondary,
        variant === 'soft' && { backgroundColor: t.c.primarySoft },
        off && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <>
          {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} color={fg} />}
          <Text style={[s.btnText, size === 'sm' && s.btnTextSm, filled && s.btnTextFilled, { color: fg }]} numberOfLines={1}>{label}</Text>
        </>
      )}
    </Tactile>
  );
};

export const IconButton = ({
  icon, onPress, label, size = 40, color, tone = 'plain', badge, disabled,
}: {
  icon: IconName;
  onPress?: () => any;
  label: string;           // read out by TalkBack
  size?: number;
  color?: string;
  tone?: 'plain' | 'outlined' | 'soft';
  badge?: number;
  disabled?: boolean;
}) => {
  const t = useTheme();
  const s = useStyles();
  const press = useGuardedPress(onPress);
  return (
    <Tactile
      onPress={press}
      disabled={disabled}
      scaleTo={0.88}
      unstable_pressDelay={0}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={Math.max(0, (48 - size) / 2)}
      android_ripple={{ color: t.c.ripple, borderless: true, radius: size / 2 + 4 }}
      style={[
        { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' },
        tone === 'outlined' && { borderWidth: 1, borderColor: t.c.border, backgroundColor: t.c.surface },
        tone === 'soft' && { backgroundColor: t.c.primarySoft },
        disabled && { opacity: 0.4 },
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.52)} color={color || (tone === 'soft' ? t.c.link : t.c.textSoft)} />
      {!!badge && badge > 0 && (
        <View style={s.badge}><Text style={s.badgeText}>{badge > 99 ? '99+' : badge}</Text></View>
      )}
    </Tactile>
  );
};

/* ── Surfaces ── */

export const Card = ({ children, style, onPress, accessibilityLabel }: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) => {
  const t = useTheme();
  const s = useStyles();
  if (!onPress) return <View style={[s.card, style]}>{children}</View>;
  return (
    <Tactile
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      android_ripple={{ color: t.c.ripple }}
      style={[s.card, style]}
    >
      {children}
    </Tactile>
  );
};

/** A capsule status badge. `pulse` makes its dot breathe, for something happening right now. */
export const Pill = ({ label, fg, bg, icon, dot, pulse, dotColor }: {
  label: string;
  fg: string;
  bg: string;
  icon?: IconName;
  dot?: boolean;
  pulse?: boolean;
  dotColor?: string;
}) => {
  const s = useStyles();
  return (
    <View style={[s.pill, { backgroundColor: bg }]}>
      {pulse ? <PulseDot color={dotColor || fg} size={6} /> : dot && <View style={[s.pillDot, { backgroundColor: dotColor || fg }]} />}
      {icon && <Icon name={icon} size={13} color={fg} />}
      <Text style={[s.pillText, { color: fg }]} numberOfLines={1}>{label}</Text>
    </View>
  );
};

/**
 * One tile of a bento metric strip: a tinted icon badge, a big tabular number and its label.
 * An optional action ("Upload now") sits where the caption would be.
 */
export const MetricTile = ({ icon, label, value, fg, bg, sub, action, onAction, pulse, style }: {
  icon: IconName;
  label: string;
  value: string;
  fg: string;
  bg: string;
  sub?: string;
  action?: string;
  onAction?: () => void;
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
}) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={[s.metric, style]} accessible={!action} accessibilityLabel={`${label}: ${value}`}>
      <View style={s.metricTop}>
        <View style={[s.metricIcon, { backgroundColor: bg }]}><Icon name={icon} size={18} color={fg} /></View>
        {pulse && <PulseDot color={fg} />}
      </View>
      <Text style={[s.metricValue, value === '—' && { color: t.c.faint }]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
      <Text style={s.metricLabel} numberOfLines={1}>{label}</Text>
      {action ? (
        <Pressable onPress={onAction} disabled={!onAction} hitSlop={10} accessibilityRole="button">
          <Text style={[s.metricSub, { color: t.c.link, fontWeight: '700' }]}>{action}</Text>
        </Pressable>
      ) : (
        !!sub && <Text style={s.metricSub} numberOfLines={1}>{sub}</Text>
      )}
    </View>
  );
};

/** "Attempts 1/3" — how many times we have rung this contact back; solid red once it hits the limit. */
export const AttemptBadge = ({ n, max }: { n: number; max: number }) => {
  const t = useTheme();
  const maxed = n >= max;
  return (
    <Pill
      label={maxed ? `Max attempts ${n}/${max}` : `Attempts ${n}/${max}`}
      icon={maxed ? 'block' : 'call_made'}
      fg={maxed ? '#FFFFFF' : n > 0 ? t.c.warning : t.c.muted}
      bg={maxed ? t.c.coral : n > 0 ? t.c.warningSoft : t.c.surfaceAlt}
    />
  );
};

/** The #1, #2… column: an item's position in the list as it is filtered and sorted right now. */
export const IndexBadge = memo(({ n, style }: { n: number; style?: StyleProp<ViewStyle> }) => {
  const s = useStyles();
  return (
    <View style={[s.index, style]} accessibilityLabel={`Number ${n}`}>
      <Text style={s.indexText} numberOfLines={1} adjustsFontSizeToFit>#{n}</Text>
    </View>
  );
});

export const SectionHeader = ({ title, action, onAction, style }: { title: string; action?: string; onAction?: () => void; style?: StyleProp<ViewStyle> }) => {
  const s = useStyles();
  return (
    <View style={[s.sectionHead, style]}>
      <Text style={s.sectionTitle} accessibilityRole="header">{title}</Text>
      {!!action && (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button">
          <Text style={s.sectionAction}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
};

/* ── Inputs ── */

export const SearchField = ({ value, onChangeText, placeholder, style }: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  style?: StyleProp<ViewStyle>;
}) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={[s.search, style]}>
      <Icon name="search" size={20} color={t.c.faint} />
      <TextInput
        style={s.searchInput}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={t.c.faint}
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={placeholder}
      />
      {!!value && <IconButton icon="close" size={32} label="Clear search" onPress={() => onChangeText('')} color={t.c.muted} />}
    </View>
  );
};

export const Field = ({ label, hint, error, style, ...input }: React.ComponentProps<typeof TextInput> & { label: string; hint?: string; error?: string }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={{ marginTop: space.md }}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={t.c.faint}
        accessibilityLabel={label}
        {...input}
        style={[s.input, input.multiline && { minHeight: 84, textAlignVertical: 'top' }, !!error && { borderColor: t.c.danger }, style]}
      />
      {!!error && <Text style={[s.fieldHint, { color: t.c.danger }]}>{error}</Text>}
      {!error && !!hint && <Text style={s.fieldHint}>{hint}</Text>}
    </View>
  );
};

export const Chip = memo(({ label, count, selected, onPress, icon }: { label: string; count?: number | null; selected?: boolean; onPress?: () => void; icon?: IconName }) => {
  const t = useTheme();
  const s = useStyles();
  return (
    <Tactile
      onPress={onPress}
      scaleTo={0.93}
      unstable_pressDelay={0}
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      style={[s.chip, selected && s.chipOn]}
    >
      {icon && <Icon name={icon} size={16} color={selected ? t.c.link : t.c.muted} />}
      <Text style={[s.chipText, selected && { color: t.c.link }]}>{label}</Text>
      {count != null && (
        <View style={[s.chipCount, selected && { backgroundColor: t.c.primary }]}>
          <Text style={[s.chipCountText, selected && { color: t.c.onPrimary }]}>{count > 9999 ? '9999+' : count}</Text>
        </View>
      )}
    </Tactile>
  );
});

export const ChipBar = ({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) => {
  const s = useStyles();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipBar} style={style} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
};

export function Segmented<K extends string>({ options, value, onChange, style }: {
  options: ReadonlyArray<{ key: K; label: string; icon?: IconName }>;
  value: K;
  onChange: (k: K) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const s = useStyles();
  return (
    <View style={[s.segment, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[s.segBtn, on && s.segOn]}
          >
            {o.icon && <Icon name={o.icon} size={16} color={on ? t.c.link : t.c.muted} />}
            <Text style={[s.segText, on && { color: t.c.link, fontWeight: '700' }]} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ── States ── */

export const EmptyState = ({ icon, title, body, actionLabel, actionIcon, onAction, tone = 'primary' }: {
  icon: IconName;
  title: string;
  body?: string;
  actionLabel?: string;
  actionIcon?: IconName;
  onAction?: () => void;
  tone?: 'primary' | 'success' | 'danger';
}) => {
  const t = useTheme();
  const s = useStyles();
  const fg = tone === 'success' ? t.c.success : tone === 'danger' ? t.c.danger : t.c.link;
  const bg = tone === 'success' ? t.c.successSoft : tone === 'danger' ? t.c.dangerSoft : t.c.primarySoft;
  return (
    <Appear style={s.empty}>
      <View style={[s.emptyIcon, { backgroundColor: bg }]}>
        <Icon name={icon} size={30} color={fg} />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      {!!body && <Text style={s.emptyBody}>{body}</Text>}
      {!!actionLabel && (
        <Button
          label={actionLabel}
          icon={actionIcon}
          pill
          variant={tone === 'success' ? 'secondary' : 'primary'}
          onPress={onAction}
          style={{ marginTop: space.xl, minWidth: 160 }}
        />
      )}
    </Appear>
  );
};

type Tone = 'danger' | 'warning' | 'info' | 'primary';

export const Banner = ({ tone, icon, title, message, actionLabel, onAction, actionBusy }: {
  tone: Tone;
  icon: IconName;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => any;
  actionBusy?: boolean;
}) => {
  const t = useTheme();
  const s = useStyles();
  const fg = tone === 'danger' ? t.c.danger : tone === 'warning' ? t.c.warning : tone === 'info' ? t.c.info : t.c.link;
  const bg = tone === 'danger' ? t.c.dangerSoft : tone === 'warning' ? t.c.warningSoft : tone === 'info' ? t.c.infoSoft : t.c.primarySoft;
  return (
    <View style={[s.banner, { backgroundColor: bg }]} accessibilityRole="alert">
      <Icon name={icon} size={20} color={fg} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        {!!title && <Text style={[s.bannerTitle, { color: fg }]}>{title}</Text>}
        <Text style={s.bannerText}>{message}</Text>
      </View>
      {!!actionLabel && (
        <Pressable
          onPress={onAction}
          disabled={actionBusy}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [s.bannerBtn, { borderColor: fg }, (pressed || actionBusy) && { opacity: 0.6 }]}
        >
          {actionBusy ? <ActivityIndicator size="small" color={fg} /> : <Text style={[s.bannerBtnText, { color: fg }]}>{actionLabel}</Text>}
        </Pressable>
      )}
    </View>
  );
};

/** A grey block with a light band sweeping across it while the real content loads. One shared animation drives them all. */
const shimmer = new Animated.Value(0);
let shimmerUsers = 0;
let shimmerLoop: Animated.CompositeAnimation | null = null;
const BAND = 90;
const sweep = shimmer.interpolate({ inputRange: [0, 1], outputRange: [-BAND, Dimensions.get('window').width] });

export const Skeleton = ({ width = '100%', height = 14, r = 6, style }: { width?: number | `${number}%`; height?: number; r?: number; style?: StyleProp<ViewStyle> }) => {
  const t = useTheme();
  useEffect(() => {
    shimmerUsers++;
    if (!shimmerLoop) {
      shimmer.setValue(0);
      shimmerLoop = Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 1300, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
      shimmerLoop.start();
    }
    return () => {
      shimmerUsers--;
      if (!shimmerUsers && shimmerLoop) { shimmerLoop.stop(); shimmerLoop = null; }
    };
  }, []);
  return (
    <View style={[{ width, height, borderRadius: r, backgroundColor: t.c.skeleton, overflow: 'hidden' }, style]}>
      <Animated.View
        style={{ position: 'absolute', top: 0, bottom: 0, width: BAND, backgroundColor: t.c.shimmer, transform: [{ translateX: sweep }, { skewX: '-18deg' }] }}
      />
    </View>
  );
};

export const SkeletonCard = ({ lines = 3 }: { lines?: number }) => {
  const s = useStyles();
  return (
    <View style={[s.card, { gap: 10 }]}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <Skeleton width={44} height={44} r={12} />
        <View style={{ flex: 1, gap: 8 }}>
          <Skeleton width="60%" height={14} />
          <Skeleton width="40%" height={11} />
        </View>
      </View>
      {Array.from({ length: Math.max(0, lines - 1) }).map((_, i) => <Skeleton key={i} width={i % 2 ? '70%' : '100%'} height={10} />)}
    </View>
  );
};

export const ProgressBar = ({ value, color }: { value: number; color?: string }) => {
  const t = useTheme();
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: t.c.divider, overflow: 'hidden' }}>
      <View style={{ height: 6, borderRadius: 3, width: `${pct}%`, backgroundColor: color || t.c.primary }} />
    </View>
  );
};

/* ── Bottom sheet ── */

export const Sheet = ({ visible, onClose, title, subtitle, children, footer, scroll = true }: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  scroll?: boolean;
}) => {
  const s = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.scrim}>
        <Pressable style={{ flex: 1 }} onPress={onClose} accessibilityLabel="Close" accessibilityRole="button" />
        <View style={s.sheet}>
          <View style={s.grabber} />
          <View style={s.sheetHead}>
            <View style={{ flex: 1 }}>
              <Text style={s.sheetTitle} accessibilityRole="header">{title}</Text>
              {!!subtitle && <Text style={s.sheetSub}>{subtitle}</Text>}
            </View>
            <IconButton icon="close" label="Close" size={36} onPress={onClose} tone="outlined" />
          </View>
          {scroll ? (
            <ScrollView style={{ flexGrow: 0 }} contentContainerStyle={{ paddingBottom: space.sm }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              {children}
            </ScrollView>
          ) : children}
          {footer}
        </View>
      </View>
    </Modal>
  );
};

/** A row inside a sheet: title, description, and a control on the right (switch, button…). */
export const SettingRow = ({ icon, title, desc, right, onPress }: {
  icon?: IconName;
  title: string;
  desc?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) => {
  const t = useTheme();
  const s = useStyles();
  const body = (
    <>
      {icon && <View style={s.rowIcon}><Icon name={icon} size={20} color={t.c.link} /></View>}
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle}>{title}</Text>
        {!!desc && <Text style={s.rowDesc}>{desc}</Text>}
      </View>
      {right}
    </>
  );
  if (!onPress) return <View style={s.settingRow}>{body}</View>;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [s.settingRow, pressed && { opacity: 0.85 }]}>
      {body}
    </Pressable>
  );
};

/* ── Toasts ── */

const ToastContext = createContext<(msg: string, tone?: 'default' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export const ToastProvider = ({ children }: { children: React.ReactNode }) => {
  const t = useTheme();
  const s = useStyles();
  const [toast, setToast] = useState<{ msg: string; tone: 'default' | 'error'; id: number } | null>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const show = useCallback((msg: string, tone: 'default' | 'error' = 'default') => {
    setToast({ msg, tone, id: Date.now() });
    anim.stopAnimation();
    anim.setValue(0);
    Animated.sequence([
      Animated.timing(anim, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(2600),
      Animated.timing(anim, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) setToast(null); });
  }, [anim]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          pointerEvents="none"
          accessibilityLiveRegion="polite"
          style={[s.toast, { opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}
        >
          <Icon name={toast.tone === 'error' ? 'error_outline' : 'check_circle'} size={18} color={toast.tone === 'error' ? t.c.danger : t.c.success} />
          <Text style={s.toastText} numberOfLines={3}>{toast.msg}</Text>
        </Animated.View>
      )}
    </ToastContext.Provider>
  );
};

/* ── styles ── */

const useStyles = makeStyles((t) => ({
  btn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radius.md, overflow: 'hidden' },
  btnSm: { minHeight: 36, paddingHorizontal: 14 },
  btnMd: { minHeight: 44, paddingHorizontal: 18 },
  btnLg: { minHeight: 52, paddingHorizontal: 22 },
  btnSecondary: { backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.borderStrong },
  btnText: { fontSize: 14.5, fontWeight: '600' },
  btnTextSm: { fontSize: 13 },
  btnTextFilled: { fontWeight: '700' },

  badge: {
    position: 'absolute', top: 2, right: 0, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: t.c.danger, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.c.surface,
  },
  badgeText: { color: '#FFFFFF', fontSize: 9.5, fontWeight: '700' },

  card: {
    backgroundColor: t.c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: t.c.border,
    padding: space.lg, marginBottom: space.md,
  },

  metric: { flex: 1, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border, borderRadius: radius.lg, padding: 12 },
  metricTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  metricIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  metricValue: { ...type.metric, color: t.c.text, marginTop: 12 },
  metricLabel: { fontSize: 12, fontWeight: '600', color: t.c.muted, marginTop: 1 },
  metricSub: { fontSize: 11.5, color: t.c.faint, marginTop: 2 },

  index: { minWidth: 34, height: 22, paddingHorizontal: 6, borderRadius: 7, backgroundColor: t.c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  indexText: { fontSize: 11.5, fontWeight: '800', color: t.c.textSoft, fontVariant: ['tabular-nums'] },

  pill: { flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 4, alignSelf: 'flex-start', maxWidth: '100%' },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 11.5, fontWeight: '700', flexShrink: 1 },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space.sm, marginBottom: space.sm + 2 },
  sectionTitle: { ...type.overline, color: t.c.muted },
  sectionAction: { fontSize: 13, fontWeight: '600', color: t.c.link },

  search: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border,
    borderRadius: radius.pill, paddingLeft: 14, paddingRight: 4, height: 46, marginBottom: space.md,
  },
  searchInput: { flex: 1, fontSize: 14.5, color: t.c.text, paddingVertical: 0 },

  fieldLabel: { ...type.label, color: t.c.textSoft, marginBottom: 6 },
  fieldHint: { fontSize: 12, color: t.c.muted, marginTop: 6, lineHeight: 17 },
  input: {
    borderWidth: 1, borderColor: t.c.border, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 14.5, color: t.c.text, backgroundColor: t.c.surfaceAlt,
  },

  chipBar: { gap: 8, paddingBottom: space.md, paddingRight: space.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: t.c.border, backgroundColor: t.c.surface,
    borderRadius: radius.pill, paddingLeft: 12, paddingRight: 8, minHeight: 36,
  },
  chipOn: { borderColor: t.c.primaryLine, backgroundColor: t.c.primarySoft },
  chipText: { fontSize: 13, color: t.c.textSoft, fontWeight: '600', paddingRight: 4 },
  chipCount: { minWidth: 22, height: 20, borderRadius: 10, paddingHorizontal: 6, backgroundColor: t.c.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  chipCountText: { fontSize: 11.5, fontWeight: '700', color: t.c.textSoft },

  segment: { flexDirection: 'row', backgroundColor: t.c.surfaceAlt, borderRadius: radius.md, padding: 3, marginBottom: space.md },
  segBtn: { flex: 1, flexDirection: 'row', gap: 6, minHeight: 38, borderRadius: radius.sm + 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, borderWidth: 1, borderColor: 'transparent' },
  segOn: { backgroundColor: t.c.surface, borderColor: t.c.border },
  segText: { fontSize: 13, fontWeight: '600', color: t.c.muted },

  empty: { alignItems: 'center', paddingVertical: 44, paddingHorizontal: 28 },
  emptyIcon: { width: 72, height: 72, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
  emptyTitle: { ...type.heading, color: t.c.text, textAlign: 'center' },
  emptyBody: { ...type.caption, color: t.c.muted, textAlign: 'center', marginTop: 6, maxWidth: 320 },

  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderRadius: radius.md, padding: 14, marginBottom: space.md },
  bannerTitle: { fontSize: 14, fontWeight: '700', marginBottom: 2 },
  bannerText: { fontSize: 12.5, color: t.c.textSoft, lineHeight: 18 },
  bannerBtn: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 12, minHeight: 32, justifyContent: 'center', alignSelf: 'center' },
  bannerBtnText: { fontSize: 12.5, fontWeight: '700' },

  scrim: { flex: 1, backgroundColor: t.c.scrim, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: t.c.surface, borderTopLeftRadius: radius.xl + 4, borderTopRightRadius: radius.xl + 4,
    paddingHorizontal: space.xl, paddingBottom: space.xxl, maxHeight: '92%',
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: t.c.borderStrong, marginTop: 10, marginBottom: 12 },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: space.lg },
  sheetTitle: { ...type.title, color: t.c.text },
  sheetSub: { ...type.caption, color: t.c.muted, marginTop: 3 },

  settingRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.c.surface, borderWidth: 1, borderColor: t.c.border,
    borderRadius: radius.md, padding: 14, marginBottom: space.sm,
  },
  rowIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: t.c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 14, fontWeight: '600', color: t.c.text },
  rowDesc: { fontSize: 12.5, color: t.c.muted, marginTop: 2, lineHeight: 18 },

  toast: {
    position: 'absolute', left: space.xl, right: space.xl, bottom: 84, flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: t.c.toastBg, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 16, elevation: 8,
    shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
  },
  toastText: { flex: 1, color: t.c.toastText, fontSize: 13.5, fontWeight: '500' },
}));
