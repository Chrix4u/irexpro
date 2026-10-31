from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CONNECTOR = ROOT / "services" / "mt5-connector"


def test_windows_packaging_contract_is_releaseable() -> None:
    spec = CONNECTOR / "packaging" / "irexpro-mt5-connector.spec"
    installer = CONNECTOR / "packaging" / "installer.iss"
    workflow = ROOT / ".github" / "workflows" / "mt5-connector-windows-release.yml"

    assert spec.exists()
    assert installer.exists()
    assert workflow.exists()

    spec_text = spec.read_text(encoding="utf-8")
    installer_text = installer.read_text(encoding="utf-8")
    workflow_text = workflow.read_text(encoding="utf-8")

    assert "irexpro_mt5_connector/gui.py" in spec_text.replace("\\", "/")
    assert "MetaTrader5" in spec_text
    assert "keyring" in spec_text
    assert "iRexPro-MT5-Connector-Setup" in installer_text
    assert "windows-latest" in workflow_text
    assert "mt5-connector-v*" in workflow_text
    assert "deploy/daily-loss-reset-20261028" in workflow_text
    assert "startsWith(github.ref, 'refs/tags/mt5-connector-v')" in workflow_text
    assert "pytest" in workflow_text
    assert "pyinstaller" in workflow_text.lower()
    assert "Get-FileHash" in workflow_text
    assert "softprops/action-gh-release" in workflow_text
    assert "iRexPro-MT5-Connector-Setup.exe" in workflow_text


def test_project_exposes_windows_desktop_entry_point() -> None:
    pyproject = (CONNECTOR / "pyproject.toml").read_text(encoding="utf-8")
    assert '[project.gui-scripts]' in pyproject
    assert 'irexpro-mt5-desktop = "irexpro_mt5_connector.gui:main"' in pyproject
