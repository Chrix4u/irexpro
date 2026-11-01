[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiUrl,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$')]
    [string]$WorkerId,

    [Parameter(Mandatory = $true)]
    [string]$HostWorkerExe,

    [Parameter(Mandatory = $true)]
    [string]$Mt5TemplateSource,

    [string]$InstallRoot = (Join-Path $env:ProgramData 'iRexPro\MT5HostWorker'),

    [ValidateRange(1, 256)]
    [int]$MaxSessions = 4,

    [string]$TerminalRelativePath = 'terminal64.exe',

    [string]$TaskName = 'iRexPro MT5 Host Worker'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this bootstrap from an elevated PowerShell session on the dedicated iRexPro Windows worker account.'
    }
}

function Quote-NativeArgument([string]$Value) {
    if ($Value.Contains('"')) {
        throw 'Hosted MT5 worker arguments cannot contain double quotes.'
    }
    return '"' + $Value + '"'
}

Assert-Administrator

$uri = $null
if (-not [Uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https') {
    throw 'ApiUrl must be an absolute HTTPS URL.'
}

$sourceWorker = (Resolve-Path -LiteralPath $HostWorkerExe).Path
$sourceTemplate = (Resolve-Path -LiteralPath $Mt5TemplateSource).Path
$sourceTerminal = Join-Path $sourceTemplate $TerminalRelativePath
if (-not (Test-Path -LiteralPath $sourceTerminal -PathType Leaf)) {
    throw "The MT5 template does not contain $TerminalRelativePath."
}

$binDir = Join-Path $InstallRoot 'bin'
$templateDir = Join-Path $InstallRoot 'template'
$sessionRoot = Join-Path $InstallRoot 'sessions'
$installedWorker = Join-Path $binDir 'iRexPro-MT5-Host-Worker.exe'

New-Item -ItemType Directory -Path $binDir -Force | Out-Null
New-Item -ItemType Directory -Path $templateDir -Force | Out-Null
New-Item -ItemType Directory -Path $sessionRoot -Force | Out-Null

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $InstallRoot /inheritance:r /grant:r "${currentUser}:(OI)(CI)F" '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Could not apply the hosted-worker directory ACL.'
}

if ($sourceWorker -ne $installedWorker) {
    Copy-Item -LiteralPath $sourceWorker -Destination $installedWorker -Force
}

$installedTerminal = Join-Path $templateDir $TerminalRelativePath
if (-not (Test-Path -LiteralPath $installedTerminal -PathType Leaf)) {
    Copy-Item -Path (Join-Path $sourceTemplate '*') -Destination $templateDir -Recurse -Force
}
if (-not (Test-Path -LiteralPath $installedTerminal -PathType Leaf)) {
    throw 'The copied MT5 template is incomplete.'
}

& $installedWorker --readiness-check `
    --server-url $ApiUrl `
    --mt5-template-dir $templateDir `
    --session-root $sessionRoot `
    --terminal-relative-path $TerminalRelativePath
if ($LASTEXITCODE -ne 0) {
    throw 'Hosted MT5 worker readiness check failed.'
}

$secureToken = Read-Host 'Hosted MT5 worker token' -AsSecureString
$bstr = [IntPtr]::Zero
$plainToken = $null
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    $plainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainToken) -or $plainToken.Length -lt 32) {
        throw 'Hosted MT5 worker token must be at least 32 characters.'
    }
    $plainToken | & $installedWorker --store-worker-token --worker-id $WorkerId
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not store the hosted MT5 worker credential.'
    }
}
finally {
    $plainToken = $null
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

$arguments = @(
    '--server-url', (Quote-NativeArgument $ApiUrl),
    '--worker-id', (Quote-NativeArgument $WorkerId),
    '--mt5-template-dir', (Quote-NativeArgument $templateDir),
    '--session-root', (Quote-NativeArgument $sessionRoot),
    '--terminal-relative-path', (Quote-NativeArgument $TerminalRelativePath),
    '--max-sessions', $MaxSessions
) -join ' '

$action = New-ScheduledTaskAction -Execute $installedWorker -Argument $arguments -WorkingDirectory $binDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'iRexPro-owned MetaTrader 5 execution worker for phone/web customers.' `
    -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName
Write-Host 'iRexPro Hosted MT5 worker installed and started. Keep this dedicated Windows execution account signed in during the DEMO pilot.'
