from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Mapping, Protocol


class Mt5TerminalError(RuntimeError):
    pass


@dataclass(frozen=True)
class AccountIdentity:
    login: str
    server: str
    currency: str | None
    trade_allowed: bool
    account_type: str


class TerminalPort(Protocol):
    def initialize(self) -> AccountIdentity: ...
    def identity(self) -> AccountIdentity: ...
    def shutdown(self) -> None: ...
    def account_snapshot(self) -> dict[str, Any]: ...
    def current_price(self, symbol: str) -> dict[str, Any]: ...
    def get_ohlcv(self, symbol: str, timeframe: str, count: int, before: datetime | None = None) -> list[dict[str, Any]]: ...
    def list_symbols(self) -> list[dict[str, Any]]: ...
    def symbol_info(self, symbol: str) -> dict[str, Any]: ...
    def calculate_margin(self, symbol: str, side: str, volume: str) -> dict[str, Any]: ...
    def list_positions(self) -> list[dict[str, Any]]: ...
    def list_orders(self) -> list[dict[str, Any]]: ...
    def get_order(self, ticket: str) -> dict[str, Any] | None: ...
    def get_history(self, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]: ...
    def place_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def modify_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def close_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def close_all(self) -> dict[str, Any]: ...


def _object_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "_asdict"):
        return dict(value._asdict())
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    raise Mt5TerminalError("MetaTrader returned an unsupported response shape")


def _field(value: Any, key: str, default: Any = None) -> Any:
    if isinstance(value, Mapping):
        return value.get(key, default)
    try:
        return value[key]
    except (KeyError, IndexError, TypeError):
        return getattr(value, key, default)


def _num(value: Any, default: str = "0") -> str:
    return default if value is None else str(value)


def _iso_seconds(value: Any) -> str:
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError) as exc:
        raise Mt5TerminalError(f"MetaTrader returned an invalid timestamp: {value!r}") from exc


def _iso_millis(value: Any) -> str:
    try:
        return datetime.fromtimestamp(float(value) / 1000.0, tz=timezone.utc).isoformat()
    except (TypeError, ValueError, OSError) as exc:
        raise Mt5TerminalError(f"MetaTrader returned an invalid millisecond timestamp: {value!r}") from exc


