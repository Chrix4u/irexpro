from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event
from typing import Any, Mapping, Protocol
from urllib.parse import urlparse

import requests

from .config import ConnectorSettings
from .runtime import run_connector, run_supervised_connector
from .mt5_terminal import MetaQuotesMt5Terminal



_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
HOST_WORKER_VERSION = "0.4.0"


def _normalize_api_base_url(server_url: str) -> str:
    raw = server_url.strip().rstrip("/")
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("Hosted MT5 worker API URL is invalid")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("Hosted MT5 worker API URL is invalid")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS):
        raise ValueError("Hosted MT5 worker API requires HTTPS except for true loopback development")
    if parsed.path in {"", "/"}:
        raw = f"{raw}/api/v1"
    return raw

class HostWorkerApiError(RuntimeError):
    """Hosted-worker control-plane error that never embeds request secrets."""


@dataclass
class HostedAssignment:
    connector_id: str
    broker_connection_id: str
    account_login: str
    broker_server: str
    account_type: str
    connector_token: str = field(repr=False)
    trading_password: str = field(repr=False)

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> "HostedAssignment":
        def required_string(name: str) -> str:
            value = payload.get(name)
            if not isinstance(value, str) or not value.strip():
                raise HostWorkerApiError(f"Hosted MT5 assignment is missing {name}")
            return value.strip()

        connector_id = required_string("connectorId")
        broker_connection_id = required_string("brokerConnectionId")
        account_login = required_string("accountLogin")
        broker_server = required_string("brokerServer")
        account_type = required_string("accountType")
        connector_token = required_string("connectorToken")
        trading_password = required_string("tradingPassword")
        if not account_login.isdigit():
            raise HostWorkerApiError("Hosted MT5 assignment account login is invalid")
        if account_type != "DEMO":
            raise HostWorkerApiError("Hosted MT5 worker pilot accepts DEMO assignments only")
        if len(broker_server) > 255:
            raise HostWorkerApiError("Hosted MT5 assignment broker server is invalid")
        return cls(
            connector_id=connector_id,
            broker_connection_id=broker_connection_id,
            account_login=account_login,
            broker_server=broker_server,
            account_type=account_type,
            connector_token=connector_token,
            trading_password=trading_password,
        )

    def child_payload(self) -> dict[str, str]:
        return {
            "connectorId": self.connector_id,
            "brokerConnectionId": self.broker_connection_id,
            "accountLogin": self.account_login,
            "brokerServer": self.broker_server,
            "accountType": self.account_type,
            "connectorToken": self.connector_token,
            "tradingPassword": self.trading_password,
        }

    def clear_secrets(self) -> None:
        self.connector_token = ""
        self.trading_password = ""


class InMemorySecretStore:
    """Connector-token store used by hosted children; intentionally no disk backend."""

    def __init__(self, connector_id: str, token: str) -> None:
        self._tokens: dict[str, str] = {connector_id: token}

    def get(self, connector_id: str) -> str | None:
        return self._tokens.get(connector_id)

    def set(self, connector_id: str, token: str) -> None:
        if not token:
            raise ValueError("connector token must not be empty")
        self._tokens[connector_id] = token

    def delete(self, connector_id: str) -> None:
        self._tokens.pop(connector_id, None)


@dataclass(frozen=True)
class HostWorkerConfig:
    server_url: str
    worker_id: str
    worker_token: str = field(repr=False)
    mt5_template_dir: Path
    session_root: Path
    max_sessions: int = 4
    heartbeat_seconds: float = 20.0
    poll_seconds: float = 2.0
    terminal_relative_path: str = "terminal64.exe"

    def __post_init__(self) -> None:
        object.__setattr__(self, "server_url", _normalize_api_base_url(self.server_url))
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,127}", self.worker_id):
            raise ValueError("Hosted MT5 worker id is invalid")
        if len(self.worker_token) < 32:
            raise ValueError("Hosted MT5 worker token must be at least 32 characters")
        if self.max_sessions < 1:
            raise ValueError("Hosted MT5 max sessions must be at least 1")
        if self.heartbeat_seconds < 0:
            raise ValueError("Hosted MT5 heartbeat interval cannot be negative")
        if self.poll_seconds < 0.1:
            raise ValueError("Hosted MT5 poll interval must be at least 0.1 seconds")


