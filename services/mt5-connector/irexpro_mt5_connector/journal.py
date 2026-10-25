from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


@dataclass(frozen=True)
class JournalEntry:
    command_id: str
    idempotency_key: str
    state: str
    result: dict[str, Any] | None


class CommandJournal:
    """Durable local exactly-once guard for connector commands.

    A command is inserted as EXECUTING before the MT5 call. If the connector
    crashes after broker dispatch but before a terminal result is journaled,
    the surviving EXECUTING row is promoted to UNCERTAIN on next access and is
    never automatically re-dispatched. Server-side reconciliation resolves it.
    """

    TERMINAL_STATES = {"SUCCEEDED", "FAILED", "UNCERTAIN"}

    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self._db = sqlite3.connect(self.path)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=FULL")
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS command_journal (
                command_id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL,
                result_json TEXT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        self._db.execute(
            """
            CREATE TABLE IF NOT EXISTS connector_state (
                key TEXT PRIMARY KEY,
                integer_value INTEGER NOT NULL
            )
            """
        )
        self._db.commit()
        self._recover_interrupted()

    def close(self) -> None:
        self._db.close()

    def next_heartbeat_sequence(self) -> int:
        """Return a durable strictly-increasing heartbeat sequence.

        The counter lives beside the command journal so a process/Windows
        restart cannot reset the connector to sequence 1 and trigger the
        server's replay protection.
        """
        self._db.execute(
            """
            INSERT INTO connector_state(key, integer_value)
            VALUES ('heartbeat_sequence', 1)
            ON CONFLICT(key) DO UPDATE
              SET integer_value = connector_state.integer_value + 1
            """
        )
        row = self._db.execute(
            "SELECT integer_value FROM connector_state WHERE key = 'heartbeat_sequence'"
        ).fetchone()
        self._db.commit()
        if row is None:
            raise RuntimeError("heartbeat sequence state unavailable")
        return int(row[0])

    def _recover_interrupted(self) -> None:
        self._db.execute(
            """
            UPDATE command_journal
               SET state = 'UNCERTAIN', updated_at = CURRENT_TIMESTAMP
             WHERE state = 'EXECUTING'
            """
        )
        self._db.commit()

    def begin(self, command: Mapping[str, Any]) -> JournalEntry:
        command_id = str(command["commandId"])
        idempotency_key = str(command["idempotencyKey"])
        existing = self.get_by_command_id(command_id)
        if existing:
            return existing

        by_key = self.get_by_idempotency_key(idempotency_key)
        if by_key:
            return by_key

        try:
            self._db.execute(
                """
                INSERT INTO command_journal(command_id, idempotency_key, state)
                VALUES (?, ?, 'EXECUTING')
                """,
                (command_id, idempotency_key),
            )
            self._db.commit()
        except sqlite3.IntegrityError:
            # Handles a race with another worker/process using the same journal.
            self._db.rollback()
            return self.get_by_command_id(command_id) or self.get_by_idempotency_key(
                idempotency_key
            ) or JournalEntry(command_id, idempotency_key, "UNCERTAIN", None)
        return JournalEntry(command_id, idempotency_key, "EXECUTING", None)

    def complete(self, command_id: str, result: Mapping[str, Any]) -> JournalEntry:
        encoded = json.dumps(dict(result), separators=(",", ":"), sort_keys=True)
        self._db.execute(
            """
            UPDATE command_journal
               SET state = 'SUCCEEDED', result_json = ?, updated_at = CURRENT_TIMESTAMP
             WHERE command_id = ? AND state = 'EXECUTING'
            """,
            (encoded, command_id),
        )
        self._db.commit()
        entry = self.get_by_command_id(command_id)
        if not entry:
            raise KeyError(command_id)
        return entry

    def fail(self, command_id: str, result: Mapping[str, Any]) -> JournalEntry:
        encoded = json.dumps(dict(result), separators=(",", ":"), sort_keys=True)
        self._db.execute(
            """
            UPDATE command_journal
               SET state = 'FAILED', result_json = ?, updated_at = CURRENT_TIMESTAMP
             WHERE command_id = ? AND state = 'EXECUTING'
            """,
            (encoded, command_id),
        )
        self._db.commit()
        entry = self.get_by_command_id(command_id)
        if not entry:
            raise KeyError(command_id)
        return entry

    def mark_uncertain(self, command_id: str, detail: str) -> JournalEntry:
        encoded = json.dumps({"detail": detail}, separators=(",", ":"), sort_keys=True)
        self._db.execute(
            """
            UPDATE command_journal
               SET state = 'UNCERTAIN', result_json = ?, updated_at = CURRENT_TIMESTAMP
             WHERE command_id = ? AND state = 'EXECUTING'
            """,
            (encoded, command_id),
        )
        self._db.commit()
        entry = self.get_by_command_id(command_id)
        if not entry:
            raise KeyError(command_id)
        return entry

    def get_by_command_id(self, command_id: str) -> JournalEntry | None:
        row = self._db.execute(
            "SELECT command_id, idempotency_key, state, result_json FROM command_journal WHERE command_id = ?",
            (command_id,),
        ).fetchone()
        return self._row(row)

    def get_by_idempotency_key(self, idempotency_key: str) -> JournalEntry | None:
        row = self._db.execute(
            "SELECT command_id, idempotency_key, state, result_json FROM command_journal WHERE idempotency_key = ?",
            (idempotency_key,),
        ).fetchone()
        return self._row(row)

    @staticmethod
    def _row(row: tuple[Any, ...] | None) -> JournalEntry | None:
        if not row:
            return None
        result = json.loads(row[3]) if row[3] else None
        return JournalEntry(str(row[0]), str(row[1]), str(row[2]), result)
