import json
from pathlib import Path

from irexpro_mt5_connector.config import ConnectorSettings
from irexpro_mt5_connector.journal import CommandJournal
from irexpro_mt5_connector.main import _dispatch


class FakeTerminal:
    def __init__(self) -> None:
        self.place_calls = 0

    def place_order(self, payload):
        self.place_calls += 1
        return {"ticket": "1001", "symbol": payload["symbol"]}

    def account_snapshot(self): return {"login": "1"}
    def current_price(self, symbol): return {"symbol": symbol}
    def calculate_margin(self, symbol, side, volume): return {"margin": "10"}
    def list_positions(self): return []
    def list_orders(self): return []
    def modify_order(self, payload): return {"modified": True}
    def close_order(self, payload): return {"closed": True}


def test_settings_file_contains_no_password_or_connector_token(tmp_path: Path) -> None:
    path = tmp_path / "connector.json"
    ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="113392789",
        broker_server="Broker-Demo",
    ).save(path)
    raw = path.read_text(encoding="utf-8")
    data = json.loads(raw)
    assert "password" not in raw.lower()
    assert "token" not in raw.lower()
    assert data["account_login"] == "113392789"


def test_journal_prevents_duplicate_place_order_dispatch(tmp_path: Path) -> None:
    terminal = FakeTerminal()
    journal = CommandJournal(tmp_path / "journal.db")
    command = {
        "commandId": "cmd-1",
        "idempotencyKey": "intent-1",
        "commandType": "PLACE_ORDER",
        "payload": {"symbol": "EURUSD", "side": "BUY", "volume": "0.20"},
    }
    try:
        first = journal.begin(command)
        assert first.state == "EXECUTING"
        result = _dispatch(terminal, command["commandType"], command["payload"])
        journal.complete(command["commandId"], result)

        duplicate = journal.begin(command)
        assert duplicate.state == "SUCCEEDED"
        assert terminal.place_calls == 1
    finally:
        journal.close()


def test_connector_rejects_terminal_account_switch() -> None:
    from irexpro_mt5_connector.client import ConnectorApiError, IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    settings = ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="113392789",
        broker_server="Broker-Demo",
    )
    changed = AccountIdentity(
        login="999999",
        server="Other-Server",
        company="Other Broker",
        environment="DEMO",
        currency="USD",
        leverage=100,
        margin_mode="HEDGING",
        terminal_connected=True,
        terminal_trade_allowed=True,
        account_trade_allowed=True,
        ea_trading_allowed=True,
        trade_allowed=True,
    )
    try:
        IrexProConnectorClient._assert_identity(settings, changed)
    except ConnectorApiError as exc:
        assert "changed after pairing" in str(exc)
    else:
        raise AssertionError("account switch must fail closed")


def test_heartbeat_reports_full_native_mt5_identity() -> None:
    from irexpro_mt5_connector.client import IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    class SecretStore:
        def get(self, connector_id): return "connector-token"
        def set(self, connector_id, token): pass
        def delete(self, connector_id): pass

    class Response:
        status_code = 200
        text = ""
        def json(self): return {}

    class Session:
        def __init__(self): self.calls = []
        def post(self, url, **kwargs):
            self.calls.append((url, kwargs))
            return Response()

    session = Session()
    client = IrexProConnectorClient("https://irexpro.example", SecretStore(), session=session)
    settings = ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="113392789",
        broker_server="Broker-Demo",
    )
    identity = AccountIdentity(
        login="113392789",
        server="Broker-Demo",
        company="Broker Ltd",
        environment="DEMO",
        currency="USD",
        leverage=100,
        margin_mode="HEDGING",
        terminal_connected=True,
        terminal_trade_allowed=True,
        account_trade_allowed=True,
        ea_trading_allowed=True,
        trade_allowed=True,
    )

    client.heartbeat(settings, identity, 9)

    payload = session.calls[0][1]["json"]
    assert payload["environment"] == "DEMO"
    assert payload["company"] == "Broker Ltd"
    assert payload["currency"] == "USD"
    assert payload["leverage"] == 100
    assert payload["marginMode"] == "HEDGING"
    assert payload["terminalConnected"] is True
    assert payload["terminalTradeAllowed"] is True
    assert payload["accountTradeAllowed"] is True
    assert payload["eaTradingAllowed"] is True
