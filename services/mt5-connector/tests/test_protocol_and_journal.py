from pathlib import Path

import pytest

from irexpro_mt5_connector.journal import CommandJournal
from irexpro_mt5_connector.protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    assert_bound_identity,
    validate_command,
)


def command(command_id: str = "cmd-1", key: str = "intent-1") -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "commandId": command_id,
        "idempotencyKey": key,
        "connectorId": "connector-1",
        "brokerConnectionId": "connection-1",
        "accountLogin": "113392789",
        "brokerServer": "Broker-Demo",
        "commandType": "PLACE_ORDER",
        "createdAt": "2026-10-24T18:00:00.000Z",
        "leaseExpiresAt": "2026-10-24T18:00:30.000Z",
        "payload": {"symbol": "EURUSD", "side": "BUY", "volume": "0.20"},
    }


def test_protocol_rejects_wrong_account_binding() -> None:
    parsed = validate_command(command())
    with pytest.raises(ProtocolError, match="accountLogin"):
        assert_bound_identity(
            parsed,
            connector_id="connector-1",
            broker_connection_id="connection-1",
            account_login="999",
            broker_server="Broker-Demo",
        )


def test_duplicate_command_id_returns_journaled_result(tmp_path: Path) -> None:
    journal = CommandJournal(tmp_path / "journal.db")
    try:
        first = journal.begin(command())
        assert first.state == "EXECUTING"
        done = journal.complete("cmd-1", {"ticket": "1001", "status": "FILLED"})
        assert done.state == "SUCCEEDED"

        duplicate = journal.begin(command())
        assert duplicate.state == "SUCCEEDED"
        assert duplicate.result == {"status": "FILLED", "ticket": "1001"}
    finally:
        journal.close()


def test_same_idempotency_key_never_starts_second_command(tmp_path: Path) -> None:
    journal = CommandJournal(tmp_path / "journal.db")
    try:
        journal.begin(command("cmd-1", "intent-1"))
        journal.complete("cmd-1", {"ticket": "1001"})
        duplicate = journal.begin(command("cmd-2", "intent-1"))
        assert duplicate.command_id == "cmd-1"
        assert duplicate.state == "SUCCEEDED"
    finally:
        journal.close()


def test_restart_turns_interrupted_execution_into_uncertain(tmp_path: Path) -> None:
    path = tmp_path / "journal.db"
    first = CommandJournal(path)
    first.begin(command())
    first.close()

    recovered = CommandJournal(path)
    try:
        entry = recovered.get_by_command_id("cmd-1")
        assert entry is not None
        assert entry.state == "UNCERTAIN"
        assert recovered.begin(command()).state == "UNCERTAIN"
    finally:
        recovered.close()


def test_heartbeat_sequence_remains_monotonic_across_connector_restart(tmp_path: Path) -> None:
    path = tmp_path / "journal.db"
    first = CommandJournal(path)
    try:
        assert first.next_heartbeat_sequence() == 1
        assert first.next_heartbeat_sequence() == 2
    finally:
        first.close()

    recovered = CommandJournal(path)
    try:
        assert recovered.next_heartbeat_sequence() == 3
    finally:
        recovered.close()
