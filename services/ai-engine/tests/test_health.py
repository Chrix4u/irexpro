"""Tests for GET /api/v1/health."""
from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_returns_ok(client: AsyncClient):
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["service_name"] == "irexpro-ai-engine"
    assert "timestamp" in data
    assert "version" in data
    assert "environment" in data
    assert "scheduler_enabled" in data
    assert "scheduler_running" in data


@pytest.mark.asyncio
async def test_health_signal_mode_is_paper(client: AsyncClient):
    """Default signal mode must be paper — never live by default."""
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["signal_mode"] in ("paper", "sandbox")
    assert data["signal_mode"] != "live"


@pytest.mark.asyncio
async def test_health_reports_scheduler_truth(client: AsyncClient):
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["scheduler_enabled"] is False
    assert data["scheduler_running"] is False
