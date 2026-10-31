from __future__ import annotations

from typing import Any, Mapping

import requests

from .config import ConnectorSettings, SecretStore
from .mt5_terminal import AccountIdentity
from .protocol import validate_command


class ConnectorApiError(RuntimeError):
    pass


class IrexProConnectorClient:
    def __init__(
        self,
        server_url: str,
        secret_store: SecretStore,
        session: requests.Session | None = None,
        timeout_seconds: float = 15.0,
    ) -> None:
        self.server_url = server_url.rstrip("/")
        if not self.server_url.startswith("https://") and "localhost" not in self.server_url:
            raise ValueError("direct MT5 connector requires HTTPS")
        self.secret_store = secret_store
        self.session = session or requests.Session()
        self.timeout_seconds = timeout_seconds

    def redeem_pairing(self, pairing_code: str, identity: AccountIdentity) -> ConnectorSettings:
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/connectors/redeem",
            json={
                "pairingCode": pairing_code,
                "accountLogin": identity.login,
                "brokerServer": identity.server,
                "currency": identity.currency,
                "tradeAllowed": identity.trade_allowed,
                "accountType": identity.account_type,
            },
            timeout=self.timeout_seconds,
        )
        data = self._json(response)
        token = data.get("connectorToken")
        connector_id = data.get("connectorId")
        broker_connection_id = data.get("brokerConnectionId")
        if not all(isinstance(item, str) and item for item in (token, connector_id, broker_connection_id)):
            raise ConnectorApiError("pairing response is missing connector identity")
        self.secret_store.set(connector_id, token)
        return ConnectorSettings(
            server_url=self.server_url,
            connector_id=connector_id,
            broker_connection_id=broker_connection_id,
            account_login=identity.login,
            broker_server=identity.server,
            account_type=identity.account_type,
        )

    def heartbeat(self, settings: ConnectorSettings, identity: AccountIdentity, sequence: int) -> None:
        self._assert_identity(settings, identity)
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/connectors/{settings.connector_id}/heartbeat",
            headers=self._headers(settings.connector_id),
            json={
                "brokerConnectionId": settings.broker_connection_id,
                "accountLogin": identity.login,
                "brokerServer": identity.server,
                "sequence": sequence,
                "terminalConnected": True,
                "tradingAllowed": identity.trade_allowed,
                "accountType": identity.account_type,
            },
            timeout=self.timeout_seconds,
        )
        self._assert_ok(response)

    def lease_next_command(self, settings: ConnectorSettings) -> dict[str, Any] | None:
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/connectors/{settings.connector_id}/commands/lease",
            headers=self._headers(settings.connector_id),
            json={
                "brokerConnectionId": settings.broker_connection_id,
                "accountLogin": settings.account_login,
                "brokerServer": settings.broker_server,
                "accountType": settings.account_type,
            },
            timeout=self.timeout_seconds,
        )
        if response.status_code == 204:
            return None
        data = self._json(response)
        return validate_command(data)

    def submit_result(
        self,
        settings: ConnectorSettings,
        command_id: str,
        *,
        state: str,
        result: Mapping[str, Any] | None,
        error: str | None = None,
    ) -> None:
        response = self.session.post(
            f"{self.server_url}/broker/direct-mt5/connectors/{settings.connector_id}/commands/{command_id}/result",
            headers=self._headers(settings.connector_id),
            json={
                "brokerConnectionId": settings.broker_connection_id,
                "accountLogin": settings.account_login,
                "brokerServer": settings.broker_server,
                "accountType": settings.account_type,
                "state": state,
                "result": dict(result) if result is not None else None,
                "error": error,
            },
            timeout=self.timeout_seconds,
        )
        self._assert_ok(response)

    def _headers(self, connector_id: str) -> dict[str, str]:
        token = self.secret_store.get(connector_id)
        if not token:
            raise ConnectorApiError("connector token is unavailable; pair again")
        return {"Authorization": f"Bearer {token}", "User-Agent": "iRexPro-MT5-Connector/0.1"}

    @staticmethod
    def _assert_identity(settings: ConnectorSettings, identity: AccountIdentity) -> None:
        if (
            identity.login != settings.account_login
            or identity.server != settings.broker_server
            or identity.account_type != settings.account_type
        ):
            raise ConnectorApiError(
                "MT5 terminal account changed after pairing; execution suspended until re-paired"
            )

    def _json(self, response: requests.Response) -> dict[str, Any]:
        self._assert_ok(response)
        try:
            data = response.json()
        except ValueError as exc:
            raise ConnectorApiError("iRexPro returned invalid JSON") from exc
        if not isinstance(data, dict):
            raise ConnectorApiError("iRexPro returned invalid response shape")
        return data

    @staticmethod
    def _assert_ok(response: requests.Response) -> None:
        if 200 <= response.status_code < 300:
            return
        # Never include Authorization/request headers in errors.
        body = response.text[:500]
        raise ConnectorApiError(f"iRexPro API request failed ({response.status_code}): {body}")
