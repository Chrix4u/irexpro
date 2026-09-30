import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { createEligibilityApi } from '@irexpro/api-client/eligibility';
import type { EligibilityDisclosureKey, EligibilityStatusView } from '@irexpro/types/eligibility';
import { api } from '../lib/api';
import { buildDisclosureAcceptance, disclosuresAreSelectable } from './onboarding-screen.logic';
import { ActionButton, Banner, Card, SectionHeader, StatusPill, palette } from '../components/ui';

const eligibilityApi = createEligibilityApi(api);

function jurisdictionTone(status: EligibilityStatusView['jurisdictionStatus']) {
  if (status === 'ELIGIBLE') return 'positive' as const;
  if (status === 'INELIGIBLE') return 'danger' as const;
  return 'warning' as const;
}

function identityTone(status: EligibilityStatusView) {
  if (status.ageStatus === 'UNDER_18' || status.ageStatus === 'INVALID_DOB' || status.kycStatus === 'REJECTED') {
    return 'danger' as const;
  }
  if (status.ageStatus === 'ADULT' && status.kycStatus === 'APPROVED') return 'positive' as const;
  return 'warning' as const;
}

export default function OnboardingEligibilityScreen({
  onContinue,
  onEditProfile,
  onBack,
}: {
  onContinue: () => void;
  onEditProfile: () => void;
  onBack: () => void;
}) {
  const [status, setStatus] = useState<EligibilityStatusView | null>(null);
  const [selected, setSelected] = useState<Set<EligibilityDisclosureKey>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submittingKyc, setSubmittingKyc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await eligibilityApi.getMyStatus());
      setSelected(new Set());
    } catch (requestError) {
      setStatus(null);
      setError(requestError instanceof Error ? requestError.message : 'Failed to load eligibility status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accepted = useMemo(() => new Set(status?.consents.map((item) => item.key) ?? []), [status]);
  const missing = useMemo(
    () => status?.disclosures.filter((item) => !accepted.has(item.key)) ?? [],
    [accepted, status],
  );

  const toggle = useCallback((key: EligibilityDisclosureKey) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const submitKyc = useCallback(async () => {
    setSubmittingKyc(true);
    setError(null);
    setMessage(null);
    try {
      const next = await eligibilityApi.submitKyc();
      setStatus(next);
      setMessage('KYC has been submitted for authorised review.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to submit KYC');
    } finally {
      setSubmittingKyc(false);
    }
  }, []);

  const acceptRequired = useCallback(async () => {
    if (!status) return;
    setError(null);
    setMessage(null);

    const built = buildDisclosureAcceptance(status, selected);
    if ('error' in built) {
      setError(built.error ?? 'Eligibility evidence is incomplete.');
      return;
    }
    if (built.body === null) {
      if (status.canProceed) onContinue();
      return;
    }

    setSaving(true);
    try {
      const next = await eligibilityApi.acceptDisclosures(built.body);
      setStatus(next);
      setSelected(new Set());
      if (next.canProceed) {
        setMessage('Eligibility evidence is complete.');
      } else if (next.jurisdictionStatus === 'REVIEW_REQUIRED') {
        setMessage('Disclosure evidence is recorded. Jurisdiction review is still required.');
      } else if (next.kycStatus !== 'APPROVED') {
        setMessage('Disclosure evidence is recorded. Identity/KYC review is still required.');
      } else {
        setMessage('Disclosure evidence is recorded. Readiness remains unavailable.');
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Failed to record disclosure evidence');
    } finally {
      setSaving(false);
    }
  }, [onContinue, selected, status]);

  const disclosuresDisabled = !status || !disclosuresAreSelectable(status);

  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>ONBOARDING · STEP 2 OF 3</Text>
      <Text style={styles.title}>Eligibility & disclosures</Text>
      <Text style={styles.subtitle}>
        Adult age, KYC, jurisdiction policy and exact disclosure consent are all server-authoritative.
      </Text>

      {error ? <Banner variant="error">{error}</Banner> : null}
      {message ? <Banner variant="success">{message}</Banner> : null}

      {loading ? <Card><Text style={styles.muted}>Loading current eligibility and identity readiness…</Text></Card> : null}

      {!loading && !status ? (
        <Card>
          <SectionHeader title="Eligibility unavailable" description="No previous status is reused when the server cannot verify the current contract." />
          <ActionButton label="Retry" onPress={() => void load()} />
        </Card>
      ) : null}

      {status ? (
        <>
          <Card>
            <SectionHeader
              title="Jurisdiction gate"
              description={'Country: ' + (status.countryCode ?? 'not provided') + ' · policy ' + status.policyVersion}
              right={<StatusPill status={status.jurisdictionStatus} tone={jurisdictionTone(status.jurisdictionStatus)} />}
            />
            <Text style={styles.detail}>Decision source: {status.decisionSource.replaceAll('_', ' ')}</Text>
            <Text style={styles.detail}>Reason: {status.reasonCode.replaceAll('_', ' ')}</Text>
          </Card>

          <Card>
            <SectionHeader
              title="Identity gate"
              description={'Age: ' + status.ageStatus.replaceAll('_', ' ') + ' · KYC: ' + status.kycStatus}
              right={<StatusPill status={status.kycStatus} tone={identityTone(status)} />}
            />
            <Text style={styles.detail}>Reason: {status.identityReasonCode.replaceAll('_', ' ')}</Text>
            {status.ageStatus === 'MISSING_DOB' || status.ageStatus === 'INVALID_DOB' ? (
              <ActionButton label="Edit profile" secondary onPress={onEditProfile} />
            ) : null}
            {status.ageStatus === 'ADULT' && status.kycStatus === 'NONE' ? (
              <ActionButton label="Submit KYC for review" busyLabel="Submitting KYC…" busy={submittingKyc} onPress={() => void submitKyc()} />
            ) : null}
          </Card>

          <Card>
            <SectionHeader
              title="Required disclosures"
              description="Consent is bound to the active policy fingerprint and exact disclosure content."
              right={
                <StatusPill
                  status={status.missingConsentKeys.length === 0 ? 'COMPLETE' : String(status.missingConsentKeys.length) + '_OUTSTANDING'}
                  tone={status.missingConsentKeys.length === 0 ? 'positive' : 'warning'}
                />
              }
            />
            <View style={styles.disclosures}>
              {status.disclosures.map((item) => {
                const isAccepted = accepted.has(item.key);
                const checked = isAccepted || selected.has(item.key);
                const disabled = isAccepted || disclosuresDisabled || saving;
                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked, disabled }}
                    disabled={disabled}
                    onPress={() => toggle(item.key)}
                    style={[styles.disclosure, checked && styles.disclosureChecked, disabled && !isAccepted && styles.disabled]}
                  >
                    <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                      <Text style={styles.checkText}>{checked ? '✓' : ''}</Text>
                    </View>
                    <View style={styles.disclosureCopy}>
                      <View style={styles.disclosureHeader}>
                        <Text style={styles.disclosureTitle}>{item.title}</Text>
                        <Text style={styles.version}>{isAccepted ? 'ACCEPTED' : 'v' + item.version}</Text>
                      </View>
                      <Text style={styles.disclosureBody}>{item.body}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            {!disclosuresDisabled && missing.length > 0 ? (
              <ActionButton label="Accept required disclosures" busyLabel="Recording evidence…" busy={saving} onPress={() => void acceptRequired()} />
            ) : null}
            {status.canProceed ? <ActionButton label="Continue to broker connection" onPress={onContinue} /> : null}
            <ActionButton label="Refresh status" secondary disabled={saving || submittingKyc} onPress={() => void load()} />
          </Card>

          <ActionButton label="Back to profile" secondary onPress={onEditProfile} />
          <ActionButton label="Back to home" secondary onPress={onBack} />
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.bg },
  content: { padding: 18, paddingBottom: 44 },
  eyebrow: { color: palette.accent, fontSize: 11, fontWeight: '800', letterSpacing: 1.1, marginTop: 8 },
  title: { color: palette.text, fontSize: 27, fontWeight: '800', marginTop: 7 },
  subtitle: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 18 },
  muted: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  detail: { color: palette.bodySoft, fontSize: 12, lineHeight: 18, marginTop: 7 },
  disclosures: { marginTop: 14, gap: 10 },
  disclosure: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderWidth: 1, borderColor: palette.cardBorder, backgroundColor: palette.input, borderRadius: 12, padding: 13 },
  disclosureChecked: { borderColor: palette.success.border },
  disabled: { opacity: 0.55 },
  checkbox: { width: 23, height: 23, borderRadius: 6, borderWidth: 1, borderColor: palette.inputBorder, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkboxChecked: { backgroundColor: palette.accent, borderColor: palette.accent },
  checkText: { color: palette.accentText, fontSize: 14, fontWeight: '900' },
  disclosureCopy: { flex: 1 },
  disclosureHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' },
  disclosureTitle: { color: palette.text, fontSize: 14, fontWeight: '700', flex: 1 },
  version: { color: palette.accent, fontSize: 10, fontWeight: '800' },
  disclosureBody: { color: palette.muted, fontSize: 12, lineHeight: 18, marginTop: 7 },
});
