from types import SimpleNamespace

import pytest

from irexpro_mt5_connector.mt5_terminal import MetaQuotesMt5Terminal, Mt5TerminalError, Mt5TerminalFatalError


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


class InitializingFakeMt5(FakeMt5):
    def __init__(self):
        super().__init__(self.ACCOUNT_TRADE_MODE_DEMO)
        self.initialize_calls = []

    def initialize(self, *args, **kwargs):
        self.initialize_calls.append((args, kwargs))
        return True

    def last_error(self):
        return (0, "ok")


def test_direct_terminal_initialization_remains_passwordless_and_backward_compatible() -> None:
    fake = InitializingFakeMt5()
    terminal = MetaQuotesMt5Terminal(r"C:\\MT5\\terminal64.exe")
    terminal._mt5 = fake

    identity = terminal.initialize()

    assert identity.login == "12345"
    assert fake.initialize_calls == [((r"C:\\MT5\\terminal64.exe",), {})]


def test_hosted_terminal_initializes_portable_mt5_with_explicit_login_credentials() -> None:
    fake = InitializingFakeMt5()
    terminal = MetaQuotesMt5Terminal(
        r"C:\\iRexPro\\sessions\\connector-1\\terminal64.exe",
        login="113392789",
        password="demo-trading-password",
        server="Broker-Demo",
        portable=True,
    )
    terminal._mt5 = fake

    terminal.initialize()

    assert fake.initialize_calls == [(
        (r"C:\\iRexPro\\sessions\\connector-1\\terminal64.exe",),
        {
            "login": 113392789,
            "password": "demo-trading-password",
            "server": "Broker-Demo",
            "portable": True,
        },
    )]


def test_hosted_terminal_rejects_partial_explicit_login_configuration_before_mt5_call() -> None:
    fake = InitializingFakeMt5()
    terminal = MetaQuotesMt5Terminal(
        r"C:\\iRexPro\\sessions\\connector-1\\terminal64.exe",
        login="113392789",
        password="demo-trading-password",
    )
    terminal._mt5 = fake

    with pytest.raises(Mt5TerminalFatalError, match="server"):
        terminal.initialize()
    assert fake.initialize_calls == []


def test_hosted_terminal_never_echoes_provider_error_text_after_explicit_login_failure() -> None:
    secret = "super-secret-mt5-password"

    class FailingExplicitLoginMt5(InitializingFakeMt5):
        def initialize(self, *args, **kwargs):
            self.initialize_calls.append((args, kwargs))
            return False

        def last_error(self):
            return (401, f"login rejected password={secret}")

    fake = FailingExplicitLoginMt5()
    terminal = MetaQuotesMt5Terminal(
        r"C:\\iRexPro\\sessions\\connector-1\\terminal64.exe",
        login="113392789",
        password=secret,
        server="Broker-Demo",
        portable=True,
    )
    terminal._mt5 = fake

    with pytest.raises(Mt5TerminalError) as caught:
        terminal.initialize()

    message = str(caught.value)
    assert "MT5 hosted login failed" in message
    assert secret not in message
    assert "password=" not in message
