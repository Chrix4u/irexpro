import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import {
  BrokerProviderRegistryService,
  BrokerRegistryEntry,
} from './registry/broker-provider-registry.service';

/**
 * BrokerRegistryController — the single server-authoritative broker catalog
 * (Directive §N / §AU).
 *
 * All clients (web, admin, mobile) MUST render broker availability from this
 * endpoint — never from client-side lists. Status honesty is enforced by
 * BrokerProviderRegistryService: entries without a registered runtime
 * adapter can never be reported as SUPPORTED.
 */
@ApiTags('Broker Registry')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('broker/registry')
export class BrokerRegistryController {
  constructor(private readonly providerRegistry: BrokerProviderRegistryService) {}

  @Get()
  @ApiOperation({
    summary: 'List the server-authoritative broker catalog with capabilities',
    description:
      'Returns broker definitions with implementation status, capabilities, ' +
      'connection routes, supported environments and authentication type. ' +
      'Statuses are evidence-based: SUPPORTED requires a registered adapter. ' +
      'Each entry also carries productionLiveVerification (Phase H): BETA ≠ ' +
      'production-LIVE — UNVERIFIED/absent means LIVE execution is fail-closed ' +
      'server-side (BETA providers are DEMO-only).',
  })
  @ApiResponse({ status: 200, description: 'Broker registry catalog' })
  async getCatalog(): Promise<{ catalogVersion: string; brokers: BrokerRegistryEntry[] }> {
    return {
      catalogVersion: this.providerRegistry.catalogVersion,
      brokers: this.providerRegistry.getCatalog(),
    };
  }
}