class MetaQuotesMt5Terminal:
    """Production terminal port using MetaQuotes' official MetaTrader5 package.

    iRexPro never receives the broker password. The Windows MT5 terminal is
    already logged in and this connector attaches to that local session.
    """

    MAGIC = 9110506

    def __init__(self, terminal_path: str | None = None, deviation_points: int = 20) -> None:
        self.terminal_path = terminal_path
        self.deviation_points = deviation_points
        self._mt5: Any | None = None

    def _module(self) -> Any:
        if self._mt5 is None:
            try:
                import MetaTrader5 as mt5  # type: ignore[import-not-found]
            except ImportError as exc:
                raise Mt5TerminalError(
                    "MetaTrader5 Python package is unavailable; run the connector on Windows with MT5 installed"
                ) from exc
            self._mt5 = mt5
        return self._mt5

    def initialize(self) -> AccountIdentity:
        mt5 = self._module()
        ok = mt5.initialize(self.terminal_path) if self.terminal_path else mt5.initialize()
        if not ok:
            raise Mt5TerminalError(f"MT5 initialize failed: {mt5.last_error()}")
        try:
            return self.identity()
        except Exception:
            mt5.shutdown()
            raise

    def _account_type(self, account: Any) -> str:
        mt5 = self._module()
        trade_mode = int(getattr(account, "trade_mode", -1))
        if trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)):
            return "DEMO"
        if trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2)):
            return "LIVE"
        if trade_mode == int(getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1)):
            raise Mt5TerminalError("MT5 CONTEST accounts are not supported for iRexPro automated trading")
        raise Mt5TerminalError(f"MT5 reported an unknown account trade mode: {trade_mode}")

    def identity(self) -> AccountIdentity:
        mt5 = self._module()
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        if account is None or terminal is None:
            raise Mt5TerminalError("MT5 terminal is not logged into a trading account")
        trade_allowed = bool(
            getattr(terminal, "trade_allowed", False)
            and getattr(account, "trade_allowed", False)
            and getattr(account, "trade_expert", False)
        )
        return AccountIdentity(
            login=str(account.login),
            server=str(account.server),
            currency=str(account.currency) if account.currency else None,
            trade_allowed=trade_allowed,
            account_type=self._account_type(account),
        )

    def shutdown(self) -> None:
        if self._mt5 is not None:
            self._mt5.shutdown()

    def account_snapshot(self) -> dict[str, Any]:
        mt5 = self._module()
        info = mt5.account_info()
        terminal = mt5.terminal_info()
        if info is None or terminal is None:
            raise Mt5TerminalError(f"MT5 account unavailable: {mt5.last_error()}")
        account_type = self._account_type(info)
        return {
            "accountId": str(info.login),
            "login": str(info.login),
            "server": str(info.server),
            "accountType": account_type,
            "currency": str(info.currency) if info.currency else None,
            "leverage": int(info.leverage),
            "balance": _num(info.balance),
            "equity": _num(info.equity),
            "margin": _num(info.margin),
            "freeMargin": _num(info.margin_free),
            "marginLevel": _num(info.margin_level),
            "tradeAllowed": bool(
                getattr(terminal, "trade_allowed", False)
                and getattr(info, "trade_allowed", False)
                and getattr(info, "trade_expert", False)
            ),
            "observedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _ensure_symbol(self, symbol: str) -> Any:
        mt5 = self._module()
        info = mt5.symbol_info(symbol)
        if info is None:
            raise Mt5TerminalError(f"MT5 symbol not found: {symbol}")
        if not bool(getattr(info, "visible", True)) and not mt5.symbol_select(symbol, True):
            raise Mt5TerminalError(f"MT5 symbol cannot be selected: {symbol}")
        return info

    def _normalize_symbol(self, info: Any) -> dict[str, Any]:
        return {
            "symbol": str(getattr(info, "name", "")),
            "description": str(getattr(info, "description", "") or ""),
            "digits": int(getattr(info, "digits", 0)),
            "minLot": _num(getattr(info, "volume_min", 0)),
            "maxLot": _num(getattr(info, "volume_max", 0)),
            "lotStep": _num(getattr(info, "volume_step", 0)),
            "contractSize": _num(getattr(info, "trade_contract_size", 0)),
        }

    def list_symbols(self) -> list[dict[str, Any]]:
        mt5 = self._module()
        values = mt5.symbols_get()
        if values is None:
            raise Mt5TerminalError(f"MT5 symbol list failed: {mt5.last_error()}")
        return [self._normalize_symbol(value) for value in values]

    def symbol_info(self, symbol: str) -> dict[str, Any]:
        return self._normalize_symbol(self._ensure_symbol(symbol))

    def current_price(self, symbol: str) -> dict[str, Any]:
        mt5 = self._module()
        self._ensure_symbol(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise Mt5TerminalError(f"MT5 tick unavailable for {symbol}: {mt5.last_error()}")
        bid = Decimal(str(tick.bid))
        ask = Decimal(str(tick.ask))
        timestamp = _iso_millis(getattr(tick, "time_msc", int(datetime.now(timezone.utc).timestamp() * 1000)))
        return {
            "instrument": symbol,
            "bid": str(bid),
            "ask": str(ask),
            "spread": str(ask - bid),
            "timestamp": timestamp,
        }

    def _timeframe(self, timeframe: str) -> Any:
        mt5 = self._module()
        key = timeframe.strip().upper()
        names = {
            "M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15",
            "M30": "TIMEFRAME_M30", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4",
            "D1": "TIMEFRAME_D1",
        }
        name = names.get(key)
        if not name or not hasattr(mt5, name):
            raise Mt5TerminalError(f"Unsupported MT5 timeframe: {timeframe}")
        return getattr(mt5, name)

    def get_ohlcv(
        self,
        symbol: str,
        timeframe: str,
        count: int,
        before: datetime | None = None,
    ) -> list[dict[str, Any]]:
        if count <= 0 or count > 10_000:
            raise Mt5TerminalError("OHLCV count must be between 1 and 10000")
        mt5 = self._module()
        info = self._ensure_symbol(symbol)
        tf = self._timeframe(timeframe)
        if before is None:
            values = mt5.copy_rates_from_pos(symbol, tf, 0, count)
        else:
            when = before if before.tzinfo else before.replace(tzinfo=timezone.utc)
            values = mt5.copy_rates_from(symbol, tf, when.astimezone(timezone.utc), count)
        if values is None:
            raise Mt5TerminalError(f"MT5 OHLCV read failed for {symbol}: {mt5.last_error()}")
        digits = int(getattr(info, "digits", 0))
        bars: list[dict[str, Any]] = []
        for row in values:
            bars.append({
                "timestamp": _iso_seconds(_field(row, "time")),
                "open": _num(_field(row, "open")),
                "high": _num(_field(row, "high")),
                "low": _num(_field(row, "low")),
                "close": _num(_field(row, "close")),
                "volume": _num(_field(row, "tick_volume", 0)),
                "tickVolume": _num(_field(row, "tick_volume", 0)),
                "tradeVolume": _num(_field(row, "real_volume", 0)),
                "spreadPoints": _num(_field(row, "spread", 0)),
                "priceDigits": digits,
            })
        return bars

    def calculate_margin(self, symbol: str, side: str, volume: str) -> dict[str, Any]:
        mt5 = self._module()
        self._ensure_symbol(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise Mt5TerminalError(f"MT5 tick unavailable for {symbol}")
        side_upper = side.upper()
        if side_upper not in {"BUY", "SELL"}:
            raise Mt5TerminalError("side must be BUY or SELL")
        order_type = mt5.ORDER_TYPE_BUY if side_upper == "BUY" else mt5.ORDER_TYPE_SELL
        price = tick.ask if side_upper == "BUY" else tick.bid
        margin = mt5.order_calc_margin(order_type, symbol, float(volume), price)
        if margin is None:
            raise Mt5TerminalError(f"MT5 margin calculation failed: {mt5.last_error()}")
        return {"symbol": symbol, "side": side_upper, "volume": volume, "margin": _num(margin)}

    def _position(self, value: Any) -> dict[str, Any]:
        mt5 = self._module()
        side = "BUY" if int(getattr(value, "type", -1)) == int(mt5.POSITION_TYPE_BUY) else "SELL"
        return {
            "externalOrderId": str(value.ticket),
            "instrument": str(value.symbol),
            "direction": side,
            "lotSize": _num(value.volume),
            "openPrice": _num(value.price_open),
            "currentPrice": _num(value.price_current),
            "stopLoss": _num(getattr(value, "sl", 0)),
            "takeProfit": _num(getattr(value, "tp", 0)),
            "unrealisedPnl": _num(getattr(value, "profit", 0)),
            "openedAt": _iso_seconds(getattr(value, "time", 0)),
            "commission": "0",
            "swap": _num(getattr(value, "swap", 0)),
        }

    def list_positions(self) -> list[dict[str, Any]]:
        mt5 = self._module()
        values = mt5.positions_get()
        if values is None:
            raise Mt5TerminalError(f"MT5 positions read failed: {mt5.last_error()}")
        return [self._position(value) for value in values]

    def _order_kind_and_side(self, value: Any) -> tuple[str | None, str]:
        mt5 = self._module()
        order_type = int(getattr(value, "type", -1))
        pairs = {
            int(mt5.ORDER_TYPE_BUY): ("MARKET", "BUY"),
            int(mt5.ORDER_TYPE_SELL): ("MARKET", "SELL"),
            int(getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2)): ("LIMIT", "BUY"),
            int(getattr(mt5, "ORDER_TYPE_SELL_LIMIT", 3)): ("LIMIT", "SELL"),
            int(getattr(mt5, "ORDER_TYPE_BUY_STOP", 4)): ("STOP", "BUY"),
            int(getattr(mt5, "ORDER_TYPE_SELL_STOP", 5)): ("STOP", "SELL"),
            int(getattr(mt5, "ORDER_TYPE_BUY_STOP_LIMIT", 6)): ("STOP_LIMIT", "BUY"),
            int(getattr(mt5, "ORDER_TYPE_SELL_STOP_LIMIT", 7)): ("STOP_LIMIT", "SELL"),
        }
        return pairs.get(order_type, (None, "BUY"))

    def _order_status(self, value: Any) -> str:
        mt5 = self._module()
        state = int(getattr(value, "state", -1))
        if state == int(getattr(mt5, "ORDER_STATE_PARTIAL", 3)):
            return "PARTIALLY_FILLED"
        if state == int(getattr(mt5, "ORDER_STATE_FILLED", 4)):
            return "FILLED"
        if state == int(getattr(mt5, "ORDER_STATE_CANCELED", 2)):
            return "CANCELLED"
        if state == int(getattr(mt5, "ORDER_STATE_REJECTED", 5)):
            return "REJECTED"
        if state == int(getattr(mt5, "ORDER_STATE_EXPIRED", 6)):
            return "EXPIRED"
        if state in {
            int(getattr(mt5, "ORDER_STATE_STARTED", 0)),
            int(getattr(mt5, "ORDER_STATE_PLACED", 1)),
            int(getattr(mt5, "ORDER_STATE_REQUEST_ADD", 7)),
            int(getattr(mt5, "ORDER_STATE_REQUEST_MODIFY", 8)),
            int(getattr(mt5, "ORDER_STATE_REQUEST_CANCEL", 9)),
        }:
            return "WORKING"
        return "UNKNOWN"

    def _order(self, value: Any) -> dict[str, Any]:
        kind, side = self._order_kind_and_side(value)
        initial = Decimal(str(getattr(value, "volume_initial", 0)))
        current = Decimal(str(getattr(value, "volume_current", 0)))
        filled = max(Decimal("0"), initial - current)
        setup_msc = getattr(value, "time_setup_msc", 0)
        setup = _iso_millis(setup_msc) if setup_msc else _iso_seconds(getattr(value, "time_setup", 0))
        update_msc = getattr(value, "time_done_msc", 0) or getattr(value, "time_setup_msc", 0)
        update = _iso_millis(update_msc) if update_msc else setup
        price_open = _num(getattr(value, "price_open", 0))
        price_stoplimit = _num(getattr(value, "price_stoplimit", 0))
        return {
            "providerOrderId": str(value.ticket),
            "providerPositionId": str(getattr(value, "position_id", 0)) if getattr(value, "position_id", 0) else None,
            "clientOrderId": str(getattr(value, "comment", "") or "") or None,
            "status": self._order_status(value),
            "instrument": str(getattr(value, "symbol", "")),
            "direction": side,
            "requestedQuantity": str(initial),
            "filledQuantity": str(filled),
            "avgFillPrice": _num(getattr(value, "price_current", 0)) if filled > 0 else None,
            "orderKind": kind,
            "limitPrice": price_stoplimit if kind == "STOP_LIMIT" else (price_open if kind == "LIMIT" else None),
            "stopPrice": price_open if kind in {"STOP", "STOP_LIMIT"} else None,
            "timeInForce": "GTC",
            "placedAt": setup,
            "updatedAt": update,
        }

    def list_orders(self) -> list[dict[str, Any]]:
        mt5 = self._module()
        values = mt5.orders_get()
        if values is None:
            raise Mt5TerminalError(f"MT5 orders read failed: {mt5.last_error()}")
        return [self._order(value) for value in values]

    def get_order(self, ticket: str) -> dict[str, Any] | None:
        mt5 = self._module()
        try:
            numeric = int(ticket)
        except ValueError as exc:
            raise Mt5TerminalError("MT5 order ticket must be numeric") from exc
        active = mt5.orders_get(ticket=numeric)
        if active:
            return self._order(active[0])
        history = mt5.history_orders_get(ticket=numeric)
        if history is None:
            raise Mt5TerminalError(f"MT5 order history read failed: {mt5.last_error()}")
        return self._order(history[0]) if history else None

    def _filling_type(self, info: Any) -> Any | None:
        mt5 = self._module()
        allowed = int(getattr(info, "filling_mode", 0) or 0)
        symbol_ioc = int(getattr(mt5, "SYMBOL_FILLING_IOC", 2))
        symbol_fok = int(getattr(mt5, "SYMBOL_FILLING_FOK", 1))
        if allowed & symbol_ioc and hasattr(mt5, "ORDER_FILLING_IOC"):
            return mt5.ORDER_FILLING_IOC
        if allowed & symbol_fok and hasattr(mt5, "ORDER_FILLING_FOK"):
            return mt5.ORDER_FILLING_FOK
        # Omit when provider metadata is inconclusive; MT5/provider then applies
        # its native/default policy rather than us guessing an unsupported mode.
        return None

    def _market_request(self, payload: dict[str, Any], *, position: int | None = None) -> dict[str, Any]:
        mt5 = self._module()
        symbol = str(payload["symbol"])
        side = str(payload["side"]).upper()
        if side not in {"BUY", "SELL"}:
            raise Mt5TerminalError("side must be BUY or SELL")
        info = self._ensure_symbol(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise Mt5TerminalError(f"MT5 tick unavailable for {symbol}")
        order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        price = tick.ask if side == "BUY" else tick.bid
        request: dict[str, Any] = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": symbol,
            "volume": float(payload["volume"]),
            "type": order_type,
            "price": price,
            "deviation": self.deviation_points,
            "magic": self.MAGIC,
            "comment": str(payload.get("comment", "irexpro"))[:31],
            "type_time": mt5.ORDER_TIME_GTC,
        }
        filling = self._filling_type(info)
        if filling is not None:
            request["type_filling"] = filling
        if position is not None:
            request["position"] = position
        if payload.get("stopLoss") not in (None, ""):
            request["sl"] = float(payload["stopLoss"])
        if payload.get("takeProfit") not in (None, ""):
            request["tp"] = float(payload["takeProfit"])
        return request

    def _checked_result(self, result: Any, action: str) -> dict[str, Any]:
        mt5 = self._module()
        if result is None:
            raise Mt5TerminalError(f"MT5 {action} failed: {mt5.last_error()}")
        data = _object_dict(result)
        if int(data.get("retcode", -1)) not in {10008, 10009, 10010}:
            raise Mt5TerminalError(f"MT5 {action} rejected: {data}")
        return data

    def place_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        request = self._market_request(payload)
        checked = mt5.order_check(request)
        if checked is None or int(getattr(checked, "retcode", -1)) != 0:
            detail = _object_dict(checked) if checked is not None else {"error": mt5.last_error()}
            raise Mt5TerminalError(f"MT5 order_check rejected request: {detail}")
        data = self._checked_result(mt5.order_send(request), "order")
        ticket = data.get("order") or data.get("deal")
        if not ticket:
            raise Mt5TerminalError("MT5 accepted the order but returned no stable order ticket")
        return {
            "success": True,
            "ticket": str(ticket),
            "filledPrice": _num(data.get("price")),
            "filledQuantity": _num(data.get("volume", payload.get("volume"))),
            "filledAt": datetime.now(timezone.utc).isoformat(),
            "message": str(data.get("comment", "")),
            "providerDealId": str(data.get("deal")) if data.get("deal") else None,
        }

    def modify_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        ticket = payload.get("positionTicket", payload.get("externalOrderId"))
        if ticket is None:
            raise Mt5TerminalError("position ticket is required")
        position = int(ticket)
        positions = mt5.positions_get(ticket=position)
        if not positions:
            raise Mt5TerminalError(f"MT5 position not found: {position}")
        existing = positions[0]
        stop_loss = payload.get("newStopLoss", payload.get("stopLoss", getattr(existing, "sl", 0.0)))
        take_profit = payload.get("newTakeProfit", payload.get("takeProfit", getattr(existing, "tp", 0.0)))
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": position,
            "symbol": existing.symbol,
            "sl": float(stop_loss or 0.0),
            "tp": float(take_profit or 0.0),
            "magic": self.MAGIC,
        }
        data = self._checked_result(mt5.order_send(request), "modify")
        return {
            "success": True,
            "ticket": str(position),
            "externalOrderId": str(position),
            "message": str(data.get("comment", "")),
        }

    def close_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        raw_ticket = payload.get("positionTicket", payload.get("externalOrderId"))
        if raw_ticket is None:
            raise Mt5TerminalError("position ticket is required")
        ticket = int(raw_ticket)
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            raise Mt5TerminalError(f"MT5 position not found: {ticket}")
        position = positions[0]
        close_side = "SELL" if int(position.type) == int(mt5.POSITION_TYPE_BUY) else "BUY"
        volume = payload.get("volume", payload.get("lotSize", position.volume))
        request_payload = {
            "symbol": position.symbol,
            "side": close_side,
            "volume": str(volume),
            "comment": str(payload.get("comment", "irexpro-close")),
        }
        data = self._checked_result(mt5.order_send(self._market_request(request_payload, position=ticket)), "close")
        # Close economics are reconciled from authoritative deal history; do not guess them here.
        realised = None
        return {
            "success": True,
            "ticket": str(ticket),
            "externalOrderId": str(ticket),
            "filledPrice": _num(data.get("price")),
            "filledQuantity": _num(data.get("volume", volume)),
            "filledAt": datetime.now(timezone.utc).isoformat(),
            "realisedPnl": str(realised) if realised is not None else None,
            "message": str(data.get("comment", "")),
        }

    def close_all(self) -> dict[str, Any]:
        mt5 = self._module()
        positions = mt5.positions_get()
        if positions is None:
            raise Mt5TerminalError(f"MT5 positions read failed: {mt5.last_error()}")
        closed = 0
        errors: list[str] = []
        for position in list(positions):
            try:
                self.close_order({"externalOrderId": str(position.ticket), "lotSize": _num(position.volume)})
                closed += 1
            except Exception as exc:
                errors.append(f"position {position.ticket}: {exc}")
        return {"closedCount": closed, "failedCount": len(errors), "errors": errors}

    def _close_reason(self, reason: int) -> str:
        mt5 = self._module()
        if reason == int(getattr(mt5, "DEAL_REASON_TP", -100)):
            return "TP"
        if reason == int(getattr(mt5, "DEAL_REASON_SL", -101)):
            return "SL"
        if reason in {
            int(getattr(mt5, "DEAL_REASON_CLIENT", -102)),
            int(getattr(mt5, "DEAL_REASON_MOBILE", -103)),
            int(getattr(mt5, "DEAL_REASON_WEB", -104)),
        }:
            return "MANUAL"
        if reason == int(getattr(mt5, "DEAL_REASON_EXPERT", -105)):
            return "SYSTEM"
        return "UNKNOWN"

    def get_history(self, date_from: datetime, date_to: datetime) -> list[dict[str, Any]]:
        mt5 = self._module()
        start = date_from if date_from.tzinfo else date_from.replace(tzinfo=timezone.utc)
        end = date_to if date_to.tzinfo else date_to.replace(tzinfo=timezone.utc)
        deals = mt5.history_deals_get(start.astimezone(timezone.utc), end.astimezone(timezone.utc))
        if deals is None:
            raise Mt5TerminalError(f"MT5 deal history read failed: {mt5.last_error()}")
        grouped: dict[str, list[Any]] = {}
        for deal in deals:
            position_id = str(getattr(deal, "position_id", 0))
            if position_id == "0":
                continue
            grouped.setdefault(position_id, []).append(deal)

        trades: list[dict[str, Any]] = []
        entry_in = int(getattr(mt5, "DEAL_ENTRY_IN", 0))
        entry_out = int(getattr(mt5, "DEAL_ENTRY_OUT", 1))
        entry_inout = int(getattr(mt5, "DEAL_ENTRY_INOUT", 2))
        entry_out_by = int(getattr(mt5, "DEAL_ENTRY_OUT_BY", 3))
        for position_id, items in grouped.items():
            ordered = sorted(items, key=lambda d: (int(getattr(d, "time_msc", 0)), int(getattr(d, "ticket", 0))))
            entries = [d for d in ordered if int(getattr(d, "entry", -1)) in {entry_in, entry_inout}]
            exits = [d for d in ordered if int(getattr(d, "entry", -1)) in {entry_out, entry_out_by, entry_inout}]
            if not entries or not exits:
                continue
            first = entries[0]
            last = exits[-1]
            direction = "BUY" if int(getattr(first, "type", -1)) == int(getattr(mt5, "DEAL_TYPE_BUY", 0)) else "SELL"
            entry_volume = sum(Decimal(str(getattr(d, "volume", 0))) for d in entries)
            exit_volume = sum(Decimal(str(getattr(d, "volume", 0))) for d in exits)
            open_price = (
                sum(Decimal(str(getattr(d, "price", 0))) * Decimal(str(getattr(d, "volume", 0))) for d in entries) / entry_volume
                if entry_volume > 0 else Decimal("0")
            )
            close_price = (
                sum(Decimal(str(getattr(d, "price", 0))) * Decimal(str(getattr(d, "volume", 0))) for d in exits) / exit_volume
                if exit_volume > 0 else Decimal("0")
            )
            trades.append({
                "externalOrderId": position_id,
                "instrument": str(getattr(first, "symbol", "")),
                "direction": direction,
                "lotSize": str(exit_volume),
                "openPrice": str(open_price),
                "closePrice": str(close_price),
                "stopLoss": "0",
                "takeProfit": "0",
                "realisedPnl": str(sum(Decimal(str(getattr(d, "profit", 0))) for d in ordered)),
                "openedAt": _iso_seconds(getattr(first, "time", 0)),
                "closedAt": _iso_seconds(getattr(last, "time", 0)),
                "commission": str(sum(Decimal(str(getattr(d, "commission", 0))) for d in ordered)),
                "swap": str(sum(Decimal(str(getattr(d, "swap", 0))) for d in ordered)),
                "closeReason": self._close_reason(int(getattr(last, "reason", -1))),
            })
        return trades
