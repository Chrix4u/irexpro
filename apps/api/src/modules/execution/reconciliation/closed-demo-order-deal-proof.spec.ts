import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrokerClosedTrade } from '../../broker/interfaces/broker-adapter.interface';
import { TradeDirection, TradeStatus } from '../entities/trade.entity';
import { OrderKind, OrderStatus } from '../orders/order.enums';
import { provePepperstoneDemoClosedOrderFill } from './closed-demo-order-deal-proof';

const opened=new Date('2026-11-23T18:04:56.856Z');
const sent=new Date('2026-11-23T18:13:40.043Z');
const closed=new Date('2026-11-23T18:13:41.745Z');
const order: Parameters<typeof provePepperstoneDemoClosedOrderFill>[0]['order']={userId:'owner',brokerConnectionId:'demo-connection',tradeId:'trade-1',
  status:OrderStatus.RECONCILIATION_PENDING,providerOrderId:null,
  orderKind:OrderKind.MARKET,instrument:'USDCAD',direction:TradeDirection.BUY,
  requestedQuantity:'2.8000',filledQuantity:'0.0000',avgFillPrice:null,
  createdAt:new Date('2026-11-23T18:13:39.965Z'),submittedAt:sent};
const trade: Parameters<typeof provePepperstoneDemoClosedOrderFill>[0]['trade']={id:'trade-1',userId:'owner',brokerConnectionId:'demo-connection',
  status:TradeStatus.CLOSED,instrument:'USDCAD',direction:TradeDirection.SELL,
  externalPositionId:null,externalOrderId:'8422910',lotSize:'2.8000',
  openedAt:opened,closedAt:closed,exitPrice:'1.43767000',realisedPnl:'60.38000000'};
const deal: BrokerClosedTrade={externalOrderId:'8422910',instrument:'USDCAD',direction:'BUY' as const,
  lotSize:'2.8',openPrice:'1.43798',closePrice:'1.43767',stopLoss:'0',takeProfit:'0',
  realisedPnl:'60.38',openedAt:closed,closedAt:closed,commission:'-8.4',swap:'0',
  closeReason:'UNKNOWN' as const};
const input={brokerId:'pepperstone-ctrader',accountType:'DEMO',
  accountUserId:'owner',accountConnectionId:'demo-connection',
  order,trade,providerClosedDeals:[deal],observedAt:new Date('2026-11-23T18:15:00Z')};
const prove=(changes:Partial<typeof input>={})=>
  provePepperstoneDemoClosedOrderFill({...input,...changes});

describe('Pepperstone DEMO CLOSED trade with unsettled closing order',()=>{
  it('requires exact real closing deal and returns only domain-fill quantity + price',()=>{
    expect(prove()).toEqual({matched:true,quantity:'2.8000',price:'1.43767',positionRef:'8422910'});
  });
  it('never works for LIVE, other broker, another owner or account',()=>{
    expect(prove({accountType:'LIVE'}).matched).toBe(false);
    expect(prove({brokerId:'ctrader'}).matched).toBe(false);
    expect(prove({accountUserId:'other'}).matched).toBe(false);
    expect(prove({accountConnectionId:'other'}).matched).toBe(false);
  });
  it('needs an actually closed trade and only an unresolved no-fill MARKET close',()=>{
    expect(prove({trade:{...trade,status:TradeStatus.OPEN}}).matched).toBe(false);
    expect(prove({order:{...order,status:OrderStatus.FILLED}}).matched).toBe(false);
    expect(prove({order:{...order,orderKind:OrderKind.LIMIT}}).matched).toBe(false);
    expect(prove({order:{...order,filledQuantity:'0.1'}}).matched).toBe(false);
    expect(prove({order:{...order,avgFillPrice:'1.4'}}).matched).toBe(false);
    expect(prove({order:{...order,providerOrderId:'991'}}).matched).toBe(false);
  });
  it('never infers a provider fill from a missing or duplicate deal',()=>{
    expect(prove({providerClosedDeals:[]}).matched).toBe(false);
    expect(prove({providerClosedDeals:[deal,deal]}).matched).toBe(false);
    expect(prove({providerClosedDeals:[{...deal,externalOrderId:'different'}]}).matched).toBe(false);
  });
  it('does not accept side, instrument, lot, price or gross-profit mismatch',()=>{
    for(const wrong of [
      {...deal,direction:'SELL' as const},
      {...deal,instrument:'EURUSD'},
      {...deal,lotSize:'2.5'},
      {...deal,closePrice:'1.43768'},
      {...deal,realisedPnl:'60.39'},
    ]) expect(prove({providerClosedDeals:[wrong]}).matched).toBe(false);
  });
  it('needs same position and trade provenance without inferring provider order id',()=>{
    expect(prove({order:{...order,tradeId:'other'}}).matched).toBe(false);
    expect(prove({trade:{...trade,externalOrderId:null}}).matched).toBe(false);
    expect(prove({trade:{...trade,lotSize:'2.9'}}).matched).toBe(false);
    expect(prove({trade:{...trade,exitPrice:'1.43768'}}).matched).toBe(false);
    expect(prove({trade:{...trade,realisedPnl:'61.38'}}).matched).toBe(false);
  });
  it('never accepts a pre-dispatch deal, stale close or after-the-fact timestamp mismatch',()=>{
    expect(prove({providerClosedDeals:[{...deal,closedAt:new Date('2026-11-23T18:13:39Z')}]}).matched).toBe(false);
    expect(prove({providerClosedDeals:[{...deal,closedAt:new Date('2026-11-23T18:13:43Z')}]}).matched).toBe(false);
    expect(prove({order:{...order,submittedAt:new Date('2026-11-23T18:11:00Z')}}).matched).toBe(false);
    expect(prove({observedAt:new Date('2026-11-24T18:15:00Z')}).matched).toBe(false);
    expect(prove({observedAt:new Date('2026-11-23T18:13:00Z')}).matched).toBe(false);
  });
  it('reconciliation integration only uses existing exact-decimal domain fill; no direct trade writes',()=>{
    const source=fs.readFileSync(path.resolve(__dirname,'state-reconciliation.service.ts'),'utf8');
    expect(source).toContain('provePepperstoneDemoClosedOrderFill({');
    expect(source).toContain('this.orderService.applyFill(order.id,{');
    expect(source).toContain("connection.brokerId === 'pepperstone-ctrader'");
    expect(source).toContain('connection.userId===process.env.VPS_FOREX_SCANNER_USER_ID');
    expect(source).toContain('this.tradeRepo.findOne({where:{');
    expect(source).toContain("status:TradeStatus.CLOSED");
  });
});
