[CmdletBinding()]
param(
  [string]$RuntimeRoot,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$OperationalCodeSha
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'backup-v2-windows-runtime.psm1') -Force
$result = Protect-CarZoneBackupV2Environment -RuntimeRoot $RuntimeRoot -OperationalCodeSha $OperationalCodeSha
$result | ConvertTo-Json -Compress
