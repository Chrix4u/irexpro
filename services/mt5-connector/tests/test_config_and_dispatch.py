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
        account_type="DEMO",
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
        account_type="DEMO",
    )
    changed = AccountIdentity(
        login="999999",
        server="Other-Server",
        currency="USD",
        trade_allowed=True,
        account_type="LIVE",
    )
    try:
        IrexProConnectorClient._assert_identity(settings, changed)
    except ConnectorApiError as exc:
        assert "changed after pairing" in str(exc)
    else:
        raise AssertionError("account switch must fail closed")


def test_connector_rejects_environment_switch_even_when_login_and_server_match() -> None:
    from irexpro_mt5_connector.client import ConnectorApiError, IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    settings = ConnectorSettings(
        server_url="https://irexpro.example",
        connector_id="connector-1",
        broker_connection_id="connection-1",
        account_login="113392789",
        broker_server="Broker",
        account_type="DEMO",
    )
    changed = AccountIdentity(
        login="113392789", server="Broker", currency="USD", trade_allowed=True, account_type="LIVE"
    )
    try:
        IrexProConnectorClient._assert_identity(settings, changed)
    except ConnectorApiError as exc:
        assert "changed after pairing" in str(exc)
    else:
        raise AssertionError("account environment switch must fail closed")


def test_legacy_v1_settings_require_upgrade_and_repair(tmp_path: Path) -> None:
    path = tmp_path / "legacy.json"
    path.write_text(
        json.dumps(
            {
                "server_url": "https://irexpro.example",
                "connector_id": "connector-1",
                "broker_connection_id": "connection-1",
                "account_login": "113392789",
                "broker_server": "Broker-Demo",
            }
        ),
        encoding="utf-8",
    )

    try:
        ConnectorSettings.load(path)
    except ValueError as exc:
        message = str(exc).lower()
        assert "protocol v2" in message
        assert "re-pair" in message
    else:
        raise AssertionError("legacy protocol-v1 settings must fail closed")


def test_pairing_accepts_single_data_envelope_and_persists_connector_secret() -> None:
    from irexpro_mt5_connector.client import IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    class Store:
        def __init__(self):
            self.values = {}
        def get(self, connector_id): return self.values.get(connector_id)
        def set(self, connector_id, token): self.values[connector_id] = token
        def delete(self, connector_id): self.values.pop(connector_id, None)

    class Response:
        status_code = 201
        text = ""
        def json(self):
            return {
                "data": {
                    "connectorId": "connector-1",
                    "brokerConnectionId": "connection-1",
                    "connectorToken": "connector-token-secret",
                }
            }

    class Session:
        def post(self, _url, **_kwargs): return Response()

    store = Store()
    client = IrexProConnectorClient(
        "https://irexpro.lightworldtech.com/api/v1",
        store,
        session=Session(),
    )
    settings = client.redeem_pairing(
        "ABCDEFGH23",
        AccountIdentity(
            login="113392789",
            server="Broker-Demo",
            currency="USD",
            trade_allowed=True,
            account_type="DEMO",
        ),
    )

    assert settings.connector_id == "connector-1"
    assert settings.broker_connection_id == "connection-1"
    assert store.values == {"connector-1": "connector-token-secret"}


def test_pairing_accepts_repeated_data_envelopes_without_losing_connector_identity() -> None:
    from irexpro_mt5_connector.client import IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    class Store:
        def __init__(self): self.values = {}
        def get(self, connector_id): return self.values.get(connector_id)
        def set(self, connector_id, token): self.values[connector_id] = token
        def delete(self, connector_id): self.values.pop(connector_id, None)

    class Response:
        status_code = 201
        text = ""
        def json(self):
            return {
                "data": {
                    "data": {
                        "connectorId": "connector-2",
                        "brokerConnectionId": "connection-2",
                        "connectorToken": "connector-token-secret-2",
                    }
                }
            }

    class Session:
        def post(self, _url, **_kwargs): return Response()

    store = Store()
    client = IrexProConnectorClient("https://irexpro.lightworldtech.com/api/v1", store, session=Session())
    settings = client.redeem_pairing(
        "ABCDEFGH23",
        AccountIdentity(login="113392789", server="Broker-Demo", currency="USD", trade_allowed=True, account_type="DEMO"),
    )

    assert settings.connector_id == "connector-2"
    assert settings.broker_connection_id == "connection-2"
    assert store.values == {"connector-2": "connector-token-secret-2"}


def test_pairing_still_fails_closed_when_nested_identity_is_incomplete() -> None:
    from irexpro_mt5_connector.client import ConnectorApiError, IrexProConnectorClient
    from irexpro_mt5_connector.mt5_terminal import AccountIdentity

    class Store:
        def get(self, _connector_id): return None
        def set(self, _connector_id, _token): raise AssertionError("secret must not be stored")
        def delete(self, _connector_id): return None

    class Response:
        status_code = 201
        text = ""
        def json(self): return {"data": {"connectorId": "connector-1"}}

    class Session:
        def post(self, _url, **_kwargs): return Response()

    client = IrexProConnectorClient("https://irexpro.example/api/v1", Store(), session=Session())
    try:
        client.redeem_pairing(
            "ABCDEFGH23",
            AccountIdentity(
                login="113392789",
                server="Broker-Demo",
                currency="USD",
                trade_allowed=True,
                account_type="DEMO",
            ),
        )
    except ConnectorApiError as exc:
        assert "missing connector identity" in str(exc)
    else:
        raise AssertionError("incomplete pairing identity must fail closed")


def test_connector_client_normalizes_site_root_to_api_v1() -> None:
    from irexpro_mt5_connector.client import IrexProConnectorClient

    class Store:
        def get(self, _connector_id): return None
        def set(self, _connector_id, _token): return None
        def delete(self, _connector_id): return None

    root = IrexProConnectorClient("https://irexpro.lightworldtech.com", Store())
    api = IrexProConnectorClient("https://irexpro.lightworldtech.com/api/v1", Store())

    assert root.server_url == "https://irexpro.lightworldtech.com/api/v1"
    assert api.server_url == "https://irexpro.lightworldtech.com/api/v1"


def test_server_5xx_is_retryable_but_authentication_failure_is_fatal() -> None:
    from irexpro_mt5_connector.client import ConnectorApiError, ConnectorTransientError, IrexProConnectorClient

    class Response:
        def __init__(self, status_code: int, text: str):
            self.status_code = status_code
            self.text = text

    try:
        IrexProConnectorClient._assert_ok(Response(503, "maintenance"))
    except ConnectorTransientError as exc:
        assert "503" in str(exc)
    else:
        raise AssertionError("server 5xx must be retryable")

    try:
        IrexProConnectorClient._assert_ok(Response(401, "revoked"))
    except ConnectorTransientError:
        raise AssertionError("authentication failures must not be retried")
    except ConnectorApiError as exc:
        assert "401" in str(exc)
    else:
        raise AssertionError("401 must fail closed")
