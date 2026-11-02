import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from irexpro_mt5_connector.host_worker import (
    HostWorkerApi,
    HostWorkerApiError,
    HostWorkerConfig,
    HostedAssignment,
    HostedMt5WorkerSupervisor,
    InMemorySecretStore,
    build_session_child_spec,
    load_worker_token,
    store_worker_token,
    check_host_worker_readiness,
    prepare_session_directory,
    run_session_child,
    validate_host_worker_runtime,
    WorkerInstanceLock,
)


class FakeResponse:
    def __init__(self, status_code=200, body=None):
        self.status_code = status_code
        self._body = body

    def json(self):
        return self._body


class FakeHttpSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)

    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return self.responses.pop(0)


def assignment_dict():
    return {
        "connectorId": "connector-1",
        "brokerConnectionId": "connection-1",
        "accountLogin": "113392789",
        "brokerServer": "Broker-Demo",
        "accountType": "DEMO",
        "connectorToken": "connector-token-secret",
        "tradingPassword": "mt5-password-secret",
    }


def assignment():
    return HostedAssignment.from_payload(assignment_dict())


def test_worker_api_requires_https_and_sends_worker_secret_only_as_bearer_header():
    with pytest.raises(ValueError, match="HTTPS"):
        HostWorkerApi("http://api.example.test/api/v1", "worker-1", "x" * 32)

    session = FakeHttpSession([FakeResponse(200, assignment_dict())])
    api = HostWorkerApi(
        "https://api.example.test/api/v1",
        "worker-accra-1",
        "w" * 32,
        session=session,
    )

    leased = api.lease_assignment()

    assert leased.connector_id == "connector-1"
    url, request = session.calls[0]
    assert url.endswith("/broker/direct-mt5/hosted-worker/assignments/lease")
    assert request["headers"]["Authorization"] == f"Bearer {'w' * 32}"
    assert request["json"] == {"workerId": "worker-accra-1"}
    assert "mt5-password-secret" not in json.dumps(request)


def test_worker_api_treats_204_as_no_work_and_renews_exact_assignment():
    session = FakeHttpSession([
        FakeResponse(204),
        FakeResponse(200, {"connectorId": "connector-1", "renewed": True}),
    ])
    api = HostWorkerApi(
        "https://api.example.test/api/v1",
        "worker-accra-1",
        "w" * 32,
        session=session,
    )

    assert api.lease_assignment() is None
    api.heartbeat_assignment("connector-1", error_code="MT5_RECONNECTING")

    url, request = session.calls[1]
    assert url.endswith("/assignments/connector-1/heartbeat")
    assert request["json"] == {
        "workerId": "worker-accra-1",
        "errorCode": "MT5_RECONNECTING",
    }


def test_worker_api_reports_non_secret_presence_and_capacity():
    session = FakeHttpSession([FakeResponse(200, {"workerId": "worker-accra-1", "accepted": True})])
    api = HostWorkerApi(
        "https://api.example.test/api/v1",
        "worker-accra-1",
        "w" * 32,
        session=session,
    )

    api.heartbeat_worker_presence(
        worker_version="0.4.0",
        runtime_ready=True,
        max_sessions=4,
        active_sessions=1,
    )

    url, request = session.calls[0]
    assert url.endswith("/broker/direct-mt5/hosted-worker/presence")
    assert request["json"] == {
        "workerId": "worker-accra-1",
        "workerVersion": "0.4.0",
        "runtimeReady": True,
        "maxSessions": 4,
        "activeSessions": 1,
    }
    assert "Authorization" in request["headers"]
    assert "password" not in json.dumps(request["json"]).lower()
    assert "token" not in json.dumps(request["json"]).lower()


