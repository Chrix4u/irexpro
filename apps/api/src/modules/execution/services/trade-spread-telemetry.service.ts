import { Injectable } from '@nestjs/common';
import { ExactDecimal } from '../../../common/utils/exact-decimal';
import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { BrokerFxConversionService } from '../../market-data/services/broker-fx-conversion.service';

export const ENTRY_SPREAD_ROUND_TRIP_PROXY = 'ENTRY_SPREAD_ROUND_TRIP_PROXY' as const;

export interface TradeSpreadCostEstimate {
  estimatedSpreadCost: string;
  spreadCostEstimateMethod: typeof ENTRY_SPREAD_ROUND_TRIP_PROXY;
  spreadCostContractSize: string;
  spreadCostQuoteCurrency: string;
  spreadCostConversionRate: string;
  spreadCostConversionInstrument: string | null;
}

@Injectable()
export class TradeSpreadTelemetryService {
  constructor(
    private readonly brokerService: BrokerService,
    private readonly fxConversion: BrokerFxConversionService,
  ) {}

  async estimateEntrySpreadCost(input: {
    userId: string;
    brokerConnectionId: string;
    instrument: string;
    lotSize: string;
    accountCurrency: string;
    quote: BrokerPrice;
  }): Promise<TradeSpreadCostEstimate | null> {
    try {
      const instrument = input.instrument.trim().toUpperCase();
      const accountCurrency = input.accountCurrency.trim().toUpperCase();
      if (!/^[A-Z]{6}$/.test(instrument) || !/^[A-Z]{3}$/.test(accountCurrency)) return null;
      if (input.quote.instrument.trim().toUpperCase() !== instrument) return null;

      const bid = ExactDecimal.tryParse(input.quote.bid);
      const ask = ExactDecimal.tryParse(input.quote.ask);
      const lotSize = ExactDecimal.tryParse(input.lotSize);
      if (!bid?.isPositive() || !ask?.isPositive() || ask.lt(bid) || !lotSize?.isPositive()) {
        return null;
      }
      const spread = ask.sub(bid);
      if (spread.isNegative()) return null;

      const spec = await this.brokerService.getInstrumentSpecForConnection(
        input.userId,
        input.brokerConnectionId,
        instrument,
      );
      const contractSize = ExactDecimal.tryParse(spec?.contractSize ?? '');
      if (!contractSize?.isPositive()) return null;

      const quoteCurrency = instrument.slice(3, 6);
      const baseCurrency = instrument.slice(0, 3);
      const quoteCost = spread.mul(contractSize).mul(lotSize);

      let conversionRate = ExactDecimal.ONE;
      let conversionInstrument: string | null = null;
      if (accountCurrency === baseCurrency) {
        conversionRate = bid.add(ask).div(ExactDecimal.parse('2'), {
          scale: 12,
          mode: 'HALF_UP',
        });
        conversionInstrument = instrument;
      } else if (accountCurrency !== quoteCurrency) {
        const conversion = await this.fxConversion.resolveCachedBid(
          input.brokerConnectionId,
          accountCurrency,
          quoteCurrency,
          new Date(input.quote.timestamp),
        );
        if (!conversion) return null;
        const parsedRate = ExactDecimal.tryParse(conversion.rate);
        if (!parsedRate?.isPositive()) return null;
        conversionRate = parsedRate;
        conversionInstrument = conversion.path[0] ?? null;
      }

      const estimatedSpreadCost =
        accountCurrency === quoteCurrency ? quoteCost : quoteCost.divDown(conversionRate, 8);

      return {
        estimatedSpreadCost: estimatedSpreadCost.toString(),
        spreadCostEstimateMethod: ENTRY_SPREAD_ROUND_TRIP_PROXY,
        spreadCostContractSize: contractSize.toString(),
        spreadCostQuoteCurrency: quoteCurrency,
        spreadCostConversionRate: conversionRate.toString(),
        spreadCostConversionInstrument: conversionInstrument,
      };
    } catch {
      return null;
    }
  }
}
