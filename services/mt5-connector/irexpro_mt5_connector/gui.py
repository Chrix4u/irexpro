from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path

from .config import ConnectorSettings
from .runtime import pair_connector, run_connector

DEFAULT_SERVER_URL = "https://irexpro.lightworldtech.com/api/v1"
_PAIRING_CODE = re.compile(r"^[A-Z2-9]{10}$")


@dataclass(frozen=True)
class ConnectorPaths:
    base: Path
    config: Path
    journal: Path


def connector_paths() -> ConnectorPaths:
    local = os.environ.get("LOCALAPPDATA")
    base = Path(local) / "iRexPro" / "MT5Connector" if local else Path.home() / ".irexpro" / "mt5-connector"
    return ConnectorPaths(base=base, config=base / "connector.json", journal=base / "journal.db")


def normalize_pairing_code(value: str) -> str:
    normalized = re.sub(r"[\s-]+", "", value.strip().upper())
    if not _PAIRING_CODE.fullmatch(normalized):
        raise ValueError("Enter the 10-character pairing code shown in iRexPro.")
    return normalized


class ConnectorDesktopApp:
    def __init__(self, root) -> None:
        import tkinter as tk
        from tkinter import ttk

        self._tk = tk
        self._ttk = ttk
        self.root = root
        self.paths = connector_paths()
        self.paths.base.mkdir(parents=True, exist_ok=True)
        self.stop_event = threading.Event()
        self.run_thread: threading.Thread | None = None
        self.closing = False

        self.server_var = tk.StringVar(value=DEFAULT_SERVER_URL)
        self.code_var = tk.StringVar()
        self.terminal_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Not paired")
        self.account_var = tk.StringVar(value="No MT5 account paired")

        self._build()
        self._load_existing()
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _build(self) -> None:
        from tkinter import filedialog

        self.root.title("iRexPro MT5 Connector")
        self.root.geometry("620x500")
        self.root.minsize(560, 450)

        frame = self._ttk.Frame(self.root, padding=24)
        frame.pack(fill="both", expand=True)

        title = self._ttk.Label(frame, text="iRexPro Direct MT5 Connector", font=("Segoe UI", 18, "bold"))
        title.pack(anchor="w")
        self._ttk.Label(
            frame,
            text="Connect the MetaTrader 5 terminal already logged in on this Windows computer. "
                 "iRexPro never asks for or stores your MT5 password.",
            wraplength=550,
        ).pack(anchor="w", pady=(6, 18))

        self._field(frame, "iRexPro server", self.server_var)
        self._field(frame, "Pairing code", self.code_var)

        terminal_row = self._ttk.Frame(frame)
        terminal_row.pack(fill="x", pady=(0, 12))
        self._ttk.Label(terminal_row, text="MT5 terminal path (optional)").pack(anchor="w")
        entry_row = self._ttk.Frame(terminal_row)
        entry_row.pack(fill="x", pady=(4, 0))
        self._ttk.Entry(entry_row, textvariable=self.terminal_var).pack(side="left", fill="x", expand=True)
        self._ttk.Button(
            entry_row,
            text="Browse…",
            command=lambda: self._browse_terminal(filedialog),
        ).pack(side="left", padx=(8, 0))

        actions = self._ttk.Frame(frame)
        actions.pack(fill="x", pady=(6, 14))
        self.pair_button = self._ttk.Button(actions, text="Pair & Start", command=self._pair_and_start)
        self.pair_button.pack(side="left")
        self.start_button = self._ttk.Button(actions, text="Start", command=self._start, state="disabled")
        self.start_button.pack(side="left", padx=(8, 0))
        self.stop_button = self._ttk.Button(actions, text="Stop", command=self._stop, state="disabled")
        self.stop_button.pack(side="left", padx=(8, 0))

        status_box = self._ttk.LabelFrame(frame, text="Status", padding=14)
        status_box.pack(fill="x", pady=(4, 12))
        self._ttk.Label(status_box, textvariable=self.status_var, font=("Segoe UI", 11, "bold")).pack(anchor="w")
        self._ttk.Label(status_box, textvariable=self.account_var, wraplength=520).pack(anchor="w", pady=(4, 0))

        self._ttk.Label(
            frame,
            text="Protocol v2 safety: if the MT5 login, broker server, or DEMO/LIVE environment changes, "
                 "the connector stops and must be paired again. Closing this window stops the connector safely.",
            wraplength=550,
        ).pack(anchor="w", pady=(10, 0))

    def _field(self, parent, label: str, variable) -> None:
        row = self._ttk.Frame(parent)
        row.pack(fill="x", pady=(0, 12))
        self._ttk.Label(row, text=label).pack(anchor="w")
        self._ttk.Entry(row, textvariable=variable).pack(fill="x", pady=(4, 0))

    def _browse_terminal(self, filedialog) -> None:
        selected = filedialog.askopenfilename(
            title="Select MetaTrader 5 terminal",
            filetypes=[("MetaTrader terminal", "terminal64.exe"), ("Windows programs", "*.exe")],
        )
        if selected:
            self.terminal_var.set(selected)

    def _load_existing(self) -> None:
        if not self.paths.config.exists():
            return
        try:
            settings = ConnectorSettings.load(self.paths.config)
        except Exception as exc:
            self.status_var.set(f"Upgrade/re-pair required: {exc}")
            return
        self.server_var.set(settings.server_url)
        self.terminal_var.set(settings.terminal_path or "")
        self.account_var.set(
            f"Paired {settings.account_type} account {settings.account_login} on {settings.broker_server}"
        )
        self.status_var.set("Paired — press Start")
        self.start_button.configure(state="normal")

    def _pair_and_start(self) -> None:
        try:
            pairing_code = normalize_pairing_code(self.code_var.get())
        except ValueError as exc:
            self._show_error(str(exc))
            return
        server_url = self.server_var.get().strip() or DEFAULT_SERVER_URL
        terminal_path = self.terminal_var.get().strip() or None
        self._set_busy(True)
        self.status_var.set("Pairing with iRexPro…")

        def worker() -> None:
            try:
                settings = pair_connector(
                    server_url=server_url,
                    pairing_code=pairing_code,
                    terminal_path=terminal_path,
                    config_path=self.paths.config,
                )
                self._post(
                    lambda: self.account_var.set(
                        f"Paired {settings.account_type} account {settings.account_login} on {settings.broker_server}"
                    )
                )
                self._post(lambda: self.code_var.set(""))
                self._post(self._start)
            except Exception as exc:
                self._post(lambda: self._show_error(f"Pairing failed safely: {exc}"))
                self._post(lambda: self._set_busy(False))

        threading.Thread(target=worker, name="irexpro-mt5-pair", daemon=True).start()

    def _start(self) -> None:
        if self.run_thread and self.run_thread.is_alive():
            return
        if not self.paths.config.exists():
            self._show_error("Create a pairing first.")
            return
        self.stop_event = threading.Event()
        self._set_busy(True)
        self.stop_button.configure(state="normal")
        self.status_var.set("Starting connector…")

        def worker() -> None:
            try:
                run_connector(
                    config_path=self.paths.config,
                    journal_path=self.paths.journal,
                    stop_event=self.stop_event,
                    on_status=self._worker_status,
                )
            except Exception as exc:
                self._post(lambda: self._show_error(f"Connector stopped safely: {exc}"))
            finally:
                self._post(self._run_finished)

        self.run_thread = threading.Thread(target=worker, name="irexpro-mt5-run", daemon=True)
        self.run_thread.start()

    def _worker_status(self, status: str) -> None:
        labels = {
            "STARTING": "Starting connector…",
            "READY": "Connected — iRexPro can reach this MT5 terminal",
            "STOPPED": "Stopped",
        }
        self._post(lambda: self.status_var.set(labels.get(status, status)))

    def _stop(self) -> None:
        self.status_var.set("Stopping safely…")
        self.stop_event.set()
        self.stop_button.configure(state="disabled")

    def _run_finished(self) -> None:
        self._set_busy(False)
        self.stop_button.configure(state="disabled")
        self.start_button.configure(state="normal" if self.paths.config.exists() else "disabled")
        if self.closing:
            self.root.destroy()

    def _set_busy(self, busy: bool) -> None:
        self.pair_button.configure(state="disabled" if busy else "normal")
        if busy:
            self.start_button.configure(state="disabled")
        elif self.paths.config.exists():
            self.start_button.configure(state="normal")

    def _show_error(self, message: str) -> None:
        from tkinter import messagebox

        self.status_var.set(message)
        messagebox.showerror("iRexPro MT5 Connector", message)

    def _post(self, callback) -> None:
        try:
            self.root.after(0, callback)
        except Exception:
            pass

    def _on_close(self) -> None:
        self.closing = True
        if self.run_thread and self.run_thread.is_alive():
            self._stop()
            self.status_var.set("Stopping safely before exit…")
        else:
            self.root.destroy()


def main() -> None:
    import tkinter as tk

    root = tk.Tk()
    ConnectorDesktopApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
