from __future__ import annotations

import argparse
import sys

from .client import ConnectorApiError
from .mt5_terminal import Mt5TerminalError
from .protocol import ProtocolError
from .runtime import _dispatch, pair_connector, run_connector


def pair(args: argparse.Namespace) -> int:
    settings = pair_connector(
        server_url=args.server_url,
        pairing_code=args.pairing_code,
        terminal_path=args.terminal_path,
        config_path=args.config,
    )
    print(
        f"Paired MT5 {settings.account_type} account {settings.account_login} "
        f"on {settings.broker_server}."
    )
    print(f"Connector configuration saved to {args.config} (token stored in OS credential vault).")
    return 0


def run(args: argparse.Namespace) -> int:
    return run_connector(config_path=args.config, journal_path=args.journal)


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
