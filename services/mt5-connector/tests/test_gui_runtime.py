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
