import { Module } from '@nestjs/common';
import { MarketDataController } from './market-data.controller';
import { MarketDataService } from './market-data.service';
import { MarketIntelligenceService } from './market-intelligence.service';
import { MetaTraderMarketDataReaderService } from './meta-trader-market-data-reader.service';
import { BrokerModule } from '../broker/broker.module';
import { AuditModule } from '../audit/audit.module';
import { InternalApiKeyGuard } from '../../common/guards/internal-api-key.guard';
import { ProviderQuoteCandleStoreService } from './services/provider-quote-candle-store.service';
import { MetaApiQuoteCollectorService } from './services/metaapi-quote-collector.service';
import { CTraderQuoteCollectorService } from './services/ctrader-quote-collector.service';
import { PaperPositionMarkBridgeService } from './services/paper-position-mark-bridge.service';
import { BrokerFxConversionService } from './services/broker-fx-conversion.service';

@Module({
  imports: [BrokerModule, AuditModule],
  controllers: [MarketDataController],
  providers: [
    MarketDataService,
    MarketIntelligenceService,
    MetaTraderMarketDataReaderService,
    InternalApiKeyGuard,
    ProviderQuoteCandleStoreService,
    MetaApiQuoteCollectorService,
    CTraderQuoteCollectorService,
    PaperPositionMarkBridgeService,
    BrokerFxConversionService,
  ],
  exports: [
    MarketDataService,
    MarketIntelligenceService,
    ProviderQuoteCandleStoreService,
    BrokerFxConversionService,
  ],
})
export class MarketDataModule {}
