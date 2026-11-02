import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarketIntelligenceQueryDto } from './market-intelligence-query.dto';

describe('MarketIntelligenceQueryDto', () => {
  it('accepts limit=1 for the lightweight live-quote projection', async () => {
    const dto = plainToInstance(MarketIntelligenceQueryDto, {
      instrument: 'EURUSD',
      timeframe: 'M5',
      limit: '1',
      brokerConnectionId: '022fd0e5-f404-4f48-bbf3-fba3a1964650',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.limit).toBe(1);
  });

  it('still rejects a non-positive candle limit', async () => {
    const dto = plainToInstance(MarketIntelligenceQueryDto, {
      instrument: 'EURUSD',
      timeframe: 'M5',
      limit: '0',
    });

    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});
