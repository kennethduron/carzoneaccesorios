Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:SecretNames = @(
  'SUPABASE_DB_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLOUDINARY_API_SECRET',
  'BACKUP_V2_B2_KEY_ID',
  'BACKUP_V2_B2_APPLICATION_KEY',
  'BACKUP_V2_RECOVERY_KEY_BASE64',
  'BACKUP_V2_RESTORE_PG_PASSWORD'
)

$script:NonSecretNames = @(
  'NEXT_PUBLIC_SUPABASE_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'BACKUP_V2_B2_ENDPOINT',
  'BACKUP_V2_B2_REGION',
  'BACKUP_V2_B2_BUCKET',
  'BACKUP_V2_B2_KEY_SCOPE',
  'BACKUP_V2_B2_DESTINATION_ID',
  'BACKUP_V2_B2_FAILURE_DOMAIN_ID',
  'BACKUP_V2_B2_SOFT_BUDGET_BYTES',
  'BACKUP_V2_REAL_EXECUTION_ENABLED',
  'BACKUP_V2_RECOVERY_KEY_DURABLE_COPY_CONFIRMED',
  'BACKUP_V2_PRIMARY_REPRESENTATION',
  'BACKUP_V2_PRIMARY_RESTORE_STRATEGY'
)

function Get-CarZoneBackupV2RuntimeRoot {
  param([string]$RuntimeRoot)
  $candidate = if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CarZone\BackupV2'
  } else { $RuntimeRoot }
  if (-not [IO.Path]::IsPathRooted($candidate) -or $candidate.IndexOf([char]0) -ge 0) {
    throw 'BACKUP_V2_DPAPI_RUNTIME_ROOT_INVALID'
  }
  return [IO.Path]::GetFullPath($candidate)
}

function Get-CarZoneCurrentSid {
  return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Set-CarZoneCurrentUserOnlyAcl {
  param([Parameter(Mandatory)][string]$LiteralPath, [Parameter(Mandatory)][bool]$Directory)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $permission = if ($Directory) { '(OI)(CI)F' } else { 'F' }
  & icacls.exe $LiteralPath '/inheritance:r' '/grant:r' "${identity}:$permission" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'BACKUP_V2_DPAPI_ACL_FAILED' }
}

function Assert-CarZoneRequiredValues {
  $exact = [ordered]@{
    BACKUP_V2_REAL_EXECUTION_ENABLED = 'true'
    BACKUP_V2_RECOVERY_KEY_DURABLE_COPY_CONFIRMED = 'CONFIRMED_INDEPENDENT_DURABLE_COPY'
    BACKUP_V2_PRIMARY_REPRESENTATION = 'postgres_plain_sql_v1'
    BACKUP_V2_PRIMARY_RESTORE_STRATEGY = 'psql_file_restore_v1'
    BACKUP_V2_B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'
    BACKUP_V2_B2_REGION = 'us-east-005'
    BACKUP_V2_B2_BUCKET = 'carzone-backup-v2-kencode'
    BACKUP_V2_B2_KEY_SCOPE = 'bucket-restricted'
    BACKUP_V2_B2_DESTINATION_ID = 'carzone-b2-primary-us-east-005'
    BACKUP_V2_B2_FAILURE_DOMAIN_ID = 'backblaze-b2-current-account-us-east-005'
    BACKUP_V2_B2_SOFT_BUDGET_BYTES = '8000000000'
  }
  foreach ($entry in $exact.GetEnumerator()) {
    if ([Environment]::GetEnvironmentVariable($entry.Key, 'Process') -cne $entry.Value) {
      throw "BACKUP_V2_DPAPI_REQUIRED_VALUE_INVALID:$($entry.Key)"
    }
  }
  foreach ($name in @($script:SecretNames + $script:NonSecretNames)) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) {
      throw "BACKUP_V2_DPAPI_REQUIRED_VALUE_MISSING:$name"
    }
  }
}

