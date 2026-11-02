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
    assert "IrexProConnectorClient._find_connector_identity_payload" in entry_text
    assert '"connector_id": "connector-self-test"' in entry_text
    assert '"broker_connection_id": "connection-self-test"' in entry_text
    assert '"connector_token": "token-self-test"' in entry_text
    assert "Smoke-test frozen Windows executable" in workflow_text
    assert 'Start-Process' in workflow_text
    assert "-ArgumentList '--self-test'" in workflow_text
    assert '-Wait -PassThru' in workflow_text
    assert '.ExitCode' in workflow_text
    assert "MetaTrader5" in spec_text
    assert "keyring" in spec_text
    pyproject_text = (CONNECTOR / "pyproject.toml").read_text(encoding="utf-8")
    assert 'version = "0.4.3"' in pyproject_text
    assert "pystray" in pyproject_text
    assert "Pillow" in pyproject_text
    assert "pystray" in spec_text
    assert '#define MyAppVersion "0.4.3"' in installer_text
    assert 'Name: "autostart"' in installer_text
    assert 'ValueName: "iRexPro MT5 Connector"' in installer_text
    assert 'ValueData: """{app}\\iRexPro-MT5-Connector.exe"" --background"' in installer_text
    assert "iRexPro-MT5-Connector-Setup" in installer_text
    assert "windows-2022" in workflow_text
    assert "windows-latest" not in workflow_text
    assert "mt5-connector-v*" in workflow_text
    assert "branches: [main]" in workflow_text
    assert "deploy/daily-loss-reset-20261028" not in workflow_text
    build_section, publish_section = workflow_text.split("  publish-tag-release:", 1)
    assert "contents: read" in build_section
    assert "contents: write" not in build_section
    assert "contents: write" in publish_section
    assert "if: startsWith(github.ref, 'refs/tags/mt5-connector-v')" in publish_section
    assert "needs: build-windows" in publish_section
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


def test_windows_packaging_includes_dedicated_host_worker_executable_without_secret_cli_flags() -> None:
    entry = CONNECTOR / "packaging" / "host_worker_entry.py"
    spec = CONNECTOR / "packaging" / "irexpro-mt5-host-worker.spec"
    workflow = ROOT / ".github" / "workflows" / "mt5-connector-windows-release.yml"
    host_worker = CONNECTOR / "irexpro_mt5_connector" / "host_worker.py"

    assert entry.exists()
    assert spec.exists()
    entry_text = entry.read_text(encoding="utf-8")
    spec_text = spec.read_text(encoding="utf-8")
    workflow_text = workflow.read_text(encoding="utf-8")
    host_worker_text = host_worker.read_text(encoding="utf-8")

    assert '"--self-test"' in entry_text
    assert "import MetaTrader5" in entry_text
    assert "import keyring" in entry_text
    assert "irexpro_mt5_connector.host_worker" in entry_text
    assert 'name="iRexPro-MT5-Host-Worker"' in spec_text
    assert "MetaTrader5" in spec_text
    assert '"numpy"' in spec_text
    assert "keyring" in spec_text
    assert "console=True" in spec_text
    assert "irexpro-mt5-host-worker.spec" in workflow_text
    assert "iRexPro-MT5-Host-Worker.exe" in workflow_text
    assert "Smoke-test frozen Windows host worker" in workflow_text
    assert "--worker-token" not in host_worker_text


def test_host_worker_bootstrap_keeps_worker_token_out_of_args_and_plaintext_files() -> None:
    bootstrap = CONNECTOR / "packaging" / "install-host-worker.ps1"
    workflow = ROOT / ".github" / "workflows" / "mt5-connector-windows-release.yml"

    assert bootstrap.exists()
    text = bootstrap.read_text(encoding="utf-8")
    workflow_text = workflow.read_text(encoding="utf-8")

    assert "Read-Host" in text
    assert "-AsSecureString" in text
    assert "--store-worker-token" in text
    assert "--readiness-check" in text
    assert "Register-ScheduledTask" in text
    assert "New-ScheduledTaskTrigger" in text
    assert "-AtLogOn" in text
    assert "Start-ScheduledTask" in text
    assert "icacls" in text
    assert "HOSTED_MT5_WORKER_TOKEN=" not in text
    assert "--worker-token" not in text
    assert "Set-Content" not in text
    assert "Out-File" not in text
    assert "install-host-worker.ps1" in workflow_text
    assert "Validate hosted worker bootstrap syntax" in workflow_text


def test_project_exposes_windows_desktop_entry_point() -> None:
    pyproject = (CONNECTOR / "pyproject.toml").read_text(encoding="utf-8")
    assert '[project.gui-scripts]' in pyproject
    assert 'irexpro-mt5-desktop = "irexpro_mt5_connector.gui:main"' in pyproject
    assert 'irexpro-mt5-host-worker = "irexpro_mt5_connector.host_worker:main"' in pyproject


def test_onboarding_download_matches_current_connector_version() -> None:
    onboarding = ROOT / "apps" / "web" / "src" / "app" / "onboarding" / "broker" / "page.tsx"
    text = onboarding.read_text(encoding="utf-8")

    assert "mt5-connector-v0.4.3/iRexPro-MT5-Connector-Setup.exe" in text
    assert "Install iRexPro MT5 Connector v0.4.3" in text
    assert "mt5-connector-v0.3.0" not in text


def test_desktop_window_displays_current_connector_version() -> None:
    init_text = (CONNECTOR / "irexpro_mt5_connector" / "__init__.py").read_text(encoding="utf-8")
    gui_text = (CONNECTOR / "irexpro_mt5_connector" / "gui.py").read_text(encoding="utf-8")
    host_worker_text = (CONNECTOR / "irexpro_mt5_connector" / "host_worker.py").read_text(encoding="utf-8")

    assert '__version__ = "0.4.3"' in init_text
    assert "from . import __version__" in gui_text
    assert 'self.root.title(f"iRexPro MT5 Connector v{__version__}")' in gui_text
    assert 'text=f"iRexPro Direct MT5 Connector · v{__version__}"' in gui_text
    assert 'HOST_WORKER_VERSION = "0.4.3"' in host_worker_text