class HostWorkerApi:
    def __init__(
        self,
        server_url: str,
        worker_id: str,
        worker_token: str,
        *,
        session: requests.Session | None = None,
        timeout_seconds: float = 15.0,
    ) -> None:
        normalized_server_url = _normalize_api_base_url(server_url)
        if len(worker_token) < 32:
            raise ValueError("Hosted MT5 worker token must be at least 32 characters")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,127}", worker_id):
            raise ValueError("Hosted MT5 worker id is invalid")
        self.server_url = normalized_server_url
        self.worker_id = worker_id
        self._worker_token = worker_token
        self.session = session or requests.Session()
        self.timeout_seconds = timeout_seconds

    def lease_assignment(self) -> HostedAssignment | None:
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/hosted-worker/assignments/lease",
            headers=self._headers(),
            json={"workerId": self.worker_id},
            timeout=self.timeout_seconds,
        )
        if response.status_code == 204:
            return None
        payload = self._json(response)
        return HostedAssignment.from_payload(payload)

    def heartbeat_assignment(self, connector_id: str, error_code: str | None = None) -> None:
        if not re.fullmatch(r"[A-Za-z0-9._-]+", connector_id):
            raise HostWorkerApiError("Hosted MT5 connector id is invalid")
        body: dict[str, str] = {"workerId": self.worker_id}
        if error_code:
            if not re.fullmatch(r"[A-Z0-9][A-Z0-9_:-]{0,63}", error_code):
                raise HostWorkerApiError("Hosted MT5 worker error code is invalid")
            body["errorCode"] = error_code
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/hosted-worker/assignments/{connector_id}/heartbeat",
            headers=self._headers(),
            json=body,
            timeout=self.timeout_seconds,
        )
        self._assert_ok(response)

    def heartbeat_worker_presence(
        self,
        *,
        worker_version: str,
        runtime_ready: bool,
        max_sessions: int,
        active_sessions: int,
    ) -> None:
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/hosted-worker/presence",
            headers=self._headers(),
            json={
                "workerId": self.worker_id,
                "workerVersion": worker_version,
                "runtimeReady": runtime_ready,
                "maxSessions": max_sessions,
                "activeSessions": active_sessions,
            },
            timeout=self.timeout_seconds,
        )
        self._assert_ok(response)

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._worker_token}",
            "User-Agent": "iRexPro-MT5-Host-Worker/0.1",
        }

    def _json(self, response: Any) -> dict[str, Any]:
        self._assert_ok(response)
        try:
            data = response.json()
        except (TypeError, ValueError) as exc:
            raise HostWorkerApiError("Hosted MT5 API returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise HostWorkerApiError("Hosted MT5 API returned invalid response shape")
        return data

    @staticmethod
    def _assert_ok(response: Any) -> None:
        status = int(getattr(response, "status_code", 0))
        if 200 <= status < 300:
            return
        # Deliberately omit response/request bodies: a remote error must never
        # accidentally echo worker or broker credentials into service logs.
        raise HostWorkerApiError(f"Hosted MT5 API request failed with HTTP {status}")


def _safe_relative_terminal_path(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("MT5 terminal relative path is invalid")
    return path


def prepare_session_directory(
    template_dir: str | Path,
    session_root: str | Path,
    connector_id: str,
    terminal_relative_path: str = "terminal64.exe",
) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9._-]+", connector_id):
        raise ValueError("Hosted MT5 connector id is invalid")
    template = Path(template_dir)
    if not template.is_dir():
        raise FileNotFoundError("Hosted MT5 clean template directory does not exist")
    relative_terminal = _safe_relative_terminal_path(terminal_relative_path)
    if not (template / relative_terminal).is_file():
        raise FileNotFoundError("Hosted MT5 template terminal executable does not exist")
    root = Path(session_root)
    root.mkdir(parents=True, exist_ok=True)
    target = root / connector_id
    if not target.exists():
        shutil.copytree(template, target)
    if not (target / relative_terminal).is_file():
        raise FileNotFoundError("Hosted MT5 session terminal executable does not exist")
    return target


@dataclass(frozen=True)
class ChildProcessSpec:
    argv: tuple[str, ...]
    stdin_payload: str = field(repr=False)
    env: Mapping[str, str] = field(repr=False)


def _sanitized_child_environment() -> dict[str, str]:
    env = dict(os.environ)
    for secret_name in (
        "HOSTED_MT5_WORKER_TOKEN",
        "BROKER_ENCRYPTION_KEY",
        "DIRECT_MT5_CONNECTOR_PEPPER",
        "METAAPI_TOKEN",
    ):
        env.pop(secret_name, None)
    return env


def build_session_child_spec(
    assignment: HostedAssignment,
    *,
    server_url: str,
    session_dir: str | Path,
    terminal_path: str | Path,
    python_executable: str | None = None,
) -> ChildProcessSpec:
    executable = python_executable or sys.executable
    argv = (
        executable,
        "-m",
        "irexpro_mt5_connector.host_worker",
        "--session-child",
        "--server-url",
        server_url,
        "--session-dir",
        str(Path(session_dir)),
        "--terminal-path",
        str(Path(terminal_path)),
    )
    return ChildProcessSpec(
        argv=argv,
        stdin_payload=json.dumps(assignment.child_payload(), separators=(",", ":")),
        env=_sanitized_child_environment(),
    )


class ChildProcess(Protocol):
    def poll(self) -> int | None: ...
    def terminate(self) -> None: ...
    def wait(self, timeout: float | None = None) -> int | None: ...
    def kill(self) -> None: ...


def launch_session_child(spec: ChildProcessSpec) -> ChildProcess:
    process = subprocess.Popen(
        list(spec.argv),
        stdin=subprocess.PIPE,
        text=True,
        env=dict(spec.env),
    )
    if process.stdin is None:
        process.terminate()
        raise RuntimeError("Hosted MT5 session child stdin could not be opened")
    try:
        process.stdin.write(spec.stdin_payload + "\n")
        process.stdin.flush()
    finally:
        process.stdin.close()
    return process


@dataclass
class ActiveHostedSession:
    process: ChildProcess
    session_dir: Path
    last_worker_heartbeat: float


class HostedMt5WorkerSupervisor:
    def __init__(
        self,
        config: HostWorkerConfig,
        *,
        api: HostWorkerApi | Any | None = None,
        launcher=launch_session_child,
        monotonic=time.monotonic,
    ) -> None:
        self.config = config
        self.api = api or HostWorkerApi(config.server_url, config.worker_id, config.worker_token)
        self.launcher = launcher
        self.monotonic = monotonic
        self._active: dict[str, ActiveHostedSession] = {}
        self._last_presence_heartbeat: float | None = None

    @property
    def active_connector_ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._active))

    def tick(self) -> None:
        now = self.monotonic()
        self._reap_exited()
        for connector_id, active in list(self._active.items()):
            if now - active.last_worker_heartbeat >= self.config.heartbeat_seconds:
                try:
                    self.api.heartbeat_assignment(connector_id)
                except Exception:
                    # Keep the child running while its connector heartbeat is
                    # independently healthy. The control-plane lease will expire
                    # fail-closed if this worker cannot renew it.
                    continue
                active.last_worker_heartbeat = now

        while len(self._active) < self.config.max_sessions:
            try:
                assignment = self.api.lease_assignment()
            except (HostWorkerApiError, requests.RequestException):
                # Losing the control plane must not tear down healthy MT5 children.
                # Existing connector heartbeats continue independently and the
                # server-side worker lease expires fail-closed if renewal is lost.
                break
            if assignment is None:
                break
            self._launch_assignment(assignment, now)

        if (
            self._last_presence_heartbeat is None
            or now - self._last_presence_heartbeat >= self.config.heartbeat_seconds
        ):
            try:
                self.api.heartbeat_worker_presence(
                    worker_version=HOST_WORKER_VERSION,
                    runtime_ready=True,
                    max_sessions=self.config.max_sessions,
                    active_sessions=len(self._active),
                )
            except (HostWorkerApiError, requests.RequestException):
                pass
            self._last_presence_heartbeat = now

    def _reap_exited(self) -> None:
        for connector_id, active in list(self._active.items()):
            returncode = active.process.poll()
            if returncode is None:
                continue
            code = self._exit_error_code(returncode)
            try:
                self.api.heartbeat_assignment(connector_id, error_code=code)
            except Exception:
                pass
            self._active.pop(connector_id, None)

    def _launch_assignment(self, assignment: HostedAssignment, now: float) -> bool:
        connector_id = assignment.connector_id
        try:
            session_dir = prepare_session_directory(
                self.config.mt5_template_dir,
                self.config.session_root,
                connector_id,
                self.config.terminal_relative_path,
            )
            terminal_path = session_dir / _safe_relative_terminal_path(
                self.config.terminal_relative_path
            )
            spec = build_session_child_spec(
                assignment,
                server_url=self.config.server_url,
                session_dir=session_dir,
                terminal_path=terminal_path,
            )
            process = self.launcher(spec)
            self._active[connector_id] = ActiveHostedSession(
                process=process,
                session_dir=session_dir,
                last_worker_heartbeat=now,
            )
            return True
        except Exception:
            try:
                self.api.heartbeat_assignment(connector_id, error_code="SESSION_LAUNCH_FAILED")
            except Exception:
                pass
            # One malformed/broken assignment must not terminate unrelated
            # healthy customer sessions on this execution worker.
            return False
        finally:
            assignment.clear_secrets()

    @staticmethod
    def _exit_error_code(returncode: int) -> str:
        normalized = max(-999999, min(999999, int(returncode)))
        return f"SESSION_EXITED:{normalized}"

    def run_forever(self, stop_event: Event | None = None) -> int:
        stop = stop_event or Event()
        try:
            while not stop.is_set():
                self.tick()
                stop.wait(self.config.poll_seconds)
            return 0
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        for active in list(self._active.values()):
            if active.process.poll() is None:
                active.process.terminate()
        for active in list(self._active.values()):
            if active.process.poll() is not None:
                continue
            try:
                active.process.wait(timeout=10.0)
            except Exception:
                active.process.kill()
        self._active.clear()


