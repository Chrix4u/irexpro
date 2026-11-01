from __future__ import annotations

import importlib
import json
import threading
from pathlib import Path

from irexpro_mt5_connector.config import ConnectorSettings
from irexpro_mt5_connector.mt5_terminal import AccountIdentity


class FakeTerminal:
    def __init__(self, _path=None):
        self.shutdown_calls = 0
        self.identity_value = AccountIdentity(
            login="12345",
            server="Broker-Demo",
            currency="USD",
            trade_allowed=True,
            account_type="DEMO",
        )

    def initialize(self):
        return self.identity_value

    def identity(self):
        return self.identity_value

    def shutdown(self):
        self.shutdown_calls += 1


class FakePairClient:
    def __init__(self, server_url, _secret_store):
        self.server_url = server_url

    def redeem_pairing(self, code, identity):
        assert code == "ABCDEFGH23"
        assert identity.login == "12345"
        return ConnectorSettings(
            server_url=self.server_url,
            connector_id="connector-1",
            broker_connection_id="connection-1",
            account_login=identity.login,
            broker_server=identity.server,
            account_type=identity.account_type,
        )


class FakeRunClient:
    def __init__(self, _server_url, _secret_store, stop_event):
        self.stop_event = stop_event
        self.heartbeats = 0
        self.identity_checks = 0

    def _assert_identity(self, settings, identity):
        assert settings.account_login == identity.login
        self.identity_checks += 1

    def heartbeat(self, _settings, _identity, _sequence):
        self.heartbeats += 1
        self.stop_event.set()

    def lease_next_command(self, _settings):
        return None


class FakeJournal:
    def __init__(self, _path):
        self.closed = False
        self.sequence = 0

    def next_heartbeat_sequence(self):
        self.sequence += 1
        return self.sequence

    def close(self):
        self.closed = True


def test_pair_connector_saves_protocol_v2_config_and_creates_parent(tmp_path: Path) -> None:
    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    config_path = tmp_path / "nested" / "connector.json"
    terminal = FakeTerminal()

    settings = runtime.pair_connector(
        server_url="https://irexpro.example",
        pairing_code="ABCDEFGH23",
        terminal_path=None,
        config_path=config_path,
        terminal_factory=lambda _path: terminal,
        client_factory=FakePairClient,
        secret_store_factory=lambda: object(),
    )

    data = json.loads(config_path.read_text(encoding="utf-8"))
    assert settings.account_type == "DEMO"
    assert data["account_type"] == "DEMO"
    assert "token" not in config_path.read_text(encoding="utf-8").lower()
    assert terminal.shutdown_calls == 1


def test_run_connector_honors_stop_signal_and_always_closes_resources(tmp_path: Path) -> None:
    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    config_path = tmp_path / "connector.json"
    ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="12345",
        broker_server="Broker-Demo",
        account_type="DEMO",
        poll_seconds=0.01,
    ).save(config_path)

    stop_event = threading.Event()
    terminal = FakeTerminal()
    journal = FakeJournal(tmp_path / "journal.db")
    client = FakeRunClient("https://irexpro.example", object(), stop_event)
    statuses: list[str] = []

    result = runtime.run_connector(
        config_path=config_path,
        journal_path=tmp_path / "journal.db",
        stop_event=stop_event,
        on_status=statuses.append,
        terminal_factory=lambda _path: terminal,
        client_factory=lambda _url, _store: client,
        secret_store_factory=lambda: object(),
        journal_factory=lambda _path: journal,
        sleep_fn=lambda _seconds: None,
    )

    assert result == 0
    assert client.heartbeats == 1
    assert client.identity_checks >= 1
    assert journal.closed is True
    assert terminal.shutdown_calls == 1
    assert statuses[0] == "STARTING"
    assert "READY" in statuses
    assert statuses[-1] == "STOPPED"


