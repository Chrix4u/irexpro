import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { MetaTraderAdapter } from './metatrader.adapter';
import { MetaApiClientService } from '../services/metaapi-client.service';
import {
  BrokerMode,
  BrokerOrderRequest,
  RequiredMarginParams,
} from '../interfaces/broker-adapter.interface';

describe('MetaTraderAdapter — account-scoped margin and order routing', () => {
  let adapter: MetaTraderAdapter;
  let calculateMargin: jest.Mock;
  let getOrCreateConnection: jest.Mock;
  let createMarketBuyOrder: jest.Mock;
  const params = (direction: 'BUY' | 'SELL'): RequiredMarginParams => ({
    instrument: 'EURUSD',
    lotSize: '0.10',
    direction,
    connectionReference: 'metaapi-account-A',
  });

  beforeEach(async () => {
    calculateMargin = jest.fn().mockResolvedValue('125.50');
    createMarketBuyOrder = jest
      .fn()
      .mockResolvedValue({ stringCode: 'TRADE_RETCODE_DONE', positionId: 'position-1' });
    getOrCreateConnection = jest.fn().mockResolvedValue({
      subscribeToMarketData: jest.fn(),
      unsubscribeFromMarketData: jest.fn(),
      getSymbolPrice: jest.fn().mockResolvedValue({ bid: 1.084, ask: 1.085 }),
      createMarketBuyOrder,
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetaTraderAdapter,
        { provide: MetaApiClientService, useValue: { calculateMargin, getOrCreateConnection } },
        { provide: Logger, useValue: { log: jest.fn(), warn: jest.fn(), error: jest.fn() } },
      ],
    }).compile();
    adapter = module.get(MetaTraderAdapter);
    adapter.setMode(BrokerMode.LIVE);
  });

  it('maps BUY margin using ask on explicit account', async () => {
    await expect(adapter.getRequiredMargin(params('BUY'))).resolves.toBe('125.50');
    expect(getOrCreateConnection).toHaveBeenCalledWith('metaapi-account-A', {
      requireSynchronization: true,
    });
    expect(calculateMargin).toHaveBeenCalledWith(
      'metaapi-account-A',
      expect.objectContaining({
        type: 'ORDER_TYPE_BUY',
        volume: 0.1,
        openPrice: 1.085,
      }),
    );
  });
  it('maps SELL margin using bid on explicit account', async () => {
    await expect(adapter.getRequiredMargin(params('SELL'))).resolves.toBe('125.50');
    expect(calculateMargin).toHaveBeenCalledWith(
      'metaapi-account-A',
      expect.objectContaining({ type: 'ORDER_TYPE_SELL', openPrice: 1.084 }),
    );
  });
  it('ignores mutable currentAccountId for margin', async () => {
    (adapter as unknown as { currentAccountId: string }).currentAccountId = 'other-account';
    await adapter.getRequiredMargin(params('BUY'));
    expect(getOrCreateConnection).toHaveBeenCalledWith('metaapi-account-A', {
      requireSynchronization: true,
    });
  });
  it('routes placeOrder using explicit account even when singleton state points elsewhere', async () => {
    (adapter as unknown as { currentAccountId: string }).currentAccountId = 'other-account';
    const order: BrokerOrderRequest = {
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.10',
      stopLoss: '1.0700',
      takeProfit: '1.1000',
      idempotencyKey: 'idem-1',
      connectionReference: 'metaapi-account-A',
    };
    await expect(adapter.placeOrder(order)).resolves.toEqual(
      expect.objectContaining({ success: true, externalOrderId: 'position-1' }),
    );
    expect(getOrCreateConnection).toHaveBeenCalledWith('metaapi-account-A');
    expect(createMarketBuyOrder).toHaveBeenCalledTimes(1);
  });
  it('fails closed when margin reference is missing', async () => {
    await expect(
      adapter.getRequiredMargin({ instrument: 'EURUSD', lotSize: '0.10', direction: 'BUY' }),
    ).resolves.toBeNull();
    expect(calculateMargin).not.toHaveBeenCalled();
  });
  it('fails closed on invalid lot size', async () => {
    await expect(
      adapter.getRequiredMargin({ ...params('BUY'), lotSize: 'bad' }),
    ).resolves.toBeNull();
    expect(calculateMargin).not.toHaveBeenCalled();
  });
  it('fails closed when native margin returns null', async () => {
    calculateMargin.mockResolvedValue(null);
    await expect(adapter.getRequiredMargin(params('BUY'))).resolves.toBeNull();
  });
  it('fails closed when native margin returns malformed data', async () => {
    calculateMargin.mockResolvedValue('Infinity');
    await expect(adapter.getRequiredMargin(params('BUY'))).resolves.toBeNull();
  });
  it('fails closed when native margin throws', async () => {
    calculateMargin.mockRejectedValue(new Error('provider'));
    await expect(adapter.getRequiredMargin(params('BUY'))).resolves.toBeNull();
  });
  it('does not use getInstrumentList or local leverage formula', async () => {
    const spy = jest.spyOn(adapter, 'getInstrumentList');
    await adapter.getRequiredMargin(params('BUY'));
    expect(spy).not.toHaveBeenCalled();
    expect(calculateMargin).toHaveBeenCalledTimes(1);
  });
});
