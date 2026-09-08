import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ApiClientError } from '@irexpro/api-client';
import type { MyProfileView } from '@irexpro/types';
import {
  ActionButton,
  Banner,
  Card,
  LabeledInput,
  SkeletonBlock,
  StatusPill,
  palette,
} from '@/components/ui';
import { api } from '@/lib/api';
import { accountSecurityError } from '@/lib/account-security';
import {
  PROFILE_EXPERIENCE_OPTIONS,
  buildUpdateMyProfileRequest,
  isProfileDirty,
  isValidTradingExperienceLevel,
  profileFieldErrors,
  toProfileFieldValues,
  verificationBadges,
} from '@/lib/account-security-logic';
import type { ProfileFieldKey, ProfileFieldValues } from '@/lib/account-security-logic';

type LoadPhase = 'loading' | 'error' | 'ready';

/**
 * Personal Information sub-screen of the Account hub (Sprint 55 Phase F).
 *
 * Production-grade profile editing against the typed GET/PATCH /users/me
 * contract (MyProfileView / UpdateMyProfileRequest):
 * - profile loads into a skeleton state, with an error banner + retry on
 *   network/5xx failures;
 * - every field is validated live through the RN-free pure module, and the
 *   save button stays disabled while anything is invalid, unchanged, or busy;
 * - email/phone are read-only (no server change flow exists) and are shown
 *   exactly as stored, with verification state derived from server data;
 * - error copy always goes through the sanitized accountSecurityError mapper
 *   — raw server messages are never reflected. 401s are treated exactly like
 *   the former AccountScreen: a sanitized banner with a retry path (the
 *   auth-context owns 401-on-me session recovery);
 * - leaving with unsaved changes asks for confirmation via RN Alert.
 */
