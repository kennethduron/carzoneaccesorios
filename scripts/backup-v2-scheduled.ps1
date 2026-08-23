[CmdletBinding()]
param([string]$RuntimeRoot)

$ErrorActionPreference = 'Stop'
$module = Join-Path $PSScriptRoot 'backup-v2-windows-runtime.psm1'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Import-Module $module -Force
$root = Get-CarZoneBackupV2RuntimeRoot -RuntimeRoot $RuntimeRoot
$launcherLog = Join-Path $root 'logs\launcher.jsonl'

function Write-LauncherRecord([string]$Result, [string]$Code) {
  $directory = Split-Path -Parent $launcherLog
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $record = [ordered]@{
    schema = 'car-zone-backup-v2-launcher-v1'
    timestamp = [DateTime]::UtcNow.ToString('o')
    result = $Result
    code = $Code
  }
  Add-Content -LiteralPath $launcherLog -Value ($record | ConvertTo-Json -Compress) -Encoding UTF8
}

try {
  Import-CarZoneBackupV2Environment -RuntimeRoot $root | Out-Null
  $actualSha = (& git -C $repoRoot rev-parse HEAD 2>$null).Trim()
  if ($LASTEXITCODE -ne 0 -or $actualSha -cne $env:BACKUP_V2_OPERATIONAL_CODE_SHA) {
    throw 'BACKUP_V2_OPERATIONAL_CODE_SHA_MISMATCH'
  }
  Set-Location -LiteralPath $repoRoot
  & npm.cmd run backup:v2:simplified:scheduled
  if ($LASTEXITCODE -ne 0) { throw 'BACKUP_V2_OPERATIONAL_RUN_FAILED' }
  Write-LauncherRecord -Result 'PASS' -Code 'BACKUP_V2_OPERATIONAL_COMPLETE'
  exit 0
} catch {
  $code = if ($_.Exception.Message -match '^[A-Z0-9_]{3,120}$') { $_.Exception.Message } else { 'BACKUP_V2_OPERATIONAL_LAUNCHER_FAILED' }
  Write-LauncherRecord -Result 'FAIL' -Code $code
  try { Write-CarZoneBackupV2Event -Code $code } catch { }
  [Console]::Error.WriteLine(($([ordered]@{ status = 'FAILED'; code = $code }) | ConvertTo-Json -Compress))
  exit 1
}
