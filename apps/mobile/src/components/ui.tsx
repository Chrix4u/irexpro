import { useEffect, useRef, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
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


export function ActionDialog({
  visible,
  kicker,
  title,
  message,
  detailLines = [],
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  busy = false,
  danger = false,
  status,
}: {
  visible: boolean;
  kicker?: string;
  title: string;
  message: string;
  detailLines?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  danger?: boolean;
  status?: { tone: 'success' | 'error' | 'info'; message: string } | null;
}) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: 210,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, visible]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [18, 0],
  });
  const scale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.97, 1],
  });

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      statusBarTranslucent
      onRequestClose={busy ? undefined : onCancel}
    >
      <View style={styles.dialogBackdrop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close dialog"
          style={StyleSheet.absoluteFill}
          onPress={busy ? undefined : onCancel}
        />
        <Animated.View
          style={[
            styles.dialogPanel,
            {
              opacity: progress,
              transform: [{ translateY }, { scale }],
            },
          ]}
          accessibilityViewIsModal
        >
          <View style={[styles.dialogAccent, danger && styles.dialogAccentDanger]} />
          {kicker ? <Text style={styles.dialogKicker}>{kicker}</Text> : null}
          <Text style={styles.dialogTitle}>{title}</Text>
          <Text style={styles.dialogMessage}>{message}</Text>

          {detailLines.length > 0 ? (
            <View style={styles.dialogDetails}>
              {detailLines.map((line) => (
                <View key={line} style={styles.dialogDetailRow}>
                  <View style={styles.dialogDetailDot} />
                  <Text style={styles.dialogDetailText}>{line}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {status ? (
            <View
              style={[
                styles.dialogStatus,
                status.tone === 'success'
                  ? styles.dialogStatusSuccess
                  : status.tone === 'error'
                    ? styles.dialogStatusError
                    : styles.dialogStatusInfo,
              ]}
              accessibilityRole="alert"
            >
              <Text
                style={[
                  styles.dialogStatusText,
                  status.tone === 'success'
                    ? styles.dialogStatusTextSuccess
                    : status.tone === 'error'
                      ? styles.dialogStatusTextError
                      : styles.dialogStatusTextInfo,
                ]}
              >
                {status.message}
              </Text>
            </View>
          ) : null}

          <View style={styles.dialogActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
              onPress={onCancel}
              disabled={busy}
              style={[styles.dialogButton, styles.dialogCancel, busy && styles.dialogDisabled]}
            >
              <Text style={styles.dialogCancelText}>{cancelLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              onPress={onConfirm}
              disabled={busy}
              style={[
                styles.dialogButton,
                danger ? styles.dialogConfirmDanger : styles.dialogConfirm,
                busy && styles.dialogDisabled,
              ]}
            >
              {busy ? (
                <ActivityIndicator
                  size="small"
                  color={danger ? palette.danger.text : palette.accentText}
                />
              ) : (
                <Text
                  style={[
                    styles.dialogConfirmText,
                    danger && styles.dialogConfirmDangerText,
                  ]}
                >
                  {confirmLabel}
                </Text>
              )}
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Modal>
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
  dialogBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(2, 6, 23, 0.78)',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  dialogPanel: {
    overflow: 'hidden',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: palette.cardBorder,
    backgroundColor: '#10182a',
    padding: 18,
    shadowColor: '#000000',
    shadowOpacity: 0.32,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 16,
  },
  dialogAccent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: palette.accent,
  },
  dialogAccentDanger: { backgroundColor: '#ef4444' },
  dialogKicker: {
    color: palette.accent,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  dialogTitle: {
    color: palette.text,
    fontSize: 20,
    fontWeight: '900',
    marginBottom: 7,
  },
  dialogMessage: {
    color: palette.bodySoft,
    fontSize: 13,
    lineHeight: 20,
  },
  dialogDetails: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.cardBorder,
    backgroundColor: palette.input,
    padding: 11,
    marginTop: 14,
    gap: 9,
  },
  dialogDetailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
  },
  dialogDetailDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: palette.accent,
    marginTop: 6,
  },
  dialogDetailText: {
    flex: 1,
    color: palette.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  dialogStatus: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 10,
    marginTop: 13,
  },
  dialogStatusSuccess: {
    backgroundColor: palette.success.background,
    borderColor: palette.success.border,
  },
  dialogStatusError: {
    backgroundColor: palette.error.background,
    borderColor: palette.error.border,
  },
  dialogStatusInfo: {
    backgroundColor: palette.info.background,
    borderColor: palette.info.border,
  },
  dialogStatusText: { fontSize: 12, lineHeight: 18 },
  dialogStatusTextSuccess: { color: palette.success.text },
  dialogStatusTextError: { color: palette.error.text },
  dialogStatusTextInfo: { color: palette.info.text },
  dialogActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 18,
  },
  dialogButton: {
    flex: 1,
    minHeight: 46,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  dialogCancel: {
    backgroundColor: palette.secondaryButton,
    borderWidth: 1,
    borderColor: palette.inputBorder,
  },
  dialogConfirm: { backgroundColor: palette.accent },
  dialogConfirmDanger: {
    backgroundColor: palette.danger.background,
    borderWidth: 1,
    borderColor: '#b91c1c',
  },
  dialogDisabled: { opacity: 0.56 },
  dialogCancelText: { color: palette.body, fontSize: 13, fontWeight: '800' },
  dialogConfirmText: {
    color: palette.accentText,
    fontSize: 13,
    fontWeight: '900',
  },
  dialogConfirmDangerText: { color: palette.danger.text },
  skeletonBlock: {
    backgroundColor: palette.input,
    borderRadius: 8,
  },
});
