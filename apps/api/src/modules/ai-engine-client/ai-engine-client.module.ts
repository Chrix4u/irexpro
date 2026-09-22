import { Global, Module } from '@nestjs/common';
import { AiEngineClient } from './ai-engine-client.service';
// October UAT hardening (WS3): the exact-model LIVE approval gate (global —
// consumed by the risk pipeline, the final dispatch boundary, the trading
// runtime status and the live-account readiness surface).
import { LiveModelApprovalGateService } from './live-model-approval.gate';

@Global()
@Module({
  providers: [AiEngineClient, LiveModelApprovalGateService],
  exports: [AiEngineClient, LiveModelApprovalGateService],
})
export class AiEngineClientModule {}
