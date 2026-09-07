import { StyleSheet, Text } from 'react-native';
import {
  ActionButton,
  Card,
  palette,
} from '@/components/ui';

/**
 * INTERIM Sprint 55 account sections.
 *
 * The Contact verification / Authenticator MFA sections that used to live
 * here were superseded in Task 40-b by the dedicated Security hub screens
 * (SecurityScreen → ChangePasswordScreen / MfaScreen / VerificationScreen)
 * and removed. Only the session-security card for the interim "Account
 * Access" expandable remains — Task 40-c replaces it with a dedicated
 * Account Access screen, at which point this file is deleted.
 *
 * The AccountScreen hub owns ALL state and handlers (single-flight busy
 * guard, sanitized errors); this component is purely presentational.
 */

/** Single-flight busy marker shared by the interim account actions. */
export type AccountBusyAction = 'logout' | null;

interface SessionSecuritySectionProps {
  busy: AccountBusyAction;
  onLogout: () => void;
}

export function SessionSecuritySection({ busy, onLogout }: SessionSecuritySectionProps) {
  return (
    <Card>
      <Text style={styles.cardTitle}>Session security</Text>
      <Text style={styles.bodyText}>
        Logging out revokes the active server-side session generation before secure local credentials are removed. If the server cannot confirm revocation during a temporary outage, the app keeps the credentials so logout can be retried safely.
      </Text>
      <ActionButton
        label={busy === 'logout' ? 'Revoking session…' : 'Log out'}
        onPress={onLogout}
        disabled={Boolean(busy)}
        danger
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontSize: 17, fontWeight: '700', color: palette.text, marginBottom: 5 },
  bodyText: { color: palette.bodySoft, fontSize: 14, lineHeight: 21, marginTop: 6, marginBottom: 12 },
});
