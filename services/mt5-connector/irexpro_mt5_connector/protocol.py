from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping

PROTOCOL_VERSION = "irexpro-direct-mt5-v2"

COMMAND_TYPES = (
    "ACCOUNT_SNAPSHOT",
    "GET_PRICE",
    "GET_OHLCV",
    "LIST_SYMBOLS",
    "GET_SYMBOL_INFO",
    "CALCULATE_MARGIN",
    "PLACE_ORDER",
    "MODIFY_ORDER",
    "CLOSE_ORDER",
    "CLOSE_ALL",
    "LIST_POSITIONS",
    "LIST_ORDERS",
    "GET_ORDER",
    "GET_HISTORY",
)

EVENT_TYPES = (
    "HELLO",
    "HEARTBEAT",
    "ACCOUNT_STATE",
    "COMMAND_RESULT",
    "POSITION_EVENT",
    "ORDER_EVENT",
    "DEAL_EVENT",
    "ERROR",
)


class ProtocolError(ValueError):
    pass


def _required_text(value: Mapping[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item.strip():
        raise ProtocolError(f"{key} must be a non-empty string")
    return item


def _required_account_type(value: Mapping[str, Any]) -> str:
    account_type = _required_text(value, "accountType")
    if account_type not in {"DEMO", "LIVE"}:
        raise ProtocolError("accountType must be DEMO or LIVE")
    return account_type


def _required_timestamp(value: Mapping[str, Any], key: str) -> str:
    raw = _required_text(value, key)
    try:
        datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ProtocolError(f"{key} must be an ISO timestamp") from exc
    return raw


def validate_command(value: Mapping[str, Any]) -> dict[str, Any]:
    if value.get("protocolVersion") != PROTOCOL_VERSION:
        raise ProtocolError("unsupported protocolVersion")
    command_type = _required_text(value, "commandType")
    if command_type not in COMMAND_TYPES:
        raise ProtocolError(f"unsupported commandType: {command_type}")

    created_at = _required_timestamp(value, "createdAt")
    lease_expires_at = _required_timestamp(value, "leaseExpiresAt")
    created = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    lease = datetime.fromisoformat(lease_expires_at.replace("Z", "+00:00"))
    if lease <= created:
        raise ProtocolError("leaseExpiresAt must be after createdAt")

    payload = value.get("payload")
    if not isinstance(payload, dict):
        raise ProtocolError("payload must be an object")

    return {
        "protocolVersion": PROTOCOL_VERSION,
        "commandId": _required_text(value, "commandId"),
        "idempotencyKey": _required_text(value, "idempotencyKey"),
        "connectorId": _required_text(value, "connectorId"),
        "brokerConnectionId": _required_text(value, "brokerConnectionId"),
        "accountLogin": _required_text(value, "accountLogin"),
        "brokerServer": _required_text(value, "brokerServer"),
        "accountType": _required_account_type(value),
        "commandType": command_type,
        "createdAt": created_at,
        "leaseExpiresAt": lease_expires_at,
        "payload": payload,
    }


def assert_bound_identity(
    command: Mapping[str, Any],
    *,
    connector_id: str,
    broker_connection_id: str,
    account_login: str,
    broker_server: str,
    account_type: str,
) -> None:
    expected = {
        "connectorId": connector_id,
        "brokerConnectionId": broker_connection_id,
        "accountLogin": account_login,
        "brokerServer": broker_server,
        "accountType": account_type,
    }
    for key, expected_value in expected.items():
        if command.get(key) != expected_value:
            raise ProtocolError(f"{key} does not match paired connector identity")
