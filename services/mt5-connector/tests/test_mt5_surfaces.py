from types import SimpleNamespace
from datetime import datetime, timezone

from irexpro_mt5_connector.main import _dispatch
from irexpro_mt5_connector.mt5_terminal import MetaQuotesMt5Terminal
from irexpro_mt5_connector.protocol import COMMAND_TYPES


def ns(**kwargs):
    return SimpleNamespace(**kwargs)


class SurfaceFakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    ACCOUNT_TRADE_MODE_REAL = 2
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TYPE_BUY_STOP_LIMIT = 6
    ORDER_TYPE_SELL_STOP_LIMIT = 7
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_STATE_STARTED = 0
    ORDER_STATE_PLACED = 1
    ORDER_STATE_CANCELED = 2
    ORDER_STATE_PARTIAL = 3
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 5
    ORDER_STATE_EXPIRED = 6
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_INOUT = 2
    DEAL_ENTRY_OUT_BY = 3
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_REASON_SL = 4
    DEAL_REASON_TP = 5
    DEAL_REASON_CLIENT = 0
    DEAL_REASON_EXPERT = 3
    TRADE_ACTION_DEAL = 1
    TRADE_ACTION_SLTP = 6
    ORDER_TIME_GTC = 0
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240
    TIMEFRAME_D1 = 1440

    def __init__(self):
        self.sent = []
        self.account = ns(
            login=12345, server="Broker-Live", currency="USD", trade_mode=2,
            trade_allowed=True, trade_expert=True, leverage=100,
            balance=10000.5, equity=10020.25, margin=200.0, margin_free=9820.25, margin_level=5010.125,
        )
        self.terminal = ns(trade_allowed=True)
        self.symbol = ns(
            name="EURUSD", description="Euro vs US Dollar", digits=5, visible=True,
            volume_min=0.01, volume_max=100.0, volume_step=0.01, trade_contract_size=100000.0,
            filling_mode=0, trade_exemode=0,
        )
        self.tick = ns(bid=1.0842, ask=1.08435, last=1.0843, time_msc=1793440800123)
        self.position = ns(
            ticket=9001, identifier=9001, time=1793440000, type=0, magic=9110506, volume=0.2,
            price_open=1.083, price_current=1.0842, sl=1.08, tp=1.09, swap=-0.12, profit=24.0,
            symbol="EURUSD", comment="irexpro:intent-1",
        )
        self.order = ns(
            ticket=8001, time_setup=1793440000, time_setup_msc=1793440000123, type=2, state=1,
            magic=9110506, position_id=0, volume_initial=0.2, volume_current=0.2,
            price_open=1.08, price_stoplimit=0.0, price_current=1.0842, sl=1.075, tp=1.09,
            symbol="EURUSD", comment="irexpro:pending-1",
        )

    def account_info(self): return self.account
    def terminal_info(self): return self.terminal
    def symbol_info(self, symbol): return self.symbol if symbol == "EURUSD" else None
    def symbol_select(self, symbol, visible): return True
    def symbol_info_tick(self, symbol): return self.tick
    def symbols_get(self): return (self.symbol,)
    def positions_get(self, **kwargs):
        if "ticket" in kwargs and int(kwargs["ticket"]) != int(self.position.ticket): return ()
        return (self.position,)
    def orders_get(self, **kwargs):
        if "ticket" in kwargs and int(kwargs["ticket"]) != int(self.order.ticket): return ()
        return (self.order,)
    def history_orders_get(self, *args, **kwargs):
        if kwargs.get("ticket") == 8001: return (ns(**{**self.order.__dict__, "state": 4, "position_id": 9001}),)
        return ()
    def history_deals_get(self, *args, **kwargs):
        return (
            ns(ticket=7001, order=7000, position_id=9001, time=1793440000, time_msc=1793440000000,
               type=0, entry=0, reason=3, volume=0.2, price=1.083, commission=-0.4, swap=0.0,
               profit=0.0, symbol="EURUSD", comment="irexpro"),
            ns(ticket=7002, order=7003, position_id=9001, time=1793440600, time_msc=1793440600000,
               type=1, entry=1, reason=5, volume=0.2, price=1.085, commission=-0.4, swap=-0.1,
               profit=40.0, symbol="EURUSD", comment="irexpro"),
        )
    def copy_rates_from_pos(self, symbol, timeframe, start, count):
        return [{"time": 1793440000, "open": 1.083, "high": 1.085, "low": 1.0825, "close": 1.084,
                 "tick_volume": 120, "spread": 12, "real_volume": 0}]
    def copy_rates_from(self, symbol, timeframe, before, count): return self.copy_rates_from_pos(symbol, timeframe, 0, count)
    def order_calc_margin(self, order_type, symbol, volume, price): return 216.87
    def order_check(self, request): return ns(retcode=0)
    def order_send(self, request):
        self.sent.append(request)
        if request.get("action") == self.TRADE_ACTION_SLTP:
            return ns(retcode=10009, order=request.get("position", 9001), deal=0, volume=0.0, price=0.0, comment="done")
        return ns(retcode=10009, order=9001, deal=7001, volume=request.get("volume", 0.2), price=1.08435, comment="done")
    def last_error(self): return (0, "ok")


