$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'backup-v2-windows-runtime.psm1') -Force

$root = Join-Path ([IO.Path]::GetTempPath()) ("carzone-backup-v2-dpapi-test-" + [guid]::NewGuid().ToString('N'))
$secretValues = [ordered]@{
  SUPABASE_DB_URL = 'postgresql://test-user:test-password@example.invalid:5432/testdb'
  SUPABASE_SERVICE_ROLE_KEY = 'synthetic-service-role-key'
  CLOUDINARY_API_SECRET = 'synthetic-cloudinary-secret'
  BACKUP_V2_B2_KEY_ID = 'synthetic-b2-key-id'
  BACKUP_V2_B2_APPLICATION_KEY = 'synthetic-b2-application-key'
  BACKUP_V2_RECOVERY_KEY_BASE64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
  BACKUP_V2_RESTORE_PG_PASSWORD = 'synthetic-restore-password'
}
$nonSecretValues = [ordered]@{
  NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
  CLOUDINARY_CLOUD_NAME = 'synthetic-cloud'
  CLOUDINARY_API_KEY = 'synthetic-api-key'
  BACKUP_V2_B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com'
  BACKUP_V2_B2_REGION = 'us-east-005'
  BACKUP_V2_B2_BUCKET = 'carzone-backup-v2-kencode'
  BACKUP_V2_B2_KEY_SCOPE = 'bucket-restricted'
  BACKUP_V2_B2_DESTINATION_ID = 'carzone-b2-primary-us-east-005'
  BACKUP_V2_B2_FAILURE_DOMAIN_ID = 'backblaze-b2-current-account-us-east-005'
  BACKUP_V2_B2_SOFT_BUDGET_BYTES = '8000000000'
  BACKUP_V2_REAL_EXECUTION_ENABLED = 'true'
  BACKUP_V2_RECOVERY_KEY_DURABLE_COPY_CONFIRMED = 'CONFIRMED_INDEPENDENT_DURABLE_COPY'
  BACKUP_V2_PRIMARY_REPRESENTATION = 'postgres_plain_sql_v1'
  BACKUP_V2_PRIMARY_RESTORE_STRATEGY = 'psql_file_restore_v1'
}

try {
  foreach ($entry in @($secretValues.GetEnumerator()) + @($nonSecretValues.GetEnumerator())) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
  $provisioned = Protect-CarZoneBackupV2Environment -RuntimeRoot $root -OperationalCodeSha ('a' * 40)
  if ($provisioned.PlaintextFilesCreated -ne 0 -or $provisioned.ValuesLogged) { throw 'DPAPI_PROVISION_RESULT_INVALID' }
  $secretPath = Join-Path $root 'config\secrets.clixml'
  $ciphertext = Get-Content -Raw -LiteralPath $secretPath
  foreach ($value in $secretValues.Values) {
    if ($ciphertext.Contains($value)) { throw 'DPAPI_PLAINTEXT_LEAK_DETECTED' }
  }
  foreach ($name in $secretValues.Keys) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
  $loaded = Import-CarZoneBackupV2Environment -RuntimeRoot $root
  if ($loaded.SecretCount -ne $secretValues.Count -or $loaded.ValuesLogged) { throw 'DPAPI_LOAD_RESULT_INVALID' }

  $missingRoot = Join-Path $root 'missing'
  try { Import-CarZoneBackupV2Environment -RuntimeRoot $missingRoot | Out-Null; throw 'MISSING_STORE_ACCEPTED' }
  catch { if ($_.Exception.Message -cne 'BACKUP_V2_DPAPI_STORE_MISSING') { throw } }

  $wrongRoot = Join-Path $root 'wrong-user'
  New-Item -ItemType Directory -Path (Join-Path $wrongRoot 'config') -Force | Out-Null
  $wrong = Import-Clixml -LiteralPath $secretPath
  $wrong.OwnerSid = 'S-1-5-18'
  $wrong | Export-Clixml -LiteralPath (Join-Path $wrongRoot 'config\secrets.clixml') -Depth 5
  Copy-Item -LiteralPath (Join-Path $root 'config\non-secret.json') -Destination (Join-Path $wrongRoot 'config\non-secret.json')
  try { Import-CarZoneBackupV2Environment -RuntimeRoot $wrongRoot | Out-Null; throw 'WRONG_USER_ACCEPTED' }
  catch { if ($_.Exception.Message -cne 'BACKUP_V2_DPAPI_WRONG_USER') { throw } }

  $corruptRoot = Join-Path $root 'corrupt'
  New-Item -ItemType Directory -Path (Join-Path $corruptRoot 'config') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $corruptRoot 'config\secrets.clixml') -Value '<corrupt />' -Encoding UTF8
  Copy-Item -LiteralPath (Join-Path $root 'config\non-secret.json') -Destination (Join-Path $corruptRoot 'config\non-secret.json')
  try { Import-CarZoneBackupV2Environment -RuntimeRoot $corruptRoot | Out-Null; throw 'CORRUPT_STORE_ACCEPTED' }
  catch { if ($_.Exception.Message -eq 'CORRUPT_STORE_ACCEPTED') { throw } }

  $acl = Get-Acl -LiteralPath $secretPath
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $unexpectedAllow = @($acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $currentSid })
  if (-not $acl.AreAccessRulesProtected -or $unexpectedAllow.Count -ne 0) { throw 'DPAPI_ACL_INVALID' }

  [pscustomobject]@{
    secureConfigLoad = 'PASS'
    secretStoreCorruption = 'PASS'
    wrongWindowsUser = 'PASS'
    missingSecureStore = 'PASS'
    dpapiCurrentUser = 'PASS'
    currentUserOnlyAcl = 'PASS'
    plaintextFilesCreated = 0
    secretValuesLogged = $false
  } | ConvertTo-Json -Compress
} finally {
  if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
