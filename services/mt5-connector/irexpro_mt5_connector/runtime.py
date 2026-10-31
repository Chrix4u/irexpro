from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path
from threading import Event
from typing import Any, Callable

from .client import IrexProConnectorClient
from .config import ConnectorSettings, KeyringSecretStore
from .journal import CommandJournal, JournalEntry
from .mt5_terminal import MetaQuotesMt5Terminal, Mt5TerminalError, TerminalPort
from .protocol import assert_bound_identity

StatusCallback = Callable[[str], None]


def _dispatch(terminal: TerminalPort, command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if command_type == "ACCOUNT_SNAPSHOT":
        return terminal.account_snapshot()
    if command_type == "GET_PRICE":
        return terminal.current_price(str(payload.get("instrument", payload.get("symbol"))))
    if command_type == "GET_OHLCV":
        raw_before = payload.get("before")
        before = None
        if isinstance(raw_before, str) and raw_before:
            before = datetime.fromisoformat(raw_before.replace("Z", "+00:00"))
        return {
            "bars": terminal.get_ohlcv(
                str(payload.get("instrument", payload.get("symbol"))),
                str(payload["timeframe"]),
                int(payload["count"]),
                before,
            )
        }
    if command_type == "LIST_SYMBOLS":
        return {"instruments": terminal.list_symbols()}
    if command_type == "GET_SYMBOL_INFO":
        return {"instrument": terminal.symbol_info(str(payload.get("instrument", payload.get("symbol"))))}
    if command_type == "CALCULATE_MARGIN":
        return terminal.calculate_margin(
            str(payload.get("instrument", payload.get("symbol"))),
            str(payload.get("direction", payload.get("side"))),
            str(payload.get("lotSize", payload.get("volume"))),
        )
    if command_type == "LIST_POSITIONS":
        return {"positions": terminal.list_positions()}
    if command_type == "LIST_ORDERS":
        return {"orders": terminal.list_orders()}
    if command_type == "GET_ORDER":
        return {"order": terminal.get_order(str(payload["providerOrderId"]))}
    if command_type == "GET_HISTORY":
        return {
            "trades": terminal.get_history(
                datetime.fromisoformat(str(payload["from"]).replace("Z", "+00:00")),
                datetime.fromisoformat(str(payload["to"]).replace("Z", "+00:00")),
            )
        }
    if command_type == "PLACE_ORDER":
        idempotency = str(payload.get("idempotencyKey", payload.get("clientOrderId", "order")))
        return terminal.place_order(
            {
                "symbol": str(payload.get("instrument", payload.get("symbol"))),
                "side": str(payload.get("direction", payload.get("side"))),
                "volume": str(payload.get("lotSize", payload.get("volume"))),
                "stopLoss": payload.get("stopLoss"),
                "takeProfit": payload.get("takeProfit"),
                "comment": str(payload.get("comment") or f"irexpro:{idempotency}"),
            }
        )
    if command_type == "MODIFY_ORDER":
        return terminal.modify_order(payload)
    if command_type == "CLOSE_ORDER":
        return terminal.close_order(payload)
    if command_type == "CLOSE_ALL":
        return terminal.close_all()
    raise Mt5TerminalError(f"unsupported connector command: {command_type}")


def _report_existing(
    client: IrexProConnectorClient,
    settings: ConnectorSettings,
    entry: JournalEntry,
) -> None:
    if entry.state == "SUCCEEDED":
        client.submit_result(settings, entry.command_id, state="SUCCEEDED", result=entry.result)
    elif entry.state == "FAILED":
        client.submit_result(settings, entry.command_id, state="FAILED", result=entry.result)
    else:
        client.submit_result(
            settings,
            entry.command_id,
            state="UNCERTAIN",
            result=entry.result,
            error="command dispatch outcome is uncertain; reconcile provider state before retry",
        )


def pair_connector(
    *,
    server_url: str,
    pairing_code: str,
    terminal_path: str | None,
    config_path: str | Path,
    terminal_factory=MetaQuotesMt5Terminal,
    client_factory=IrexProConnectorClient,
    secret_store_factory=KeyringSecretStore,
) -> ConnectorSettings:
    terminal = terminal_factory(terminal_path)
    try:
        identity = terminal.initialize()
        client = client_factory(server_url, secret_store_factory())
        settings = client.redeem_pairing(pairing_code, identity)
        settings = ConnectorSettings(**{**settings.__dict__, "terminal_path": terminal_path})
        path = Path(config_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        settings.save(path)
        return settings
    finally:
        terminal.shutdown()


def run_connector(
    *,
    config_path: str | Path,
    journal_path: str | Path,
    stop_event: Event | None = None,
    on_status: StatusCallback | None = None,
    terminal_factory=MetaQuotesMt5Terminal,
    client_factory=IrexProConnectorClient,
    secret_store_factory=KeyringSecretStore,
    journal_factory=CommandJournal,
    sleep_fn=time.sleep,
) -> int:
    stop = stop_event or Event()
    notify = on_status or (lambda _status: None)
    notify("STARTING")
    settings = ConnectorSettings.load(config_path)
    client = client_factory(settings.server_url, secret_store_factory())
    terminal = terminal_factory(settings.terminal_path)
    journal = journal_factory(journal_path)
    try:
        identity = terminal.initialize()
        client._assert_identity(settings, identity)
        notify("READY")
        while not stop.is_set():
            identity = terminal.identity()
            sequence = journal.next_heartbeat_sequence()
            client.heartbeat(settings, identity, sequence)
            if stop.is_set():
                break
            command = client.lease_next_command(settings)
            if command is not None:
                assert_bound_identity(
                    command,
                    connector_id=settings.connector_id,
                    broker_connection_id=settings.broker_connection_id,
                    account_login=settings.account_login,
                    broker_server=settings.broker_server,
                    account_type=settings.account_type,
                )
                identity = terminal.identity()
                client._assert_identity(settings, identity)
                entry = journal.begin(command)
                if entry.state != "EXECUTING":
                    _report_existing(client, settings, entry)
                else:
                    try:
                        result = _dispatch(terminal, command["commandType"], command["payload"])
                        done = journal.complete(command["commandId"], result)
                        client.submit_result(
                            settings, command["commandId"], state="SUCCEEDED", result=done.result
                        )
                    except Exception as exc:
                        failed = journal.fail(command["commandId"], {"error": str(exc)})
                        client.submit_result(
                            settings,
                            command["commandId"],
                            state="FAILED",
                            result=failed.result,
                            error=str(exc),
                        )
            if not stop.is_set():
                sleep_fn(max(0.25, settings.poll_seconds))
        return 0
    finally:
        journal.close()
        terminal.shutdown()
        notify("STOPPED")