def test_prepare_session_directory_copies_clean_mt5_template_once(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture-terminal")
    (template / "config").mkdir()
    (template / "config" / "common.ini").write_text("fixture", encoding="utf-8")
    sessions = tmp_path / "sessions"

    first = prepare_session_directory(template, sessions, "connector-1", "terminal64.exe")
    (first / "journal.sqlite3").write_text("keep-me", encoding="utf-8")
    second = prepare_session_directory(template, sessions, "connector-1", "terminal64.exe")

    assert first == second
    assert (first / "terminal64.exe").read_bytes() == b"fixture-terminal"
    assert (second / "journal.sqlite3").read_text(encoding="utf-8") == "keep-me"


def test_child_process_spec_keeps_password_and_connector_token_out_of_argv_and_config(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("HOSTED_MT5_WORKER_TOKEN", "worker-secret-that-child-must-not-inherit")
    monkeypatch.setenv("BROKER_ENCRYPTION_KEY", "broker-key-that-child-must-not-inherit")
    session_dir = tmp_path / "connector-1"
    session_dir.mkdir()
    terminal_path = session_dir / "terminal64.exe"
    terminal_path.write_bytes(b"terminal")

    spec = build_session_child_spec(
        assignment(),
        server_url="https://api.example.test/api/v1",
        session_dir=session_dir,
        terminal_path=terminal_path,
        python_executable="python.exe",
    )

    argv_text = " ".join(spec.argv)
    assert "mt5-password-secret" not in argv_text
    assert "connector-token-secret" not in argv_text
    payload = json.loads(spec.stdin_payload)
    assert payload["tradingPassword"] == "mt5-password-secret"
    assert payload["connectorToken"] == "connector-token-secret"
    assert not (session_dir / "connector.json").exists()
    assert "HOSTED_MT5_WORKER_TOKEN" not in spec.env
    assert "BROKER_ENCRYPTION_KEY" not in spec.env


def test_frozen_host_worker_reenters_same_executable_for_session_child_without_python_module_flag(tmp_path: Path):
    session_dir = tmp_path / "connector-1"
    session_dir.mkdir()
    terminal_path = session_dir / "terminal64.exe"
    terminal_path.write_bytes(b"terminal")

    spec = build_session_child_spec(
        assignment(),
        server_url="https://api.example.test/api/v1",
        session_dir=session_dir,
        terminal_path=terminal_path,
        python_executable="iRexPro-MT5-Host-Worker.exe",
        frozen_executable=True,
    )

    assert spec.argv[0] == "iRexPro-MT5-Host-Worker.exe"
    assert spec.argv[1] == "--session-child"
    assert "-m" not in spec.argv
    assert "irexpro_mt5_connector.host_worker" not in spec.argv


def test_in_memory_secret_store_never_needs_a_disk_backend():
    store = InMemorySecretStore("connector-1", "secret-token")
    assert store.get("connector-1") == "secret-token"
    assert store.get("other") is None
    store.delete("connector-1")
    assert store.get("connector-1") is None
    store.set("connector-1", "rotated")
    assert store.get("connector-1") == "rotated"


class FakeKeyring:
    def __init__(self, stored=None):
        self.stored = stored
        self.get_calls = []
        self.set_calls = []

    def get_password(self, service, username):
        self.get_calls.append((service, username))
        return self.stored

    def set_password(self, service, username, password):
        self.set_calls.append((service, username, password))
        self.stored = password


def test_worker_token_loads_from_environment_or_windows_credential_store_without_argv():
    keyring = FakeKeyring("k" * 32)
    assert load_worker_token(
        "worker-accra-1",
        environ={"HOSTED_MT5_WORKER_TOKEN": "e" * 32},
        keyring_module=keyring,
    ) == "e" * 32
    assert keyring.get_calls == []

    assert load_worker_token(
        "worker-accra-1",
        environ={},
        keyring_module=keyring,
    ) == "k" * 32
    assert keyring.get_calls == [("irexpro.mt5.host-worker", "worker-accra-1")]


def test_worker_token_can_be_stored_in_credential_manager_without_a_cli_secret_argument():
    keyring = FakeKeyring()
    store_worker_token("worker-accra-1", "s" * 32, keyring_module=keyring)
    assert keyring.set_calls == [("irexpro.mt5.host-worker", "worker-accra-1", "s" * 32)]

    with pytest.raises(ValueError, match="at least 32"):
        store_worker_token("worker-accra-1", "short", keyring_module=keyring)


class FakeChild:
    def __init__(self, returncode=None):
        self.returncode = returncode
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class FakeWorkerApi:
    def __init__(self, assignments, presence_error=None):
        self.assignments = list(assignments)
        self.lease_calls = 0
        self.heartbeats = []
        self.presences = []
        self.presence_error = presence_error

    def heartbeat_worker_presence(self, **payload):
        self.presences.append(payload)
        if self.presence_error:
            raise self.presence_error

    def lease_assignment(self):
        self.lease_calls += 1
        item = self.assignments.pop(0) if self.assignments else None
        if isinstance(item, Exception):
            raise item
        return item

    def heartbeat_assignment(self, connector_id, error_code=None):
        self.heartbeats.append((connector_id, error_code))


def test_supervisor_reports_presence_even_with_zero_assignments(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    fake_api = FakeWorkerApi([])
    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=4,
        heartbeat_seconds=20,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, monotonic=lambda: 100.0)

    supervisor.tick()

    assert fake_api.presences == [
        {
            "worker_version": "0.4.1",
            "runtime_ready": True,
            "max_sessions": 4,
            "active_sessions": 0,
        }
    ]
    assert fake_api.lease_calls == 1


def test_supervisor_continues_leasing_when_presence_heartbeat_temporarily_fails(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    fake_api = FakeWorkerApi([None], presence_error=HostWorkerApiError("presence unavailable"))
    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=4,
        heartbeat_seconds=20,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, monotonic=lambda: 100.0)

    supervisor.tick()

    assert len(fake_api.presences) == 1
    assert fake_api.lease_calls == 1


def test_supervisor_enforces_capacity_and_renews_active_worker_lease(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    fake_api = FakeWorkerApi([assignment(), HostedAssignment.from_payload({**assignment_dict(), "connectorId": "connector-2"})])
    launched = []

    def launcher(spec):
        launched.append(spec)
        return FakeChild()

    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=1,
        heartbeat_seconds=0,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, launcher=launcher)

    supervisor.tick()
    supervisor.tick()

    assert len(launched) == 1
    assert fake_api.lease_calls == 1
    assert fake_api.heartbeats[-1] == ("connector-1", None)


def test_supervisor_reports_child_exit_with_bounded_code_then_allows_replacement(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    first = assignment()
    second = HostedAssignment.from_payload({**assignment_dict(), "connectorId": "connector-2"})
    fake_api = FakeWorkerApi([first, second])
    children = [FakeChild(returncode=7), FakeChild()]

    def launcher(_spec):
        return children.pop(0)

    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=1,
        heartbeat_seconds=0,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, launcher=launcher)

    supervisor.tick()
    supervisor.tick()

    assert ("connector-1", "SESSION_EXITED:7") in fake_api.heartbeats
    assert "connector-2" in supervisor.active_connector_ids


def test_supervisor_keeps_healthy_children_running_when_assignment_lease_api_is_temporarily_unavailable(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    fake_api = FakeWorkerApi([assignment(), HostWorkerApiError("temporary control-plane outage")])
    child = FakeChild()

    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=2,
        heartbeat_seconds=60,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, launcher=lambda _spec: child)

    supervisor.tick()

    assert supervisor.active_connector_ids == ("connector-1",)
    assert child.terminated is False
    assert fake_api.lease_calls == 2


def test_supervisor_isolates_one_assignment_launch_failure_from_existing_sessions(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    second = HostedAssignment.from_payload({**assignment_dict(), "connectorId": "connector-2"})
    fake_api = FakeWorkerApi([assignment(), second, None])
    healthy_child = FakeChild()
    launch_calls = 0

    def launcher(_spec):
        nonlocal launch_calls
        launch_calls += 1
        if launch_calls == 1:
            return healthy_child
        raise RuntimeError("broken MT5 template")

    config = HostWorkerConfig(
        server_url="https://api.example.test/api/v1",
        worker_id="worker-accra-1",
        worker_token="w" * 32,
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        max_sessions=2,
        heartbeat_seconds=60,
    )
    supervisor = HostedMt5WorkerSupervisor(config, api=fake_api, launcher=launcher)

    supervisor.tick()

    assert supervisor.active_connector_ids == ("connector-1",)
    assert healthy_child.terminated is False
    assert ("connector-2", "SESSION_LAUNCH_FAILED") in fake_api.heartbeats


def test_pilot_runtime_is_windows_only():
    with pytest.raises(RuntimeError, match="Windows"):
        validate_host_worker_runtime(platform_name="linux")
    validate_host_worker_runtime(platform_name="win32")


def test_worker_instance_lock_fails_fast_when_same_windows_worker_is_already_running(tmp_path: Path):
    class FakeMsvcrt:
        LK_NBLCK = 1
        LK_UNLCK = 2

        def __init__(self):
            self.locked = False
            self.calls = []

        def locking(self, fd, mode, count):
            self.calls.append((mode, count))
            if mode == self.LK_NBLCK:
                if self.locked:
                    raise OSError("already locked")
                self.locked = True
            elif mode == self.LK_UNLCK:
                self.locked = False

    fake = FakeMsvcrt()
    first = WorkerInstanceLock(
        tmp_path,
        "worker-accra-1",
        platform_name="win32",
        msvcrt_module=fake,
    )
    second = WorkerInstanceLock(
        tmp_path,
        "worker-accra-1",
        platform_name="win32",
        msvcrt_module=fake,
    )

    with first:
        with pytest.raises(RuntimeError, match="already running"):
            second.acquire()

    assert fake.locked is False
    assert (tmp_path / ".worker-accra-1.lock").exists()


def test_worker_main_holds_single_instance_lock_for_supervisor_lifetime(tmp_path: Path, monkeypatch):
    from irexpro_mt5_connector import host_worker

    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    sessions = tmp_path / "sessions"
    events = []

    class FakeLock:
        def __init__(self, session_root, worker_id):
            events.append(("lock-init", Path(session_root), worker_id))

        def __enter__(self):
            events.append(("lock-enter",))
            return self

        def __exit__(self, exc_type, exc, traceback):
            events.append(("lock-exit",))

    class FakeSupervisor:
        def __init__(self, config):
            events.append(("supervisor-init", config.worker_id))

        def run_forever(self):
            events.append(("supervisor-run",))
            return 0

    monkeypatch.setattr(host_worker, "validate_host_worker_runtime", lambda: None)
    monkeypatch.setattr(host_worker, "load_worker_token", lambda worker_id: "w" * 32)
    monkeypatch.setattr(host_worker, "WorkerInstanceLock", FakeLock)
    monkeypatch.setattr(host_worker, "HostedMt5WorkerSupervisor", FakeSupervisor)

    result = host_worker.main([
        "--server-url", "https://api.example.test/api/v1",
        "--worker-id", "worker-accra-1",
        "--mt5-template-dir", str(template),
        "--session-root", str(sessions),
    ])

    assert result == 0
    assert events[-3:] == [
        ("lock-enter",),
        ("supervisor-run",),
        ("lock-exit",),
    ]


def test_session_child_writes_only_non_secret_connector_config_and_keeps_credentials_in_memory(tmp_path: Path, monkeypatch):
    from irexpro_mt5_connector import host_worker

    session_dir = tmp_path / "session"
    terminal_path = session_dir / "terminal64.exe"
    session_dir.mkdir()
    terminal_path.write_bytes(b"fixture-terminal")
    captured = {}

    def fake_run_connector(**kwargs):
        from irexpro_mt5_connector.config import ConnectorSettings

        settings = ConnectorSettings.load(kwargs["config_path"])
        captured["settings"] = settings
        captured["token"] = kwargs["secret_store_factory"]().get("connector-1")
        terminal = kwargs["terminal_factory"](settings.terminal_path)
        captured["terminal_login"] = terminal._login
        captured["terminal_password"] = terminal._password
        captured["terminal_server"] = terminal._server
        captured["portable"] = terminal._portable
        return 0

    def fake_supervised(**kwargs):
        return kwargs["runner"](
            config_path=kwargs["config_path"],
            journal_path=kwargs["journal_path"],
            stop_event=None,
            on_status=None,
        )

    monkeypatch.setattr(host_worker, "run_connector", fake_run_connector)
    monkeypatch.setattr(host_worker, "run_supervised_connector", fake_supervised)

    assert run_session_child(
        server_url="https://api.example.test/api/v1",
        session_dir=session_dir,
        terminal_path=terminal_path,
        assignment_payload=assignment_dict(),
    ) == 0

    raw_config = (session_dir / "connector.json").read_text(encoding="utf-8")
    assert "mt5-password-secret" not in raw_config
    assert "connector-token-secret" not in raw_config
    assert captured["token"] == "connector-token-secret"
    assert captured["terminal_login"] == "113392789"
    assert captured["terminal_password"] == "mt5-password-secret"
    assert captured["terminal_server"] == "Broker-Demo"
    assert captured["portable"] is True
    assert captured["settings"].account_type == "DEMO"


def test_worker_url_validation_allows_only_https_or_true_loopback_http(tmp_path: Path):
    with pytest.raises(ValueError, match="HTTPS"):
        HostWorkerApi("http://evil.example.test/localhost/api/v1", "worker-1", "x" * 32)
    with pytest.raises(ValueError, match="HTTPS"):
        HostWorkerConfig(
            server_url="http://localhost.evil.example.test/api/v1",
            worker_id="worker-1",
            worker_token="x" * 32,
            mt5_template_dir=tmp_path,
            session_root=tmp_path / "sessions",
        )

    api = HostWorkerApi(
        "http://127.0.0.1:3001/api/v1",
        "worker-1",
        "x" * 32,
        session=FakeHttpSession([]),
    )
    assert api.server_url == "http://127.0.0.1:3001/api/v1"


def test_session_directory_rejects_windows_invalid_colon_in_connector_id(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")

    with pytest.raises(ValueError, match="connector id"):
        prepare_session_directory(template, tmp_path / "sessions", "connector:1")


def test_worker_cli_does_not_accept_worker_token_on_command_line():
    from irexpro_mt5_connector.host_worker import _build_parser

    parser = _build_parser()
    assert "--worker-token" not in parser.format_help()
    with pytest.raises(SystemExit):
        parser.parse_args(["--worker-token", "secret"])


def test_readiness_check_uses_no_worker_secret_and_does_not_lease_work(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    session = FakeHttpSession([FakeResponse(200, {"status": "alive"})])

    result = check_host_worker_readiness(
        server_url="https://api.example.test/api/v1",
        mt5_template_dir=template,
        session_root=tmp_path / "sessions",
        platform_name="win32",
        session=session,
    )

    assert result["status"] == "READY"
    assert result["apiReachable"] is True
    assert result["terminalPresent"] is True
    assert result["sessionRootWritable"] is True
    assert not (tmp_path / "sessions" / ".irexpro-readiness-probe").exists()
    assert len(session.calls) == 1
    url, request = session.calls[0]
    assert url == "https://api.example.test/api/v1/health/live"
    assert "Authorization" not in request.get("headers", {})
    assert "assignments/lease" not in url


def test_readiness_check_fails_closed_when_api_health_is_not_success(tmp_path: Path):
    template = tmp_path / "template"
    template.mkdir()
    (template / "terminal64.exe").write_bytes(b"fixture")
    session = FakeHttpSession([FakeResponse(503, {"status": "down"})])

    with pytest.raises(Exception, match="HTTP 503"):
        check_host_worker_readiness(
            server_url="https://api.example.test/api/v1",
            mt5_template_dir=template,
            session_root=tmp_path / "sessions",
            platform_name="win32",
            session=session,
        )
