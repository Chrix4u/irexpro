from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any

from .client import ConnectorApiError, IrexProConnectorClient
from .config import ConnectorSettings, KeyringSecretStore
from .journal import CommandJournal, JournalEntry
from .mt5_terminal import MetaQuotesMt5Terminal, Mt5TerminalError, TerminalPort
from .protocol import ProtocolError, assert_bound_identity


def _dispatch(terminal: TerminalPort, command_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    if command_type == "ACCOUNT_SNAPSHOT":
        return terminal.account_snapshot()
    if command_type == "GET_PRICE":
        return terminal.current_price(str(payload["symbol"]))
    if command_type == "CALCULATE_MARGIN":
        return terminal.calculate_margin(
            str(payload["symbol"]), str(payload["side"]), str(payload["volume"])
        )
    if command_type == "LIST_POSITIONS":
        return {"positions": terminal.list_positions()}
    if command_type == "LIST_ORDERS":
        return {"orders": terminal.list_orders()}
    if command_type == "PLACE_ORDER":
        return terminal.place_order(payload)
    if command_type == "MODIFY_ORDER":
        return terminal.modify_order(payload)
    if command_type == "CLOSE_ORDER":
        return terminal.close_order(payload)
    raise Mt5TerminalError(f"command not implemented by connector 0.1: {command_type}")


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


def pair(args: argparse.Namespace) -> int:
    terminal = MetaQuotesMt5Terminal(args.terminal_path)
    try:
        identity = terminal.initialize()
        client = IrexProConnectorClient(args.server_url, KeyringSecretStore())
        settings = client.redeem_pairing(args.pairing_code, identity)
        settings = ConnectorSettings(
            **{**settings.__dict__, "terminal_path": args.terminal_path}
        )
        settings.save(args.config)
        print(f"Paired MT5 account {identity.login} on {identity.server}.")
        print(f"Connector configuration saved to {args.config} (token stored in OS credential vault).")
        return 0
    finally:
        terminal.shutdown()


def run(args: argparse.Namespace) -> int:
    settings = ConnectorSettings.load(args.config)
    secret_store = KeyringSecretStore()
    client = IrexProConnectorClient(settings.server_url, secret_store)
    terminal = MetaQuotesMt5Terminal(settings.terminal_path)
    journal = CommandJournal(args.journal)
    try:
        identity = terminal.initialize()
        client._assert_identity(settings, identity)
        while True:
            identity = terminal.identity()
            sequence = journal.next_heartbeat_sequence()
            client.heartbeat(settings, identity, sequence)
            command = client.lease_next_command(settings)
            if command is not None:
                assert_bound_identity(
                    command,
                    connector_id=settings.connector_id,
                    broker_connection_id=settings.broker_connection_id,
                    account_login=settings.account_login,
                    broker_server=settings.broker_server,
                )
                # Re-read terminal identity immediately before any command.
                # A user switching accounts between heartbeat and dispatch must
                # never move an iRexPro order to the newly-selected account.
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
            time.sleep(max(0.25, settings.poll_seconds))
    except KeyboardInterrupt:
        return 0
    finally:
        journal.close()
        terminal.shutdown()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="irexpro-mt5-connector")
    sub = parser.add_subparsers(dest="command", required=True)

    pair_parser = sub.add_parser("pair", help="Pair the currently logged-in MT5 terminal")
    pair_parser.add_argument("--server-url", required=True)
    pair_parser.add_argument("--pairing-code", required=True)
    pair_parser.add_argument("--terminal-path")
    pair_parser.add_argument("--config", default="irexpro-mt5.json")
    pair_parser.set_defaults(handler=pair)

    run_parser = sub.add_parser("run", help="Run the paired MT5 connector")
    run_parser.add_argument("--config", default="irexpro-mt5.json")
    run_parser.add_argument("--journal", default="irexpro-mt5-journal.db")
    run_parser.set_defaults(handler=run)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    try:
        raise SystemExit(args.handler(args))
    except (ConnectorApiError, Mt5TerminalError, ProtocolError, ValueError, KeyError) as exc:
        print(f"Connector stopped safely: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc


if __name__ == "__main__":
    main()