function Protect-CarZoneBackupV2Environment {
  [CmdletBinding()]
  param(
    [string]$RuntimeRoot,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$OperationalCodeSha
  )
  Assert-CarZoneRequiredValues
  $root = Get-CarZoneBackupV2RuntimeRoot -RuntimeRoot $RuntimeRoot
  $configDirectory = Join-Path $root 'config'
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $root -Directory $true
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $configDirectory -Directory $true

  $protected = [ordered]@{}
  foreach ($name in $script:SecretNames) {
    $protected[$name] = ConvertTo-SecureString ([Environment]::GetEnvironmentVariable($name, 'Process')) -AsPlainText -Force
  }
  $store = [pscustomobject]@{
    Schema = 'car-zone-backup-v2-dpapi-current-user-v1'
    OwnerSid = Get-CarZoneCurrentSid
    CreatedAt = [DateTime]::UtcNow.ToString('o')
    Secrets = $protected
  }
  $secretPath = Join-Path $configDirectory 'secrets.clixml'
  $secretTemp = "$secretPath.$PID.tmp"
  $store | Export-Clixml -LiteralPath $secretTemp -Depth 5
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $secretTemp -Directory $false
  Move-Item -LiteralPath $secretTemp -Destination $secretPath -Force
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $secretPath -Directory $false

  $nonSecret = [ordered]@{}
  foreach ($name in $script:NonSecretNames) {
    $nonSecret[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $nonSecret['BACKUP_V2_SCHEDULED_EXECUTION_CONFIRMATION'] = 'SCHEDULED_BACKUP_V2_GENERATION'
  $nonSecret['BACKUP_V2_RETENTION_MODE'] = 'DRY_RUN'
  $nonSecret['BACKUP_V2_OPERATIONAL_ROOT'] = $root
  $nonSecret['BACKUP_V2_SIMPLIFIED_STATE_ROOT'] = Join-Path $root 'state'
  $nonSecret['BACKUP_V2_OPERATIONAL_CODE_SHA'] = $OperationalCodeSha
  $configPath = Join-Path $configDirectory 'non-secret.json'
  $configTemp = "$configPath.$PID.tmp"
  [IO.File]::WriteAllText($configTemp, ($nonSecret | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $configTemp -Directory $false
  Move-Item -LiteralPath $configTemp -Destination $configPath -Force
  Set-CarZoneCurrentUserOnlyAcl -LiteralPath $configPath -Directory $false

  return [pscustomobject]@{
    Result = 'PASS'
    SecretStoreType = 'WINDOWS_DPAPI_CURRENT_USER'
    SecretStorePath = $secretPath
    SecretCount = $script:SecretNames.Count
    PlaintextFilesCreated = 0
    ValuesLogged = $false
  }
}

function Import-CarZoneBackupV2Environment {
  [CmdletBinding()]
  param([string]$RuntimeRoot)
  $root = Get-CarZoneBackupV2RuntimeRoot -RuntimeRoot $RuntimeRoot
  $secretPath = Join-Path $root 'config\secrets.clixml'
  $configPath = Join-Path $root 'config\non-secret.json'
  if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    throw 'BACKUP_V2_DPAPI_STORE_MISSING'
  }
  $store = Import-Clixml -LiteralPath $secretPath
  if ($store.Schema -cne 'car-zone-backup-v2-dpapi-current-user-v1' -or
      $store.OwnerSid -cne (Get-CarZoneCurrentSid)) {
    throw 'BACKUP_V2_DPAPI_WRONG_USER'
  }
  $secretKeys = @($store.Secrets.Keys | Sort-Object)
  $expectedKeys = @($script:SecretNames | Sort-Object)
  if (($secretKeys -join "`n") -cne ($expectedKeys -join "`n")) {
    throw 'BACKUP_V2_DPAPI_SECRET_SET_INVALID'
  }
  foreach ($name in $script:SecretNames) {
    $secure = $store.Secrets[$name]
    if ($secure -isnot [Security.SecureString]) { throw 'BACKUP_V2_DPAPI_CIPHERTEXT_INVALID' }
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
      $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
      if ([string]::IsNullOrWhiteSpace($value)) { throw 'BACKUP_V2_DPAPI_SECRET_EMPTY' }
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
  $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
  foreach ($property in $config.PSObject.Properties) {
    $name = $property.Name
    if ($name -notin @($script:NonSecretNames + @(
      'BACKUP_V2_SCHEDULED_EXECUTION_CONFIRMATION', 'BACKUP_V2_RETENTION_MODE',
      'BACKUP_V2_OPERATIONAL_ROOT', 'BACKUP_V2_SIMPLIFIED_STATE_ROOT', 'BACKUP_V2_OPERATIONAL_CODE_SHA'
    ))) { throw 'BACKUP_V2_DPAPI_NON_SECRET_SET_INVALID' }
    [Environment]::SetEnvironmentVariable($name, [string]$property.Value, 'Process')
  }
  Assert-CarZoneRequiredValues
  return [pscustomobject]@{ Result = 'PASS'; SecretCount = $script:SecretNames.Count; ValuesLogged = $false }
}

function Write-CarZoneBackupV2Event {
  [CmdletBinding()]
  param([Parameter(Mandatory)][ValidatePattern('^[A-Z0-9_]{3,120}$')][string]$Code, [switch]$Critical)
  $eventId = if ($Critical) { 423 } else { 421 }
  $entryType = if ($Critical) { 'Error' } else { 'Warning' }
  Write-EventLog -LogName 'Windows PowerShell' -Source 'PowerShell' -EventId $eventId -EntryType $entryType -Message "Car Zone Backup V2 operational failure: $Code"
}

Export-ModuleMember -Function @(
  'Get-CarZoneBackupV2RuntimeRoot',
  'Protect-CarZoneBackupV2Environment',
  'Import-CarZoneBackupV2Environment',
  'Write-CarZoneBackupV2Event'
)