def run_session_child(
    *,
    server_url: str,
    session_dir: str | Path,
    terminal_path: str | Path,
    assignment_payload: Mapping[str, Any],
) -> int:
    assignment = HostedAssignment.from_payload(assignment_payload)
    directory = Path(session_dir)
    directory.mkdir(parents=True, exist_ok=True)
    config_path = directory / "connector.json"
    journal_path = directory / "journal.sqlite3"

    # Copy secret strings into the only in-memory components that need them,
    # then wipe the assignment object before entering the long-running loop.
    connector_token = assignment.connector_token
    trading_password = assignment.trading_password
    connector_id = assignment.connector_id
    account_login = assignment.account_login
    broker_server = assignment.broker_server
    account_type = assignment.account_type

    settings = ConnectorSettings(
        server_url=server_url.rstrip("/"),
        connector_id=connector_id,
        broker_connection_id=assignment.broker_connection_id,
        account_login=account_login,
        broker_server=broker_server,
        account_type=account_type,
        terminal_path=str(Path(terminal_path)),
        poll_seconds=1.0,
        auto_start=False,
        start_minimized=True,
    )
    settings.save(config_path)  # contains no password and no connector token
    secret_store = InMemorySecretStore(connector_id, connector_token)
    assignment.clear_secrets()

    def terminal_factory(path: str | None):
        return MetaQuotesMt5Terminal(
            path,
            login=account_login,
            password=trading_password,
            server=broker_server,
            portable=True,
        )

    def hosted_runner(**kwargs):
        return run_connector(
            **kwargs,
            terminal_factory=terminal_factory,
            secret_store_factory=lambda: secret_store,
        )

    return run_supervised_connector(
        config_path=config_path,
        journal_path=journal_path,
        runner=hosted_runner,
    )


