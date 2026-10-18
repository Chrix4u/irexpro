import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BROKER_CATALOG, BROKER_CATALOG_VERSION } from './broker-catalog';
import {
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  BrokerDefinition,
  deriveProviderCertificationState,
  ProviderCertificationState,
} from './broker-definition';
import { BrokerCapability } from './broker-capability.enum';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';

/** Materialized (always-present) production-LIVE verification status. */
export type BrokerProductionLiveVerificationStatus = 'UNVERIFIED' | 'VERIFIED';

export type BrokerConnectionReadinessCode =
  | 'READY'
  | 'ADAPTER_UNAVAILABLE'
  | 'PLATFORM_CREDENTIALS_REQUIRED'
  | 'PROVIDER_APP_APPROVAL_REQUIRED'
  | 'OAUTH_REDIRECT_REQUIRED'
  | 'MOBILE_OAUTH_CALLBACK_REQUIRED';

export interface BrokerConnectionChannelReadiness {
  ready: boolean;
  code: BrokerConnectionReadinessCode;
  message: string | null;
}

export interface BrokerConnectionReadiness extends BrokerConnectionChannelReadiness {
  /** Channel-specific OAuth prerequisites when web/mobile differ. */
  channels?: Partial<Record<'web' | 'mobile', BrokerConnectionChannelReadiness>>;
}

/** Frontend-safe registry view (no adapter instances, no secrets). */
export interface BrokerRegistryEntry {
  id: string;
  name: string;
  description: string;
  status: BrokerAvailabilityStatus;
  productionLiveVerification: {
    status: BrokerProductionLiveVerificationStatus;
    verifiedAt: string | null;
    evidenceRef: string | null;
    certifiedVia: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED' | null;
    certificationRunRef: string | null;
    certificationState: ProviderCertificationState;
  };
  certificationState: ProviderCertificationState;
  connectionRoutes: BrokerConnectionRoute[];
  capabilities: BrokerCapability[];
  authenticationType: BrokerDefinition['authenticationType'];
  environments: BrokerDefinition['environments'];
  regions: string[];
  adapterAvailable: boolean;
  connectionReadiness: BrokerConnectionReadiness;
}

@Injectable()
export class BrokerProviderRegistryService {
  constructor(
    private readonly adapterRegistry: BrokerAdapterRegistry,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  getCatalog(): BrokerRegistryEntry[] {
    return BROKER_CATALOG.map((entry) => {
      const adapterAvailable =
        entry.adapterId !== null && this.adapterRegistry.isSupported(entry.adapterId);

      const effectiveStatus =
        (entry.status === BrokerAvailabilityStatus.SUPPORTED ||
          entry.status === BrokerAvailabilityStatus.BETA) &&
        !adapterAvailable
          ? BrokerAvailabilityStatus.NOT_STARTED
          : entry.status;

      const certificationState = deriveProviderCertificationState(entry.productionLiveVerification);

      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        status: effectiveStatus,
        productionLiveVerification: {
          status: entry.productionLiveVerification?.status ?? 'UNVERIFIED',
          verifiedAt: entry.productionLiveVerification?.verifiedAt ?? null,
          evidenceRef: entry.productionLiveVerification?.evidenceRef ?? null,
          certifiedVia: entry.productionLiveVerification?.certifiedVia ?? null,
          certificationRunRef: entry.productionLiveVerification?.certificationRunRef ?? null,
          certificationState,
        },
        certificationState,
        connectionRoutes: [...entry.connectionRoutes],
        capabilities: [...entry.capabilities],
        authenticationType: entry.authenticationType,
        environments: [...entry.environments],
        regions: [...entry.regions],
        adapterAvailable,
        connectionReadiness: this.connectionReadiness(entry.adapterId, adapterAvailable),
      };
    });
  }

  private connectionReadiness(
    adapterId: string | null,
    adapterAvailable: boolean,
  ): BrokerConnectionReadiness {
    if (!adapterAvailable) {
      return {
        ready: false,
        code: 'ADAPTER_UNAVAILABLE',
        message: 'This broker integration is not available on the current server.',
      };
    }

    if (adapterId === 'ctrader') {
      const clientId =
        this.configService?.get<string>('broker.ctraderClientId') ?? process.env.CTRADER_CLIENT_ID;
      const clientSecret =
        this.configService?.get<string>('broker.ctraderClientSecret') ??
        process.env.CTRADER_CLIENT_SECRET;
      if (!clientId?.trim() || !clientSecret?.trim()) {
        return {
          ready: false,
          code: 'PLATFORM_CREDENTIALS_REQUIRED',
          message:
            'cTrader authorization is awaiting platform configuration. Contact the iRexPro operator.',
        };
      }

      const approvalStatus = (
        this.configService?.get<string>('broker.ctraderAppApprovalStatus') ??
        process.env.CTRADER_APP_APPROVAL_STATUS ??
        'unknown'
      )
        .trim()
        .toLowerCase();
      if (approvalStatus === 'pending') {
        return {
          ready: false,
          code: 'PROVIDER_APP_APPROVAL_REQUIRED',
          message:
            'cTrader Open API access is awaiting Spotware application approval. Connection will unlock after the app is marked active.',
        };
      }

      const redirectUris =
        this.configService?.get<string>('broker.ctraderRedirectUris') ??
        process.env.CTRADER_REDIRECT_URIS;
      const web: BrokerConnectionChannelReadiness = this.hasHttpsCallback(redirectUris)
        ? { ready: true, code: 'READY', message: null }
        : {
            ready: false,
            code: 'OAUTH_REDIRECT_REQUIRED',
            message:
              'cTrader authorization is awaiting its approved callback configuration. Contact the iRexPro operator.',
          };

      const mobileCallbackUris =
        this.configService?.get<string>('broker.ctraderMobileCallbackUris') ??
        process.env.CTRADER_MOBILE_CALLBACK_URIS;
      const mobile: BrokerConnectionChannelReadiness = this.hasHttpsCallback(mobileCallbackUris)
        ? { ready: true, code: 'READY', message: null }
        : {
            ready: false,
            code: 'MOBILE_OAUTH_CALLBACK_REQUIRED',
            message:
              'cTrader mobile authorization is awaiting its approved callback configuration. Contact the iRexPro operator.',
          };

      return { ...web, channels: { web, mobile } };
    }

    return { ready: true, code: 'READY', message: null };
  }

  private hasHttpsCallback(raw: string | undefined): boolean {
    if (!raw?.trim()) return false;
    return raw
      .split(',')
      .map((uri) => uri.trim())
      .filter(Boolean)
      .some((uri) => {
        try {
          return new URL(uri).protocol === 'https:';
        } catch {
          return false;
        }
      });
  }

  getEntry(brokerId: string): BrokerRegistryEntry | null {
    return this.getCatalog().find((e) => e.id === brokerId) ?? null;
  }

  isConnectable(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable;
  }

  isProductionLiveEligible(brokerId: string): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.adapterAvailable && entry.certificationState === 'CERTIFIED';
  }

  hasCapability(brokerId: string, capability: BrokerCapability): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.capabilities.includes(capability);
  }

  supportsEnvironment(brokerId: string, environment: 'DEMO' | 'LIVE'): boolean {
    const entry = this.getEntry(brokerId);
    return entry !== null && entry.environments.includes(environment);
  }

  get catalogVersion(): string {
    return BROKER_CATALOG_VERSION;
  }
}
