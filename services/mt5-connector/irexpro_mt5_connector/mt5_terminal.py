from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol


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
    def calculate_margin(self, symbol: str, side: str, volume: str) -> dict[str, Any]: ...
    def list_positions(self) -> list[dict[str, Any]]: ...
    def list_orders(self) -> list[dict[str, Any]]: ...
    def place_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def modify_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...
    def close_order(self, payload: dict[str, Any]) -> dict[str, Any]: ...


def _namedtuple_dict(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if hasattr(value, "_asdict"):
        return dict(value._asdict())
    raise Mt5TerminalError("MetaTrader returned an unsupported response shape")


class MetaQuotesMt5Terminal:
    """Production terminal port using MetaQuotes' official MetaTrader5 package.

    No broker password is accepted here. The Windows MT5 terminal must already
    be installed and logged in. `initialize()` attaches to that local terminal.
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

    def identity(self) -> AccountIdentity:
        mt5 = self._module()
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        if account is None or terminal is None:
            raise Mt5TerminalError("MT5 terminal is not logged into a trading account")
        trade_mode = int(getattr(account, "trade_mode", -1))
        demo_mode = int(getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0))
        real_mode = int(getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2))
        contest_mode = int(getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1))
        if trade_mode == demo_mode:
            account_type = "DEMO"
        elif trade_mode == real_mode:
            account_type = "LIVE"
        elif trade_mode == contest_mode:
            raise Mt5TerminalError("MT5 CONTEST accounts are not supported for iRexPro automated trading")
        else:
            raise Mt5TerminalError(f"MT5 reported an unknown account trade mode: {trade_mode}")
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
            account_type=account_type,
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
        return {
            "login": str(info.login),
            "server": str(info.server),
            "currency": str(info.currency) if info.currency else None,
            "leverage": int(info.leverage),
            "balance": str(info.balance),
            "equity": str(info.equity),
            "margin": str(info.margin),
            "freeMargin": str(info.margin_free),
            "marginLevel": str(info.margin_level),
            "tradeAllowed": bool(getattr(terminal, "trade_allowed", False)),
            "observedAt": datetime.now(timezone.utc).isoformat(),
        }

    def _ensure_symbol(self, symbol: str) -> Any:
        mt5 = self._module()
        info = mt5.symbol_info(symbol)
        if info is None:
            raise Mt5TerminalError(f"MT5 symbol not found: {symbol}")
        if not info.visible and not mt5.symbol_select(symbol, True):
            raise Mt5TerminalError(f"MT5 symbol cannot be selected: {symbol}")
        return info

    def current_price(self, symbol: str) -> dict[str, Any]:
        mt5 = self._module()
        self._ensure_symbol(symbol)
        tick = mt5.symbol_info_tick(symbol)
        if tick is None:
            raise Mt5TerminalError(f"MT5 tick unavailable for {symbol}: {mt5.last_error()}")
        return {
            "symbol": symbol,
            "bid": str(tick.bid),
            "ask": str(tick.ask),
            "last": str(tick.last),
            "timeMsc": int(tick.time_msc),
        }

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
        return {"symbol": symbol, "side": side_upper, "volume": volume, "margin": str(margin)}

    def list_positions(self) -> list[dict[str, Any]]:
        mt5 = self._module()
        values = mt5.positions_get()
        if values is None:
            raise Mt5TerminalError(f"MT5 positions read failed: {mt5.last_error()}")
        return [_namedtuple_dict(value) for value in values]

    def list_orders(self) -> list[dict[str, Any]]:
        mt5 = self._module()
        values = mt5.orders_get()
        if values is None:
            raise Mt5TerminalError(f"MT5 orders read failed: {mt5.last_error()}")
        return [_namedtuple_dict(value) for value in values]

    def _market_request(self, payload: dict[str, Any], *, position: int | None = None) -> dict[str, Any]:
        mt5 = self._module()
        symbol = str(payload["symbol"])
        side = str(payload["side"]).upper()
        if side not in {"BUY", "SELL"}:
            raise Mt5TerminalError("side must be BUY or SELL")
        self._ensure_symbol(symbol)
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
        if position is not None:
            request["position"] = position
        if payload.get("stopLoss") not in (None, ""):
            request["sl"] = float(payload["stopLoss"])
        if payload.get("takeProfit") not in (None, ""):
            request["tp"] = float(payload["takeProfit"])
        return request

    def place_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        request = self._market_request(payload)
        checked = mt5.order_check(request)
        if checked is None or int(checked.retcode) != 0:
            detail = _namedtuple_dict(checked) if checked is not None else {"error": mt5.last_error()}
            raise Mt5TerminalError(f"MT5 order_check rejected request: {detail}")
        result = mt5.order_send(request)
        if result is None:
            raise Mt5TerminalError(f"MT5 order_send failed: {mt5.last_error()}")
        data = _namedtuple_dict(result)
        if int(data.get("retcode", -1)) not in {10008, 10009, 10010}:
            raise Mt5TerminalError(f"MT5 order rejected: {data}")
        return data

    def modify_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        position = int(payload["positionTicket"])
        positions = mt5.positions_get(ticket=position)
        if not positions:
            raise Mt5TerminalError(f"MT5 position not found: {position}")
        existing = positions[0]
        request = {
            "action": mt5.TRADE_ACTION_SLTP,
            "position": position,
            "symbol": existing.symbol,
            "sl": float(payload.get("stopLoss", existing.sl or 0.0)),
            "tp": float(payload.get("takeProfit", existing.tp or 0.0)),
            "magic": self.MAGIC,
        }
        result = mt5.order_send(request)
        if result is None:
            raise Mt5TerminalError(f"MT5 modify failed: {mt5.last_error()}")
        data = _namedtuple_dict(result)
        if int(data.get("retcode", -1)) not in {10008, 10009, 10010}:
            raise Mt5TerminalError(f"MT5 modify rejected: {data}")
        return data

    def close_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        mt5 = self._module()
        ticket = int(payload["positionTicket"])
        positions = mt5.positions_get(ticket=ticket)
        if not positions:
            raise Mt5TerminalError(f"MT5 position not found: {ticket}")
        position = positions[0]
        close_side = "SELL" if int(position.type) == int(mt5.POSITION_TYPE_BUY) else "BUY"
        request_payload = {
            "symbol": position.symbol,
            "side": close_side,
            "volume": str(payload.get("volume", position.volume)),
            "comment": str(payload.get("comment", "irexpro-close")),
        }
        request = self._market_request(request_payload, position=ticket)
        result = mt5.order_send(request)
        if result is None:
            raise Mt5TerminalError(f"MT5 close failed: {mt5.last_error()}")
        data = _namedtuple_dict(result)
        if int(data.get("retcode", -1)) not in {10008, 10009, 10010}:
            raise Mt5TerminalError(f"MT5 close rejected: {data}")
        return data
