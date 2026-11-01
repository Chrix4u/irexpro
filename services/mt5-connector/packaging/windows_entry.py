from __future__ import annotations

import sys


def frozen_self_test() -> int:
    """Verify imports required by the frozen Windows runtime without opening Tk/MT5."""
    try:
        import MetaTrader5  # noqa: F401
        import keyring  # noqa: F401
        import pystray  # noqa: F401
        from PIL import Image  # noqa: F401
        from irexpro_mt5_connector.gui import main as _gui_main  # noqa: F401
        from irexpro_mt5_connector.runtime import run_supervised_connector as _supervisor  # noqa: F401
        from irexpro_mt5_connector.windows import build_autostart_command as _autostart  # noqa: F401
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
