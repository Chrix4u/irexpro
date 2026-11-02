from __future__ import annotations

import sys


def frozen_self_test() -> int:
    """Verify imports required by the frozen Windows runtime without opening Tk/MT5."""
    try:
        import MetaTrader5  # noqa: F401
        import keyring  # noqa: F401
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
        from irexpro_mt5_connector.client import IrexProConnectorClient
        from irexpro_mt5_connector.gui import main as _gui_main  # noqa: F401
        from irexpro_mt5_connector.runtime import run_supervised_connector as _supervisor  # noqa: F401
        from irexpro_mt5_connector.windows import build_autostart_command as _autostart  # noqa: F401

        # Verify the frozen binary contains the hardened pairing parser rather
        # than merely proving that the package can be imported.
        parser_probe = {
            "response": {
                "body": {
                    "connector_id": "connector-self-test",
                    "broker_connection_id": "connection-self-test",
                    "connector_token": "token-self-test",
                }
            }
        }
        parsed = IrexProConnectorClient._find_connector_identity_payload(parser_probe)
        if parsed != {
            "connectorToken": "token-self-test",
            "connectorId": "connector-self-test",
            "brokerConnectionId": "connection-self-test",
        }:
            return 3
    except Exception:
        return 2
    return 0


def launch() -> None:
    from irexpro_mt5_connector.gui import main

    main()


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(frozen_self_test())
    launch()
