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
  ],
  exports: [MarketDataService, MarketIntelligenceService, ProviderQuoteCandleStoreService],
})
export class MarketDataModule {}
