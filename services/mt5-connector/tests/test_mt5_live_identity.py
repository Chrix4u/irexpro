from types import SimpleNamespace

import pytest

from irexpro_mt5_connector.mt5_terminal import MetaQuotesMt5Terminal, Mt5TerminalError


class FakeMt5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_CONTEST = 1
    ACCOUNT_TRADE_MODE_REAL = 2

    def __init__(self, trade_mode: int, *, account_trade_allowed: bool = True, trade_expert: bool = True, terminal_trade_allowed: bool = True):
        self._account = SimpleNamespace(
            login=12345, server="Broker-Server", currency="USD", trade_mode=trade_mode,
            trade_allowed=account_trade_allowed, trade_expert=trade_expert,
        )
        self._terminal = SimpleNamespace(trade_allowed=terminal_trade_allowed)

    def account_info(self): return self._account
    def terminal_info(self): return self._terminal
    def shutdown(self): pass


def identity_for(mode: int, **kwargs):
    terminal = MetaQuotesMt5Terminal()
    terminal._mt5 = FakeMt5(mode, **kwargs)
    return terminal.identity()


def test_terminal_derives_demo_and_live_from_mt5_trade_mode() -> None:
    assert identity_for(0).account_type == "DEMO"
    assert identity_for(2).account_type == "LIVE"


def test_terminal_refuses_contest_account_for_automated_trading() -> None:
    with pytest.raises(Mt5TerminalError, match="CONTEST"):
        identity_for(1)


def test_trade_allowed_requires_terminal_account_and_expert_permissions() -> None:
    assert identity_for(2).trade_allowed is True
    assert identity_for(2, account_trade_allowed=False).trade_allowed is False
    assert identity_for(2, trade_expert=False).trade_allowed is False
    assert identity_for(2, terminal_trade_allowed=False).trade_allowed is False
