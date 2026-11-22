[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$WorkerExe,
  [Parameter(Mandatory = $true)][string]$Mt5TemplateDir,
  [Parameter(Mandatory = $true)][string]$SessionRoot,
  [string]$TaskName = 'iRexPro MT5 Host Worker'
)

# Read-only operator diagnostic: no customer credentials, worker tokens,
# environment values, orders, terminal launches, or trade instructions.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$report = [ordered]@{
  status = 'HOLD'
  checkedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  windows = ([Environment]::OSVersion.Platform -eq 'Win32NT')
  workerExecutablePresent = $false
  mt5TemplatePresent = $false
  apiReachable = $false
  sessionRootWritable = $false
  scheduledTaskConfigured = $false
  scheduledTaskEnabled = $false
  scheduledTaskRunning = $false
  workerProcessRunning = $false
  requiresSignedInWorkerSession = $true
  brokerIdentityVerified = $false
  demoOrderCertified = $false
  reasonCode = 'UNKNOWN'
}

try {
  if (-not $report.windows) {
    $report.reasonCode = 'WINDOWS_REQUIRED'
  }
  elseif ($ApiUrl -notmatch '^https://') {
    $report.reasonCode = 'HTTPS_REQUIRED'
  }
  else {
    $report.workerExecutablePresent = Test-Path -LiteralPath $WorkerExe -PathType Leaf
    $terminal = Join-Path $Mt5TemplateDir 'terminal64.exe'
    $report.mt5TemplatePresent = Test-Path -LiteralPath $terminal -PathType Leaf

    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) {
      $report.scheduledTaskConfigured = $true
      $report.scheduledTaskEnabled = ($task.State -ne 'Disabled')
      $report.scheduledTaskRunning = ($task.State -eq 'Running')
    }

    $worker = @(Get-Process -Name 'iRexPro-MT5-Host-Worker' -ErrorAction SilentlyContinue)
    $report.workerProcessRunning = ($worker.Count -gt 0)

    if (-not $report.workerExecutablePresent) {
      $report.reasonCode = 'WORKER_EXECUTABLE_MISSING'
    }
    elseif (-not $report.mt5TemplatePresent) {
      $report.reasonCode = 'MT5_TEMPLATE_MISSING'
    }
    else {
      # Reuse packaged no-secret readiness test; no broker lease is requested.
      $probeOutput = & $WorkerExe --readiness-check --server-url $ApiUrl --mt5-template-dir $Mt5TemplateDir --session-root $SessionRoot

      if ($LASTEXITCODE -ne 0) {
        $report.reasonCode = 'HOST_READINESS_FAILED'
      }
      else {
        $probe = $probeOutput | Select-Object -Last 1 | ConvertFrom-Json
        $report.apiReachable = ($probe.apiReachable -eq $true)
        $report.sessionRootWritable = ($probe.sessionRootWritable -eq $true)
        if (-not $report.apiReachable -or -not $report.sessionRootWritable) {
          $report.reasonCode = 'HOST_READINESS_FAILED'
        }
        elseif (-not $report.scheduledTaskConfigured -or -not $report.scheduledTaskEnabled) {
          $report.reasonCode = 'HOST_TASK_NOT_CONFIGURED'
        }
        elseif (-not $report.workerProcessRunning) {
          $report.reasonCode = 'HOST_WORKER_NOT_RUNNING'
        }
        else {
          # Host prerequisites alone cannot certify broker identity or orders.
          $report.status = 'HOST_PREREQUISITES_READY'
          $report.reasonCode = 'HOST_ONLY_READY'
        }
      }
    }
  }
}
catch {
  # Never echo exceptions; network errors can contain confidential config.
  $report.status = 'HOLD'
  $report.reasonCode = 'HOST_READINESS_UNEXPECTED_ERROR'
}

$report | ConvertTo-Json -Depth 3
if ($report.status -ne 'HOST_PREREQUISITES_READY') {
  exit 12
}
exit 0
