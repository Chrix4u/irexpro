from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class ConnectorSettings:
    server_url: str
    connector_id: str
    broker_connection_id: str
    account_login: str
    broker_server: str
    account_type: str
    terminal_path: str | None = None
    poll_seconds: float = 1.0

    @classmethod
    def load(cls, path: str | Path) -> "ConnectorSettings":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**data)

    def save(self, path: str | Path) -> None:
        # Intentionally contains NO connector token and NO MT5 password.
        Path(path).write_text(json.dumps(asdict(self), indent=2, sort_keys=True), encoding="utf-8")


class SecretStore(Protocol):
    def get(self, connector_id: str) -> str | None: ...
    def set(self, connector_id: str, token: str) -> None: ...
    def delete(self, connector_id: str) -> None: ...


class KeyringSecretStore:
    SERVICE_NAME = "iRexPro Direct MT5 Connector"

    @staticmethod
    def _keyring():
        import keyring

        return keyring

    def get(self, connector_id: str) -> str | None:
        return self._keyring().get_password(self.SERVICE_NAME, connector_id)

    def set(self, connector_id: str, token: str) -> None:
        if not token:
            raise ValueError("connector token must not be empty")
        self._keyring().set_password(self.SERVICE_NAME, connector_id, token)

    def delete(self, connector_id: str) -> None:
        try:
            self._keyring().delete_password(self.SERVICE_NAME, connector_id)
        except Exception:
            # Deleting an already-absent credential is idempotent.
            pass
