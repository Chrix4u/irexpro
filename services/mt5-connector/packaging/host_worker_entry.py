from __future__ import annotations

import sys


def frozen_self_test() -> int:
    """Verify imports required by the frozen Windows hosted-worker runtime."""
    try:
        import MetaTrader5  # noqa: F401
        import keyring  # noqa: F401
        import requests  # noqa: F401
        from irexpro_mt5_connector.host_worker import (  # noqa: F401
            HOST_WORKER_VERSION,
            HostedMt5WorkerSupervisor,
            load_worker_token,
            main as host_worker_main,
        )
    except Exception:
        return 2
    return 0


def launch() -> int:
    from irexpro_mt5_connector.host_worker import main

    return main(sys.argv[1:])


if __name__ == "__main__":
    if "--self-test" in sys.argv[1:]:
        raise SystemExit(frozen_self_test())
    raise SystemExit(launch())