def terminal():
    t = MetaQuotesMt5Terminal()
    t._mt5 = SurfaceFakeMt5()
    return t


def test_python_protocol_matches_server_declared_surface() -> None:
    assert "LIST_SYMBOLS" in COMMAND_TYPES
    assert "GET_SYMBOL_INFO" in COMMAND_TYPES
    assert {"GET_OHLCV", "GET_ORDER", "GET_HISTORY", "CLOSE_ALL"}.issubset(set(COMMAND_TYPES))


def test_terminal_normalizes_account_price_symbols_candles_positions_and_orders() -> None:
    t = terminal()
    account = t.account_snapshot()
    assert account["accountId"] == "12345"
    assert account["accountType"] == "LIVE"
    assert account["freeMargin"] == "9820.25"

    price = t.current_price("EURUSD")
    assert price["instrument"] == "EURUSD"
    assert price["bid"] == "1.0842"
    assert price["ask"] == "1.08435"
    assert price["spread"] == "0.00015"
    assert price["timestamp"].endswith("+00:00")

    instruments = t.list_symbols()
    assert instruments == [{
        "symbol": "EURUSD", "description": "Euro vs US Dollar", "digits": 5,
        "minLot": "0.01", "maxLot": "100.0", "lotStep": "0.01", "contractSize": "100000.0",
    }]
    assert t.symbol_info("EURUSD")["symbol"] == "EURUSD"

    bars = t.get_ohlcv("EURUSD", "M5", 1)
    assert bars[0]["open"] == "1.083"
    assert bars[0]["tickVolume"] == "120"
    assert bars[0]["spreadPoints"] == "12"
    assert bars[0]["priceDigits"] == 5

    positions = t.list_positions()
    assert positions[0]["externalOrderId"] == "9001"
    assert positions[0]["direction"] == "BUY"
    assert positions[0]["lotSize"] == "0.2"

    orders = t.list_orders()
    assert orders[0]["providerOrderId"] == "8001"
    assert orders[0]["status"] == "WORKING"
    assert orders[0]["orderKind"] == "LIMIT"
    assert t.get_order("8001")["providerOrderId"] == "8001"