def test_gui_uses_per_user_app_data_and_normalizes_pairing_code(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    gui = importlib.import_module("irexpro_mt5_connector.gui")

    paths = gui.connector_paths()
    assert paths.config == tmp_path / "iRexPro" / "MT5Connector" / "connector.json"
    assert paths.journal == tmp_path / "iRexPro" / "MT5Connector" / "journal.db"
    assert gui.normalize_pairing_code("abcd-efgh23") == "ABCDEFGH23"


def test_gui_rejects_invalid_pairing_code() -> None:
    gui = importlib.import_module("irexpro_mt5_connector.gui")
    try:
        gui.normalize_pairing_code("123")
    except ValueError as exc:
        assert "10-character" in str(exc)
    else:
        raise AssertionError("invalid pairing code must be refused before network access")


def test_supervisor_retries_transient_failures_and_resets_after_ready(tmp_path: Path) -> None:
    import requests
    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    stop_event = threading.Event()
    calls: list[int] = []
    waits: list[float] = []
    statuses: list[str] = []

    def runner(**kwargs):
        calls.append(len(calls) + 1)
        if len(calls) == 1:
            raise requests.ConnectionError("offline")
        kwargs["on_status"]("READY")
        return 0

    result = runtime.run_supervised_connector(
        config_path=tmp_path / "connector.json",
        journal_path=tmp_path / "journal.db",
        stop_event=stop_event,
        on_status=statuses.append,
        runner=runner,
        wait_fn=lambda _event, seconds: waits.append(seconds) or False,
    )

    assert result == 0
    assert calls == [1, 2]
    assert waits == [1.0]
    assert any(status.startswith("RECONNECTING") for status in statuses)
    assert "READY" in statuses


def test_supervisor_does_not_retry_fatal_connector_error(tmp_path: Path) -> None:
    import pytest
    from irexpro_mt5_connector.client import ConnectorApiError

    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    calls = 0

    def runner(**_kwargs):
        nonlocal calls
        calls += 1
        raise ConnectorApiError("connector token is unavailable; pair again")

    with pytest.raises(ConnectorApiError, match="pair again"):
        runtime.run_supervised_connector(
            config_path=tmp_path / "connector.json",
            journal_path=tmp_path / "journal.db",
            runner=runner,
            wait_fn=lambda _event, _seconds: False,
        )

    assert calls == 1


def test_protocol_v2_settings_default_to_unattended_start_for_existing_configs(tmp_path: Path) -> None:
    path = tmp_path / "connector.json"
    path.write_text(
        json.dumps(
            {
                "server_url": "https://irexpro.example/api/v1",
                "connector_id": "connector-1",
                "broker_connection_id": "connection-1",
                "account_login": "12345",
                "broker_server": "Broker-Demo",
                "account_type": "DEMO",
            }
        ),
        encoding="utf-8",
    )

    settings = ConnectorSettings.load(path)
    assert settings.auto_start is True
    assert settings.start_minimized is True


def test_windows_autostart_command_quotes_executable_and_uses_background_flag() -> None:
    windows = importlib.import_module("irexpro_mt5_connector.windows")
    command = windows.build_autostart_command(r"C:\Program Files\iRexPro MT5 Connector\iRexPro-MT5-Connector.exe")
    assert command == '"C:\\Program Files\\iRexPro MT5 Connector\\iRexPro-MT5-Connector.exe" --background'


def test_pair_connector_persists_unattended_windows_preferences(tmp_path: Path) -> None:
    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    config_path = tmp_path / "connector.json"
    terminal = FakeTerminal()

    settings = runtime.pair_connector(
        server_url="https://irexpro.example",
        pairing_code="ABCDEFGH23",
        terminal_path=None,
        config_path=config_path,
        auto_start=False,
        start_minimized=False,
        terminal_factory=lambda _path: terminal,
        client_factory=FakePairClient,
        secret_store_factory=lambda: object(),
    )

    assert settings.auto_start is False
    assert settings.start_minimized is False
    reloaded = ConnectorSettings.load(config_path)
    assert reloaded.auto_start is False
    assert reloaded.start_minimized is False


def test_gui_background_launch_contract() -> None:
    gui = importlib.import_module("irexpro_mt5_connector.gui")
    assert gui.background_requested(["connector.exe", "--background"]) is True
    assert gui.background_requested(["connector.exe"]) is False


def test_successful_mt5_mutation_is_never_relabelled_failed_when_result_upload_disconnects(tmp_path: Path) -> None:
    import pytest
    import requests
    from irexpro_mt5_connector.journal import CommandJournal

    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    config_path = tmp_path / "connector.json"
    journal_path = tmp_path / "journal.db"
    ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="12345",
        broker_server="Broker-Demo",
        account_type="DEMO",
    ).save(config_path)

    class TradingTerminal(FakeTerminal):
        def place_order(self, payload):
            return {"ticket": "1001", "symbol": payload["symbol"]}

    class DisconnectingResultClient:
        def __init__(self):
            self.leased = False
            self.result_states: list[str] = []

        def _assert_identity(self, _settings, _identity):
            return None

        def heartbeat(self, _settings, _identity, _sequence):
            return None

        def lease_next_command(self, _settings):
            if self.leased:
                return None
            self.leased = True
            return {
                "commandId": "cmd-1",
                "idempotencyKey": "intent-1",
                "commandType": "PLACE_ORDER",
                "connectorId": "connector-1",
                "brokerConnectionId": "connection-1",
                "accountLogin": "12345",
                "brokerServer": "Broker-Demo",
                "accountType": "DEMO",
                "payload": {"symbol": "EURUSD", "side": "BUY", "volume": "0.20"},
            }

        def submit_result(self, _settings, _command_id, *, state, result, error=None):
            self.result_states.append(state)
            raise requests.ConnectionError("internet dropped while reporting result")

    client = DisconnectingResultClient()
    with pytest.raises(requests.ConnectionError, match="internet dropped"):
        runtime.run_connector(
            config_path=config_path,
            journal_path=journal_path,
            stop_event=threading.Event(),
            terminal_factory=lambda _path: TradingTerminal(),
            client_factory=lambda _url, _store: client,
            secret_store_factory=lambda: object(),
            sleep_fn=lambda _seconds: None,
        )

    journal = CommandJournal(journal_path)
    try:
        entry = journal.get_by_command_id("cmd-1")
        assert entry is not None
        assert entry.state == "SUCCEEDED"
        assert entry.result == {"ticket": "1001", "symbol": "EURUSD"}
    finally:
        journal.close()
    assert client.result_states == ["SUCCEEDED"]


def test_supervisor_does_not_retry_ambiguous_local_os_errors(tmp_path: Path) -> None:
    import pytest
    runtime = importlib.import_module("irexpro_mt5_connector.runtime")
    calls = 0

    def runner(**_kwargs):
        nonlocal calls
        calls += 1
        raise OSError("disk full")

    def must_not_wait(_event, _seconds):
        raise AssertionError("local OS errors must fail closed rather than enter retry backoff")

    with pytest.raises(OSError, match="disk full"):
        runtime.run_supervised_connector(
            config_path=tmp_path / "connector.json",
            journal_path=tmp_path / "journal.db",
            runner=runner,
            wait_fn=must_not_wait,
        )
    assert calls == 1
