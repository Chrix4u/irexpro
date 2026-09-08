import { useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

/**
 * Shared UI building blocks for the mobile app.
 *
 * Each component is styled EXACTLY like the per-screen inline versions it
 * replaces (dark theme, inline hex tokens from the established palette).
 * New screens import these instead of re-declaring the same StyleSheet
 * entries; the exported `palette` const keeps new styles on-token.
 */

/** Canonical dark-theme hex tokens used across the app. */
export const palette = {
  bg: '#0b1020',
  card: '#131a2e',
  input: '#0d1426',
  cardBorder: '#243049',
  inputBorder: '#33415f',
  accent: '#14b8a6',
  accentText: '#041713',
  text: '#e8edff',
  body: '#cbd5e1',
  bodySoft: '#b9c3dd',
  muted: '#9aa7c7',
  dim: '#6b7494',
  helper: '#74809e',
  placeholder: '#65708d',
  inputText: '#f1f5f9',
  secondaryButton: '#18233b',
  errorText: '#f87171',
  error: { background: '#2a1714', border: '#7c2d12', text: '#fed7aa' },
  success: { background: '#0d2928', border: '#115e59', text: '#99f6e4' },
  info: { background: '#131a2e', border: '#33415f', text: '#cbd5e1' },
  danger: { background: '#3b171c', border: '#7f1d1d', text: '#fecaca' },
  warningText: '#fcd34d',
  pill: {
    positive: { background: '#0d2928', border: '#115e59', text: '#5eead4' },
    neutral: { background: '#26202d', border: '#51405e', text: '#c4b5fd' },
    warning: { background: '#291f0b', border: '#854d0e', text: '#fde68a' },
    danger: { background: '#3b171c', border: '#7f1d1d', text: '#fecaca' },
  },
} as const;

/** Visual tone for StatusPill. */
export type PillTone = 'positive' | 'neutral' | 'warning' | 'danger';

/** Banner variant. */
export type BannerVariant = 'error' | 'success' | 'info';

/** Rounded card container (identical to the per-screen card style). */
export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

/**
 * Card header: bold title, optional muted description, and an optional
 * right-aligned slot (e.g. a StatusPill).
 */
export function SectionHeader({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeadingCopy}>
        <Text style={styles.cardTitle}>{title}</Text>
        {description ? <Text style={styles.muted}>{description}</Text> : null}
      </View>
      {right ?? null}
    </View>
  );
}

/** Primary / secondary / danger action button with busy label swap. */
export function ActionButton({
  label,
  busyLabel,
  busy = false,
  onPress,
  disabled = false,
  secondary = false,
  danger = false,
}: {
  label: string;
  /** Label shown while `busy` is true (defaults to `label`). */
  busyLabel?: string;
  busy?: boolean;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
}) {
  const effectiveDisabled = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: effectiveDisabled, busy }}
      style={[
        styles.button,
        secondary && styles.buttonSecondary,
        danger && styles.buttonDanger,
        effectiveDisabled && styles.buttonDisabled,
      ]}
      onPress={onPress}
      disabled={effectiveDisabled}
    >
      <Text
        style={[
          styles.buttonText,
          secondary && styles.buttonTextSecondary,
          danger && styles.buttonTextDanger,
        ]}
      >
        {busy ? (busyLabel ?? label) : label}
      </Text>
    </Pressable>
  );
}

/** Full-width hairline separator between card rows. */
export function Divider() {
  return <View style={styles.divider} />;
}

/**
 * Labeled text input (label + accessibilityLabel + placeholderTextColor),
 * with optional field-level error copy, secure-text reveal toggle, and
 * TextInput prop passthrough (keyboardType / autoComplete /
 * textContentType) for password-manager friendliness.
 */
export function LabeledInput({
  label,
  error,
  secureTextEntry,
  ...props
}: {
  label: string;
  /** Field-level validation copy rendered under the input. */
  error?: string | null;
} & ComponentProps<typeof TextInput>) {
  const [revealed, setRevealed] = useState(false);
  const hidden = secureTextEntry === true && !revealed;

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={palette.placeholder}
          style={[styles.input, styles.inputFlexible]}
          secureTextEntry={hidden}
          {...props}
        />
        {secureTextEntry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${label}` : `Show ${label}`}
            onPress={() => setRevealed((current) => !current)}
            style={styles.revealToggle}
          >
            <Text style={styles.revealToggleText}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
      {error ? <Text style={styles.fieldErrorText}>{error}</Text> : null}
    </View>
  );
}

/**
 * Status pill. The display label is derived from the status string by
 * replacing underscores with spaces; the tone picks the color family.
 */
export function StatusPill({ status, tone = 'neutral' }: { status: string; tone?: PillTone }) {
  const label = String(status).replaceAll('_', ' ');
  const colors = palette.pill[tone];
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
      accessibilityLabel={`${label} status`}
    >
      <Text style={[styles.pillText, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

/** Inline alert banner (error / success / info) — always an `alert` role. */
export function Banner({
  variant,
  children,
}: {
  variant: BannerVariant;
  children: ReactNode;
}) {
  const colors =
    variant === 'error'
      ? palette.error
      : variant === 'success'
        ? palette.success
        : palette.info;
  const liveRegion = variant === 'error' ? 'assertive' : 'polite';
  return (
    <View
      style={[
        styles.banner,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
      accessibilityRole="alert"
      accessibilityLiveRegion={liveRegion}
    >
      <Text style={[styles.bannerText, { color: colors.text }]}>{children}</Text>
    </View>
  );
}

/**
 * Animation-free loading placeholder block. Compose inside `Card`s to
 * skeleton out a screen while data loads.
 */
export function SkeletonBlock({
  height = 16,
  style,
}: {
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.skeletonBlock, { height }, style]} />;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.card,
    borderColor: palette.cardBorder,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 14,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  sectionHeadingCopy: { flex: 1 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: palette.text, marginBottom: 5 },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  button: {
    minHeight: 46,
    backgroundColor: palette.accent,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 13,
  },
  buttonSecondary: {
    backgroundColor: palette.secondaryButton,
    borderWidth: 1,
    borderColor: palette.inputBorder,
  },
  buttonDanger: {
    backgroundColor: palette.danger.background,
    borderWidth: 1,
    borderColor: palette.danger.border,
  },
  buttonDisabled: { opacity: 0.52 },
  buttonText: { color: palette.accentText, fontWeight: '800', fontSize: 14 },
  buttonTextSecondary: { color: palette.body },
  buttonTextDanger: { color: palette.danger.text },
  field: { marginTop: 13 },
  fieldLabel: { color: palette.body, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  fieldErrorText: {
    color: palette.errorText,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
  },
  inputRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  inputFlexible: { flex: 1 },
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: palette.inputBorder,
    backgroundColor: palette.input,
    color: palette.inputText,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  revealToggle: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: palette.inputBorder,
    backgroundColor: palette.secondaryButton,
    borderRadius: 10,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  revealToggleText: { color: palette.body, fontSize: 13, fontWeight: '700' },
  pill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  banner: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    marginBottom: 12,
  },
  bannerText: { fontSize: 13, lineHeight: 19 },
  divider: { height: 1, backgroundColor: palette.cardBorder, marginTop: 16 },
  skeletonBlock: {
    backgroundColor: palette.input,
    borderRadius: 8,
  },
});
