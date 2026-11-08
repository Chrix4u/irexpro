import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from './broker-authorization-status';
import { BrokerCredentialStatus } from './broker-credential-status';
import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';
import { isFxWeeklySessionOpen } from '../../market-data/utils/fx-weekly-session';

/**
 * Transport-only grace during closed FX weekends, not a new DEMO authorization.
 *
 * The cTrader provider may return exactly "Cannot route request" while its
 * DEMO matching infrastructure is closed. Counting those as credential /
 * broker failures previously suspended an ACTIVE account on Saturday and
 * recovery returned it merely CONNECTED, requiring manual re-authorization.
 *
 * Do not grant ACTIVE, mark a failed health check healthy, or swallow
 * auth/identity failures. Never apply to LIVE or inside the FX session.
 */
export function isDeferredCtraderWeekendRouteFailure(
  connection: {
    brokerId: string;
    accountType: BrokerMode;
    status: BrokerConnectionStatus;
    authorizationStatus: BrokerAuthorizationStatus | null | undefined;
    credentialStatus: BrokerCredentialStatus | null | undefined;
    demoValidated: boolean;
  },
  error: unknown,
  now: Date,
): boolean {
  const message = error instanceof Error ? error.message : null;
  if (
    connection.accountType !== BrokerMode.DEMO ||
    !CTRADER_FAMILY_BROKER_IDS.includes(connection.brokerId) ||
    connection.status !== BrokerConnectionStatus.CONNECTED ||
    connection.authorizationStatus !== BrokerAuthorizationStatus.ACTIVE ||
    connection.credentialStatus !== BrokerCredentialStatus.VERIFIED ||
    connection.demoValidated !== true ||
    isFxWeeklySessionOpen(now)
  ) {
    return false;
  }
  return message === 'Cannot route request' || message === 'cTrader error: Cannot route request';
}