def validate_host_worker_runtime(platform_name: str | None = None) -> None:
    platform_value = platform_name or sys.platform
    if platform_value != "win32":
        raise RuntimeError(
            "The certified hosted MT5 worker pilot requires Windows; Linux/Wine is a separate certification target"
        )


def check_host_worker_readiness(
    *,
    server_url: str,
    mt5_template_dir: str | Path,
    session_root: str | Path,
    terminal_relative_path: str = "terminal64.exe",
    platform_name: str | None = None,
    session: requests.Session | Any | None = None,
    timeout_seconds: float = 10.0,
) -> dict[str, Any]:
    """Verify a hosted-worker host without leasing work or reading customer secrets."""
    validate_host_worker_runtime(platform_name=platform_name)
    api_base = _normalize_api_base_url(server_url)
    template = Path(mt5_template_dir)
    relative_terminal = _safe_relative_terminal_path(terminal_relative_path)
    terminal = template / relative_terminal
    if not template.is_dir() or not terminal.is_file():
        raise RuntimeError("Hosted MT5 clean template or terminal executable is missing")

    root = Path(session_root)
    root.mkdir(parents=True, exist_ok=True)
    probe = root / ".irexpro-readiness-probe"
    try:
        probe.write_text("ready", encoding="utf-8")
        if probe.read_text(encoding="utf-8") != "ready":
            raise RuntimeError("Hosted MT5 session root write verification failed")
    finally:
        try:
            probe.unlink()
        except FileNotFoundError:
            pass

    http = session or requests.Session()
    response = http.get(
        f"{api_base}/health/live",
        headers={"User-Agent": "iRexPro-MT5-Host-Worker-Readiness/0.1"},
        timeout=timeout_seconds,
    )
    status = int(getattr(response, "status_code", 0))
    if not 200 <= status < 300:
        raise HostWorkerApiError(f"Hosted MT5 API readiness failed with HTTP {status}")

    return {
        "status": "READY",
        "apiReachable": True,
        "terminalPresent": True,
        "sessionRootWritable": True,
        "apiBaseUrl": api_base,
        "terminalPath": str(terminal),
        "sessionRoot": str(root),
    }