def test_terminal_normalizes_mutations_close_all_and_closed_trade_history() -> None:
    t = terminal()
    placed = t.place_order({
        "symbol": "EURUSD", "side": "BUY", "volume": "0.20", "stopLoss": "1.0800", "takeProfit": "1.0900",
        "comment": "irexpro:intent-1",
    })
    assert placed["success"] is True
    assert placed["ticket"] == "9001"
    assert placed["filledPrice"] == "1.08435"
    assert placed["filledQuantity"] == "0.2"

    modified = t.modify_order({"externalOrderId": "9001", "newStopLoss": "1.0810", "newTakeProfit": "1.0910"})
    assert modified["success"] is True

    closed = t.close_order({"externalOrderId": "9001", "lotSize": "0.20"})
    assert closed["success"] is True
    assert closed["externalOrderId"] == "9001"

    all_result = t.close_all()
    assert all_result["closedCount"] == 1
    assert all_result["failedCount"] == 0

    history = t.get_history(datetime(2026, 10, 31, tzinfo=timezone.utc), datetime(2026, 11, 1, tzinfo=timezone.utc))
    assert len(history) == 1
    trade = history[0]
    assert trade["externalOrderId"] == "9001"
    assert trade["direction"] == "BUY"
    assert trade["realisedPnl"] == "40.0"
    assert trade["commission"] == "-0.8"
    assert trade["swap"] == "-0.1"
    assert trade["closeReason"] == "TP"


def test_dispatch_translates_server_normalized_payloads_and_all_declared_commands() -> None:
    class RecordingTerminal:
        def __init__(self): self.calls = []
        def account_snapshot(self): return {"accountId": "1"}
        def current_price(self, symbol): self.calls.append(("price", symbol)); return {"instrument": symbol}
        def get_ohlcv(self, symbol, timeframe, count, before=None): self.calls.append(("ohlcv", symbol, timeframe, count, before)); return []
        def list_symbols(self): return []
        def symbol_info(self, symbol): return {"symbol": symbol}
        def calculate_margin(self, symbol, side, volume): self.calls.append(("margin", symbol, side, volume)); return {"margin": "1"}
        def list_positions(self): return []
        def list_orders(self): return []
        def get_order(self, ticket): return {"providerOrderId": str(ticket)}
        def get_history(self, date_from, date_to): return []
        def place_order(self, payload): self.calls.append(("place", payload)); return {"success": True, "ticket": "1"}
        def modify_order(self, payload): return {"success": True}
        def close_order(self, payload): return {"success": True}
        def close_all(self): return {"closedCount": 0, "failedCount": 0, "errors": []}

    t = RecordingTerminal()
    assert _dispatch(t, "GET_PRICE", {"instrument": "EURUSD"})["instrument"] == "EURUSD"
    assert _dispatch(t, "GET_OHLCV", {"instrument": "EURUSD", "timeframe": "M5", "count": 10}) == {"bars": []}
    assert _dispatch(t, "LIST_SYMBOLS", {}) == {"instruments": []}
    assert _dispatch(t, "GET_SYMBOL_INFO", {"instrument": "EURUSD"}) == {"instrument": {"symbol": "EURUSD"}}
    assert _dispatch(t, "CALCULATE_MARGIN", {"instrument": "EURUSD", "direction": "SELL", "lotSize": "0.30"}) == {"margin": "1"}
    assert _dispatch(t, "LIST_POSITIONS", {}) == {"positions": []}
    assert _dispatch(t, "LIST_ORDERS", {}) == {"orders": []}
    assert _dispatch(t, "GET_ORDER", {"providerOrderId": "8001"}) == {"order": {"providerOrderId": "8001"}}
    assert _dispatch(t, "CLOSE_ALL", {})["closedCount"] == 0
    placed = _dispatch(t, "PLACE_ORDER", {"instrument": "EURUSD", "direction": "BUY", "lotSize": "0.20", "stopLoss": "1.08", "takeProfit": "1.09", "idempotencyKey": "intent-1"})
    assert placed["ticket"] == "1"
    place_payload = [c for c in t.calls if c[0] == "place"][0][1]
    assert place_payload["symbol"] == "EURUSD"
    assert place_payload["side"] == "BUY"
    assert place_payload["volume"] == "0.20"
    assert place_payload["comment"].startswith("irexpro:")
