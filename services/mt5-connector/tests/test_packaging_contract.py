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

    windows_entry = CONNECTOR / "packaging" / "windows_entry.py"
    assert windows_entry.exists()
    entry_text = windows_entry.read_text(encoding="utf-8")

    assert 'project_root / "packaging" / "windows_entry.py"' in spec_text
    assert 'project_root / "irexpro_mt5_connector" / "gui.py"' not in spec_text
    assert "[str(entry_script)]" in spec_text
    assert '"--self-test"' in entry_text
    assert "import MetaTrader5" in entry_text
    assert "import pystray" in entry_text
    assert "from PIL import Image" in entry_text
    assert "Smoke-test frozen Windows executable" in workflow_text
    assert 'Start-Process' in workflow_text
    assert "-ArgumentList '--self-test'" in workflow_text
    assert '-Wait -PassThru' in workflow_text
    assert '.ExitCode' in workflow_text
    assert "MetaTrader5" in spec_text
    assert "keyring" in spec_text
    pyproject_text = (CONNECTOR / "pyproject.toml").read_text(encoding="utf-8")
    assert 'version = "0.3.0"' in pyproject_text
    assert "pystray" in pyproject_text
    assert "Pillow" in pyproject_text
    assert "pystray" in spec_text
    assert '#define MyAppVersion "0.3.0"' in installer_text
    assert 'Name: "autostart"' in installer_text
    assert 'ValueName: "iRexPro MT5 Connector"' in installer_text
    assert 'ValueData: """{app}\\iRexPro-MT5-Connector.exe"" --background"' in installer_text
    assert "iRexPro-MT5-Connector-Setup" in installer_text
    assert "windows-2022" in workflow_text
    assert "windows-latest" not in workflow_text
    assert "mt5-connector-v*" in workflow_text
    assert "branches: [main]" in workflow_text
    assert "deploy/daily-loss-reset-20261028" not in workflow_text
    assert "contents: read" in workflow_text
    assert "contents: write" not in workflow_text
    assert "persist-credentials: false" in workflow_text
    assert "ref: ${{ env.CANDIDATE_SHA }}" in workflow_text
    assert "pytest" in workflow_text
    assert "pyinstaller" in workflow_text.lower()
    assert "Get-FileHash" in workflow_text
    assert "softprops/action-gh-release" not in workflow_text
    assert "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09" in workflow_text
    assert "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1" in workflow_text
    assert "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f" in workflow_text
    assert "irexpro-mt5-connector-windows-${{ github.run_id }}" in workflow_text
    assert "iRexPro-MT5-Connector-Setup.exe" in workflow_text


def test_project_exposes_windows_desktop_entry_point() -> None:
    pyproject = (CONNECTOR / "pyproject.toml").read_text(encoding="utf-8")
    assert '[project.gui-scripts]' in pyproject
    assert 'irexpro-mt5-desktop = "irexpro_mt5_connector.gui:main"' in pyproject
    assert 'irexpro-mt5-host-worker = "irexpro_mt5_connector.host_worker:main"' in pyproject