def _read_child_assignment_from_stdin() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("Hosted MT5 session child received no assignment payload")
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise RuntimeError("Hosted MT5 session child received invalid assignment JSON") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("Hosted MT5 session child assignment must be an object")
    return payload


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="iRexPro hosted MT5 execution worker")
    parser.add_argument("--session-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--readiness-check", action="store_true", help="verify this Windows MT5 worker host without leasing an account")
    parser.add_argument("--server-url", default=os.getenv("IREXPRO_API_URL", ""))
    parser.add_argument("--worker-id", default=os.getenv("HOSTED_MT5_WORKER_ID", ""))
    parser.add_argument("--mt5-template-dir", default=os.getenv("HOSTED_MT5_TEMPLATE_DIR", ""))
    parser.add_argument("--session-root", default=os.getenv("HOSTED_MT5_SESSION_ROOT", ""))
    parser.add_argument("--max-sessions", type=int, default=int(os.getenv("HOSTED_MT5_MAX_SESSIONS", "4")))
    parser.add_argument(
        "--heartbeat-seconds", type=float, default=float(os.getenv("HOSTED_MT5_HEARTBEAT_SECONDS", "20"))
    )
    parser.add_argument("--poll-seconds", type=float, default=float(os.getenv("HOSTED_MT5_POLL_SECONDS", "2")))
    parser.add_argument(
        "--terminal-relative-path",
        default=os.getenv("HOSTED_MT5_TERMINAL_RELATIVE_PATH", "terminal64.exe"),
    )
    parser.add_argument("--session-dir", default="", help=argparse.SUPPRESS)
    parser.add_argument("--terminal-path", default="", help=argparse.SUPPRESS)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.readiness_check:
        result = check_host_worker_readiness(
            server_url=args.server_url,
            mt5_template_dir=Path(args.mt5_template_dir),
            session_root=Path(args.session_root),
            terminal_relative_path=args.terminal_relative_path,
        )
        print(json.dumps(result, sort_keys=True))
        return 0

    validate_host_worker_runtime()
    if args.session_child:
        if not args.server_url or not args.session_dir or not args.terminal_path:
            raise RuntimeError("Hosted MT5 session child is missing non-secret runtime paths")
        return run_session_child(
            server_url=args.server_url,
            session_dir=args.session_dir,
            terminal_path=args.terminal_path,
            assignment_payload=_read_child_assignment_from_stdin(),
        )

    config = HostWorkerConfig(
        server_url=args.server_url,
        worker_id=args.worker_id,
        worker_token=os.getenv("HOSTED_MT5_WORKER_TOKEN", ""),
        mt5_template_dir=Path(args.mt5_template_dir),
        session_root=Path(args.session_root),
        max_sessions=args.max_sessions,
        heartbeat_seconds=args.heartbeat_seconds,
        poll_seconds=args.poll_seconds,
        terminal_relative_path=args.terminal_relative_path,
    )
    if not config.mt5_template_dir.is_dir():
        raise RuntimeError("HOSTED_MT5_TEMPLATE_DIR must point to a clean MT5 template directory")
    config.session_root.mkdir(parents=True, exist_ok=True)
    return HostedMt5WorkerSupervisor(config).run_forever()


if __name__ == "__main__":
    raise SystemExit(main())
