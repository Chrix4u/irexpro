from __future__ import annotations

import os
import subprocess
import sys
from typing import Any

AUTOSTART_VALUE_NAME = "iRexPro MT5 Connector"
AUTOSTART_REGISTRY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"


def build_autostart_command(executable_path: str | None = None) -> str:
    executable = executable_path or sys.executable
    return subprocess.list2cmdline([executable, "--background"])


def _registry(registry_module: Any | None = None):
    if registry_module is not None:
        return registry_module
    if os.name != "nt":
        raise RuntimeError("Windows autostart is available only on Windows")
    import winreg

    return winreg


def set_windows_autostart(
    enabled: bool,
    *,
    executable_path: str | None = None,
    registry_module: Any | None = None,
) -> None:
    winreg = _registry(registry_module)
    access = getattr(winreg, "KEY_SET_VALUE", 0)
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_REGISTRY_PATH, 0, access) as key:
        if enabled:
            winreg.SetValueEx(
                key,
                AUTOSTART_VALUE_NAME,
                0,
                winreg.REG_SZ,
                build_autostart_command(executable_path),
            )
        else:
            try:
                winreg.DeleteValue(key, AUTOSTART_VALUE_NAME)
            except FileNotFoundError:
                pass


def is_windows_autostart_enabled(*, registry_module: Any | None = None) -> bool:
    winreg = _registry(registry_module)
    access = getattr(winreg, "KEY_QUERY_VALUE", 0)
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, AUTOSTART_REGISTRY_PATH, 0, access) as key:
            value, _kind = winreg.QueryValueEx(key, AUTOSTART_VALUE_NAME)
            return bool(value)
    except FileNotFoundError:
        return False
