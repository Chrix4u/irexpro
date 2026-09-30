import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { api } from '../lib/api';
import { buildProfileUpdate } from './onboarding-screen.logic';
import { ActionButton, Banner, Card, LabeledInput, SectionHeader, palette } from '../components/ui';

export default function OnboardingProfileScreen({
  onContinue,
  onBack,
}: {
  onContinue: () => void;
  onBack: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [countryCode, setCountryCode] = useState('');
  const [timezone, setTimezone] = useState('Africa/Accra');
  const [preferredCurrency, setPreferredCurrency] = useState('USD');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const profile = await api.getMyProfile();
      setFirstName(profile.profile.firstName ?? '');
      setLastName(profile.profile.lastName ?? '');
      setDateOfBirth(profile.profile.dateOfBirth ?? '');
      setCountryCode(profile.countryCode ?? '');
      setTimezone(profile.timezone ?? 'Africa/Accra');
      setPreferredCurrency(profile.preferredCurrency ?? 'USD');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    const built = buildProfileUpdate({
      firstName,
      lastName,
      dateOfBirth,
      countryCode,
      timezone,
      preferredCurrency,
    });
    if ('error' in built) {
      setError(built.error ?? 'Invalid profile details.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await api.updateMyProfile(built.body);
      onContinue();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  }, [countryCode, dateOfBirth, firstName, lastName, onContinue, preferredCurrency, timezone]);

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>ONBOARDING · STEP 1 OF 3</Text>
      <Text style={styles.title}>Trader Profile</Text>
      <Text style={styles.subtitle}>
        Complete the identity and regional details required for adult-age, KYC and jurisdiction checks.
      </Text>

      {error ? <Banner variant="error">{error}</Banner> : null}

      <Card>
        <SectionHeader
          title="Personal information"
          description="Changing your date of birth invalidates prior KYC approval and requires a fresh review."
        />
        <LabeledInput label="First name" value={firstName} onChangeText={setFirstName} editable={!loading && !saving} autoCapitalize="words" />
        <LabeledInput label="Last name" value={lastName} onChangeText={setLastName} editable={!loading && !saving} autoCapitalize="words" />
        <LabeledInput
          label="Date of birth"
          value={dateOfBirth}
          onChangeText={setDateOfBirth}
          editable={!loading && !saving}
          placeholder="YYYY-MM-DD"
          keyboardType="numbers-and-punctuation"
        />
      </Card>

      <Card>
        <SectionHeader title="Regional preferences" description="Country is evaluated by the server's active eligibility policy." />
        <LabeledInput
          label="Country code"
          value={countryCode}
          onChangeText={(value) => setCountryCode(value.slice(0, 2).toUpperCase())}
          editable={!loading && !saving}
          placeholder="GH"
          autoCapitalize="characters"
          maxLength={2}
        />
        <LabeledInput label="Timezone" value={timezone} onChangeText={setTimezone} editable={!loading && !saving} placeholder="Africa/Accra" autoCapitalize="none" />
        <LabeledInput
          label="Preferred currency"
          value={preferredCurrency}
          onChangeText={(value) => setPreferredCurrency(value.slice(0, 3).toUpperCase())}
          editable={!loading && !saving}
          placeholder="USD"
          autoCapitalize="characters"
          maxLength={3}
        />
      </Card>

      <ActionButton label="Save profile & continue" busyLabel="Saving profile…" busy={saving} disabled={loading} onPress={() => void save()} />
      <ActionButton label="Back to home" secondary disabled={saving} onPress={onBack} />
      {loading ? <Text style={styles.loading}>Loading current profile…</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 18, paddingBottom: 40 },
  eyebrow: { color: palette.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginTop: 8 },
  title: { color: palette.text, fontSize: 27, fontWeight: '800', marginTop: 7 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 18 },
  loading: { color: palette.muted, fontSize: 12, textAlign: 'center', marginTop: 12 },
});