export default function PersonalInformationScreen({
  onBack,
  refreshIdentity,
}: {
  onBack: () => void;
  refreshIdentity: () => Promise<void>;
}) {
  const [view, setView] = useState<MyProfileView | null>(null);
  const [values, setValues] = useState<ProfileFieldValues | null>(null);
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saveFailedNetwork, setSaveFailedNetwork] = useState(false);

  const cancelledRef = useRef(false);

  const loadProfile = useCallback(async () => {
    setPhase('loading');
    setLoadError(null);
    try {
      const response = await api.getMyProfile();
      if (cancelledRef.current) return;
      setView(response);
      setValues(toProfileFieldValues(response));
      setPhase('ready');
    } catch (error) {
      if (cancelledRef.current) return;
      setLoadError(accountSecurityError(error));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    void loadProfile();
    return () => {
      cancelledRef.current = true;
    };
  }, [loadProfile]);

  const retryLoad = useCallback(() => {
    void loadProfile();
  }, [loadProfile]);

  function setFieldValue(field: ProfileFieldKey, value: string): void {
    setNotice(null);
    setValues((current) => {
      if (!current) return current;
      const next: ProfileFieldValues = { ...current };
      if (field === 'tradingExperienceLevel') {
        next.tradingExperienceLevel = isValidTradingExperienceLevel(value) ? value : '';
      } else {
        next[field] = value;
      }
      return next;
    });
  }

  const errors = values ? profileFieldErrors(values) : {};
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = view !== null && values !== null && isProfileDirty(view, values);
  const badges = view ? verificationBadges(view) : { email: false, phone: false };
  const showDobKycWarning =
    view !== null &&
    values !== null &&
    view.profile.dateOfBirth !== null &&
    values.dateOfBirth.trim() !== view.profile.dateOfBirth;

  async function handleSave(): Promise<void> {
    if (!view || !values || saving) return;

    // Validation runs live on every change; re-check on submit as a guard.
    const submitErrors = profileFieldErrors(values);
    if (Object.keys(submitErrors).length > 0) {
      setActionError('Check the highlighted fields and try again.');
      return;
    }
    if (!isProfileDirty(view, values)) return;

    setSaving(true);
    setNotice(null);
    setActionError(null);
    setSaveFailedNetwork(false);
    try {
      const response = await api.updateMyProfile(buildUpdateMyProfileRequest(view, values));
      setView(response);
      setValues(toProfileFieldValues(response));
      await refreshIdentity();
      setNotice('Profile updated successfully.');
    } catch (error) {
      setActionError(accountSecurityError(error));
      setSaveFailedNetwork(
        error instanceof ApiClientError && (error.statusCode === 0 || error.statusCode >= 500),
      );
    } finally {
      setSaving(false);
    }
  }

  function requestBack(): void {
    if (saving) return;
    if (dirty) {
      Alert.alert(
        'Discard changes?',
        'Your unsaved profile changes will be lost.',
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Discard changes', style: 'destructive', onPress: onBack },
        ],
        { cancelable: true },
      );
      return;
    }
    onBack();
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        accessibilityLabel="Personal information"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to account"
          onPress={requestBack}
          style={styles.backButton}
          disabled={saving}
        >
          <Text style={styles.backButtonText}>‹ Account</Text>
        </Pressable>

        <View style={styles.titleRow}>
          <Text style={styles.title}>Personal Information</Text>
          {dirty ? <StatusPill status="Unsaved changes" tone="warning" /> : null}
        </View>
        <Text style={styles.subtitle}>
          Your legal identity and regional preferences. Changes are validated on this device before
          they are sent to the server.
        </Text>

        {phase === 'loading' ? (
          <>
            <Card>
              <SkeletonBlock height={16} style={{ width: 140 }} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
            </Card>
            <Card>
              <SkeletonBlock height={16} style={{ width: 180 }} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
              <SkeletonBlock height={46} style={styles.skeletonGap} />
            </Card>
          </>
        ) : null}

        {phase === 'error' && loadError ? (
          <>
            <Banner variant="error">{loadError}</Banner>
            <ActionButton label="Retry loading profile" onPress={retryLoad} />
          </>
        ) : null}

        {phase === 'ready' && view && values ? (
          <>
            {actionError ? <Banner variant="error">{actionError}</Banner> : null}
            {notice ? <Banner variant="success">{notice}</Banner> : null}

            <Card>
              <Text style={styles.cardTitle}>Personal details</Text>
              <LabeledInput
                label="First name"
                value={values.firstName}
                onChangeText={(value) => setFieldValue('firstName', value)}
                autoCapitalize="words"
                maxLength={100}
                textContentType="givenName"
                editable={!saving}
                error={errors.firstName ?? null}
              />
              <LabeledInput
                label="Last name"
                value={values.lastName}
                onChangeText={(value) => setFieldValue('lastName', value)}
                autoCapitalize="words"
                maxLength={100}
                textContentType="familyName"
                editable={!saving}
                error={errors.lastName ?? null}
              />
              <LabeledInput
                label="Date of birth"
                value={values.dateOfBirth}
                onChangeText={(value) => setFieldValue('dateOfBirth', value)}
                placeholder="YYYY-MM-DD"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                autoCorrect={false}
                editable={!saving}
                error={errors.dateOfBirth ?? null}
              />
              {showDobKycWarning ? (
                <Text style={styles.warningText}>
                  Changing your date of birth resets your KYC status.
                </Text>
              ) : (
                <Text style={styles.helper}>Format: YYYY-MM-DD.</Text>
              )}

              <View
                style={styles.optionGroup}
                accessibilityRole="radiogroup"
                accessibilityLabel="Trading experience level"
              >
                <Text style={styles.fieldLabel}>Trading experience level</Text>
                <View style={styles.optionRow}>
                  {PROFILE_EXPERIENCE_OPTIONS.map((option) => {
                    const selected = values.tradingExperienceLevel === option.value;
                    return (
                      <Pressable
                        key={option.value}
                        accessibilityRole="radio"
                        accessibilityLabel={option.label}
                        accessibilityState={{ selected }}
                        onPress={() => setFieldValue('tradingExperienceLevel', option.value)}
                        style={[styles.optionPill, selected && styles.optionPillSelected]}
                        disabled={saving}
                      >
                        <Text
                          style={[styles.optionPillText, selected && styles.optionPillTextSelected]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                {errors.tradingExperienceLevel ? (
                  <Text style={styles.fieldErrorText}>{errors.tradingExperienceLevel}</Text>
                ) : null}
              </View>
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Location &amp; preferences</Text>
              <LabeledInput
                label="Country code"
                value={values.countryCode}
                onChangeText={(value) => setFieldValue('countryCode', value.toUpperCase())}
                autoCapitalize="characters"
                maxLength={2}
                placeholder="GH"
                editable={!saving}
                error={errors.countryCode ?? null}
              />
              <Text style={styles.helper}>Use the two-letter ISO country code, such as GH.</Text>
              <LabeledInput
                label="Timezone"
                value={values.timezone}
                onChangeText={(value) => setFieldValue('timezone', value)}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={50}
                placeholder="Africa/Accra"
                editable={!saving}
                error={errors.timezone ?? null}
              />
              <Text style={styles.helper}>IANA timezone, such as Africa/Accra.</Text>
              <LabeledInput
                label="Preferred currency"
                value={values.preferredCurrency}
                onChangeText={(value) => setFieldValue('preferredCurrency', value.toUpperCase())}
                autoCapitalize="characters"
                maxLength={3}
                placeholder="USD"
                editable={!saving}
                error={errors.preferredCurrency ?? null}
              />
              <Text style={styles.helper}>Three-letter ISO code, such as USD.</Text>
            </Card>

            <Card>
              <Text style={styles.cardTitle}>Contact details</Text>
              <Text style={styles.muted}>Read-only. Contact details change only through verified flows.</Text>
              <View style={styles.readonlyRow}>
                <View style={styles.readonlyCopy}>
                  <Text style={styles.rowTitle}>Email</Text>
                  <Text style={view.email ? styles.valueText : styles.valueUnsetText}>
                    {view.email ?? 'Not set'}
                  </Text>
                </View>
                <StatusPill
                  status={badges.email ? 'Verified' : 'Unverified'}
                  tone={badges.email ? 'positive' : 'neutral'}
                />
              </View>
              <View style={styles.readonlyRow}>
                <View style={styles.readonlyCopy}>
                  <Text style={styles.rowTitle}>Phone</Text>
                  <Text style={view.phone ? styles.valueText : styles.valueUnsetText}>
                    {view.phone ?? 'Not set'}
                  </Text>
                </View>
                <StatusPill
                  status={badges.phone ? 'Verified' : 'Unverified'}
                  tone={badges.phone ? 'positive' : 'neutral'}
                />
              </View>
              <Text style={styles.helper}>
                Verification is confirmed by the server only — never inferred on this device.
              </Text>
            </Card>

            <ActionButton
              label="Save profile"
              busyLabel="Saving profile…"
              busy={saving}
              onPress={() => void handleSave()}
              disabled={!dirty || hasErrors}
            />
            {saveFailedNetwork ? (
              <ActionButton
                label="Retry save"
                onPress={() => void handleSave()}
                secondary
                disabled={saving}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  scrollView: { flex: 1 },
  content: { padding: 20, paddingBottom: 40 },
  backButton: {
    minHeight: 46,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    marginTop: 8,
    marginBottom: 4,
  },
  backButtonText: { color: palette.accent, fontSize: 15, fontWeight: '600' },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 4,
  },
  title: { fontSize: 26, fontWeight: '800', color: palette.text },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 16 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: palette.text, marginBottom: 5 },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  helper: { color: palette.helper, fontSize: 12, lineHeight: 18, marginTop: 6 },
  warningText: { color: palette.warningText, fontSize: 12, lineHeight: 18, marginTop: 6 },
  fieldLabel: { color: palette.body, fontSize: 13, fontWeight: '600', marginBottom: 6 },
  fieldErrorText: { color: palette.errorText, fontSize: 12, lineHeight: 18, marginTop: 6 },
  skeletonGap: { marginTop: 13 },
  optionGroup: { marginTop: 13 },
  optionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  optionPill: {
    minHeight: 46,
    borderWidth: 1,
    borderColor: palette.inputBorder,
    backgroundColor: palette.input,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionPillSelected: {
    backgroundColor: palette.success.background,
    borderColor: palette.accent,
  },
  optionPillText: { color: palette.body, fontSize: 13, fontWeight: '700' },
  optionPillTextSelected: { color: palette.pill.positive.text },
  readonlyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15 },
  readonlyCopy: { flex: 1 },
  rowTitle: { color: palette.text, fontSize: 14, fontWeight: '700', marginBottom: 3 },
  valueText: { color: palette.muted, fontSize: 13 },
  valueUnsetText: { color: palette.dim, fontSize: 13, fontStyle: 'italic' },
});
