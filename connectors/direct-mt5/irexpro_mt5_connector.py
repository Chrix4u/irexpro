#!/usr/bin/env python3
"""iRexPro Direct MT5 DEMO connector. Runs on the Windows machine hosting MetaTrader 5."""
import argparse, datetime as dt, json, os, sys, time, urllib.request, urllib.error
try:
    import MetaTrader5 as mt5
except ImportError:
    print('Install dependency first: py -m pip install MetaTrader5', file=sys.stderr); raise

def req(base, path, data, token=None):
    body=json.dumps(data).encode(); headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    r=urllib.request.Request(base.rstrip('/')+'/'+path.lstrip('/'), data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(r, timeout=15) as x:
            if x.status==204: return None
            return json.loads(x.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'HTTP {e.code}: {e.read().decode(errors="replace")[:500]}')

def account():
    a=mt5.account_info()
    if not a: raise RuntimeError('MT5 account_info unavailable; open/login to the terminal first')
    demo_const=getattr(mt5,'ACCOUNT_TRADE_MODE_DEMO',0)
    if int(a.trade_mode)!=int(demo_const): raise RuntimeError('Refusing non-DEMO MT5 account. Direct MT5 LIVE is not certified.')
    return a

def symbol_spec(name):
    s=mt5.symbol_info(name)
    if not s: raise RuntimeError('Unknown MT5 symbol '+name)
    return {'symbol':name,'displayName':getattr(s,'description',name),'baseCurrency':name[:3],'quoteCurrency':name[3:6],
            'minLot':str(s.volume_min),'maxLot':str(s.volume_max),'lotStep':str(s.volume_step),
            'contractSize':str(s.trade_contract_size),'digits':int(s.digits),'pipSize':str(10**(-max(1,int(s.digits)-1)))}

def position(p):
    return {'externalOrderId':str(p.ticket),'instrument':p.symbol,'direction':'BUY' if p.type==mt5.POSITION_TYPE_BUY else 'SELL',
            'lotSize':str(p.volume),'openPrice':str(p.price_open),'currentPrice':str(p.price_current),'stopLoss':str(p.sl or 0),
            'takeProfit':str(p.tp or 0),'unrealizedPnl':str(p.profit),'openedAt':dt.datetime.fromtimestamp(p.time,dt.timezone.utc).isoformat()}

def execute(cmd):
    typ=cmd['commandType']; p=cmd.get('payload') or {}
    a=account()
    if typ=='ACCOUNT_SNAPSHOT':
        return {'accountId':str(a.login),'currency':a.currency,'leverage':int(a.leverage),'balance':str(a.balance),'equity':str(a.equity),
                'margin':str(a.margin),'freeMargin':str(a.margin_free),'marginLevel':str(a.margin_level or 0)}
    if typ in ('LIST_SYMBOLS','GET_SYMBOL_INFO'):
        if typ=='GET_SYMBOL_INFO': return symbol_spec(p['instrument'])
        names=['EURUSD','GBPUSD','USDJPY','USDCAD','AUDUSD','USDCHF']
        return {'instruments':[symbol_spec(n) for n in names if mt5.symbol_info(n)]}
    if typ=='GET_PRICE':
        t=mt5.symbol_info_tick(p['instrument']);
        if not t: raise RuntimeError('No current tick')
        return {'instrument':p['instrument'],'bid':str(t.bid),'ask':str(t.ask),'timestamp':dt.datetime.fromtimestamp(t.time,dt.timezone.utc).isoformat()}
    if typ=='GET_OHLCV':
        tf={'M1':mt5.TIMEFRAME_M1,'M5':mt5.TIMEFRAME_M5,'M15':mt5.TIMEFRAME_M15,'H1':mt5.TIMEFRAME_H1,'H4':mt5.TIMEFRAME_H4}.get(str(p.get('timeframe','M1')).upper(),mt5.TIMEFRAME_M1)
        rows=mt5.copy_rates_from_pos(p['instrument'],tf,0,int(p.get('count',200)))
        if rows is None: raise RuntimeError('OHLCV unavailable')
        return {'bars':[{'timestamp':dt.datetime.fromtimestamp(int(r['time']),dt.timezone.utc).isoformat(),'open':str(r['open']),'high':str(r['high']),'low':str(r['low']),'close':str(r['close']),'volume':str(r['tick_volume'])} for r in rows]}
    if typ=='CALCULATE_MARGIN':
        symbol=p['instrument']; tick=mt5.symbol_info_tick(symbol); direction=p.get('direction','BUY')
        action=mt5.ORDER_TYPE_BUY if direction=='BUY' else mt5.ORDER_TYPE_SELL; price=tick.ask if direction=='BUY' else tick.bid
        m=mt5.order_calc_margin(action,symbol,float(p['lotSize']),price)
        return {'margin':None if m is None else str(m)}
    if typ=='LIST_POSITIONS': return {'positions':[position(x) for x in (mt5.positions_get() or [])]}
    if typ=='LIST_ORDERS': return {'orders':[{'providerOrderId':str(x.ticket),'instrument':x.symbol,'status':'PENDING','raw':None} for x in (mt5.orders_get() or [])]}
    if typ=='GET_ORDER':
        tid=int(p['providerOrderId']); rows=mt5.orders_get(ticket=tid) or []
        return {'order':({'providerOrderId':str(rows[0].ticket),'instrument':rows[0].symbol,'status':'PENDING','raw':None} if rows else None)}
    if typ=='PLACE_ORDER':
        symbol=p['instrument']; direction=p['direction']; info=mt5.symbol_info(symbol); tick=mt5.symbol_info_tick(symbol)
        if not info or not tick: raise RuntimeError('Symbol/tick unavailable')
        if not info.visible: mt5.symbol_select(symbol,True)
        price=tick.ask if direction=='BUY' else tick.bid
        request={'action':mt5.TRADE_ACTION_DEAL,'symbol':symbol,'volume':float(p['lotSize']),'type':mt5.ORDER_TYPE_BUY if direction=='BUY' else mt5.ORDER_TYPE_SELL,
                 'price':price,'sl':float(p['stopLoss']),'tp':float(p['takeProfit']),'deviation':20,'magic':2601027,
                 'comment':('iRexPro '+str(p.get('idempotencyKey','')))[:31],'type_time':mt5.ORDER_TIME_GTC,'type_filling':mt5.ORDER_FILLING_IOC}
        r=mt5.order_send(request)
        if not r or r.retcode not in (mt5.TRADE_RETCODE_DONE, getattr(mt5,'TRADE_RETCODE_PLACED',10008)):
            return {'success':False,'message':None if not r else r.comment,'retcode':None if not r else r.retcode}
        return {'success':True,'ticket':str(r.order or r.deal),'filledPrice':str(r.price or price),'filledQuantity':str(r.volume or p['lotSize']),'filledAt':dt.datetime.now(dt.timezone.utc).isoformat(),'message':r.comment}
    if typ=='MODIFY_ORDER':
        tid=int(p['externalOrderId']); pos=(mt5.positions_get(ticket=tid) or [])
        if not pos: raise RuntimeError('Position not found')
        q={'action':mt5.TRADE_ACTION_SLTP,'position':tid,'symbol':pos[0].symbol,'sl':float(p.get('newStopLoss') or pos[0].sl),'tp':float(p.get('newTakeProfit') or pos[0].tp)}
        r=mt5.order_send(q); return {'success':bool(r and r.retcode==mt5.TRADE_RETCODE_DONE),'message':None if not r else r.comment}
    if typ in ('CLOSE_ORDER','CLOSE_ALL'):
        rows=list(mt5.positions_get() or [])
        if typ=='CLOSE_ORDER': rows=[x for x in rows if str(x.ticket)==str(p['externalOrderId'])]
        closed=0; errors=[]; last=None
        for x in rows:
            tick=mt5.symbol_info_tick(x.symbol); vol=float(p.get('lotSize') or x.volume) if typ=='CLOSE_ORDER' else float(x.volume)
            q={'action':mt5.TRADE_ACTION_DEAL,'position':x.ticket,'symbol':x.symbol,'volume':vol,
               'type':mt5.ORDER_TYPE_SELL if x.type==mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY,
               'price':tick.bid if x.type==mt5.POSITION_TYPE_BUY else tick.ask,'deviation':20,'magic':2601027,'comment':'iRexPro close','type_time':mt5.ORDER_TIME_GTC,'type_filling':mt5.ORDER_FILLING_IOC}
            r=mt5.order_send(q); last=r
            if r and r.retcode==mt5.TRADE_RETCODE_DONE: closed+=1
            else: errors.append(None if not r else r.comment)
        if typ=='CLOSE_ALL': return {'closedCount':closed,'failedCount':len(errors),'errors':[x or 'close failed' for x in errors]}
        return {'success':closed==1,'filledPrice':None if not last else str(last.price),'message':None if not last else last.comment}
    if typ=='GET_HISTORY':
        f=dt.datetime.fromisoformat(str(p['from']).replace('Z','+00:00')); t=dt.datetime.fromisoformat(str(p['to']).replace('Z','+00:00'))
        deals=mt5.history_deals_get(f,t) or []
        return {'trades':[{'externalOrderId':str(x.ticket),'instrument':x.symbol,'realisedPnl':str(x.profit),'commission':str(x.commission),'swap':str(x.swap),'closedAt':dt.datetime.fromtimestamp(x.time,dt.timezone.utc).isoformat()} for x in deals if getattr(x,'entry',None)==getattr(mt5,'DEAL_ENTRY_OUT',1)]}
    raise RuntimeError('Unsupported command '+typ)

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--api-base',required=True); ap.add_argument('--pairing-code'); ap.add_argument('--state',default='irexpro-mt5-connector.json'); args=ap.parse_args()
    if not mt5.initialize(): raise RuntimeError('Could not initialize local MetaTrader 5 terminal')
    a=account(); identity={'accountLogin':str(a.login),'brokerServer':a.server,'accountType':'DEMO'}
    if args.pairing_code:
        out=req(args.api_base,'broker/direct-mt5/connectors/redeem',{**identity,'pairingCode':args.pairing_code,'currency':a.currency,'tradeAllowed':bool(a.trade_allowed)})
        state={**identity,**out}; open(args.state,'w').write(json.dumps(state)); print('Paired direct MT5 DEMO connector.')
    else:
        state=json.load(open(args.state))
    seq=0
    while True:
        try:
            a=account(); seq+=1
            ident={'brokerConnectionId':state['brokerConnectionId'],'accountLogin':str(a.login),'brokerServer':a.server,'accountType':'DEMO'}
            req(args.api_base,f"broker/direct-mt5/connectors/{state['connectorId']}/heartbeat",{**ident,'sequence':seq,'terminalConnected':True,'tradingAllowed':bool(a.trade_allowed)},state['connectorToken'])
            cmd=req(args.api_base,f"broker/direct-mt5/connectors/{state['connectorId']}/commands/lease",ident,state['connectorToken'])
            if cmd:
                try: result=execute(cmd); status='SUCCEEDED'; err=None
                except Exception as e: result=None; status='FAILED'; err=str(e)[:500]
                req(args.api_base,f"broker/direct-mt5/connectors/{state['connectorId']}/commands/{cmd['commandId']}/result",{**ident,'state':status,'result':result,'error':err},state['connectorToken'])
        except KeyboardInterrupt: break
        except Exception as e: print('connector warning:',e,file=sys.stderr)
        time.sleep(1)
if __name__=='__main__': main()
