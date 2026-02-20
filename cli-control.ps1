param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("start", "stop", "status", "restart")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSCommandPath
$configPath = Join-Path $env:APPDATA "fvtt-ai-runtime\config.json"
$runPattern = 'runtime[\\/]cli\.js\s+run'
$configPattern = 'fvtt-ai-runtime[\\/]+config\.json'

function Get-RuntimeProcesses {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.Name -eq "node.exe" -and
      $_.CommandLine -match $runPattern -and
      $_.CommandLine -match $configPattern
    }
}

function Show-Status {
  $procs = @(Get-RuntimeProcesses)
  if ($procs.Count -eq 0) {
    Write-Host "[info] runtime is NOT running."
    return
  }
  Write-Host "[ok] runtime is running:"
  $procs | Select-Object ProcessId, CommandLine | Format-Table -AutoSize
}

function Stop-Runtime {
  $procs = @(Get-RuntimeProcesses)
  if ($procs.Count -eq 0) {
    Write-Host "[info] no matching runtime process found."
    return
  }
  foreach ($p in $procs) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      Write-Host ("[ok] stopped pid=" + $p.ProcessId)
    } catch {
      Write-Host ("[warn] failed pid=" + $p.ProcessId + " " + $_.Exception.Message)
    }
  }
}

function Start-Runtime {
  $procs = @(Get-RuntimeProcesses)
  if ($procs.Count -gt 0) {
    Write-Host ("[info] runtime already running. pid=" + $procs[0].ProcessId)
    return
  }
  Write-Host ("[info] root: " + $repoRoot)
  Write-Host ("[info] config: " + $configPath)
  $p = Start-Process -FilePath "node" -ArgumentList @("runtime/cli.js", "run", "--config", $configPath) -WorkingDirectory $repoRoot -PassThru
  Write-Host ("[ok] started runtime pid=" + $p.Id)
}

switch ($Action) {
  "status" {
    Show-Status
  }
  "stop" {
    Write-Host "[info] stopping runtime/cli.js run processes..."
    Stop-Runtime
  }
  "start" {
    Start-Runtime
  }
  "restart" {
    Write-Host "[info] restarting runtime..."
    Stop-Runtime
    Start-Sleep -Seconds 1
    Start-Runtime
    Show-Status
  }
}

