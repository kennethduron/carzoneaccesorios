[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$StablePath,
  [switch]$Activate
)

$ErrorActionPreference = 'Stop'
$taskName = 'CarZone-BackupV2-Daily'
$stable = [IO.Path]::GetFullPath($StablePath)
if ($stable -match '(?i)\\OneDrive\\' -or $stable -match '(?i)^C:\\tmp\\') {
  throw 'BACKUP_V2_TASK_STABLE_PATH_REQUIRED'
}
$wrapper = Join-Path $stable 'scripts\backup-v2-scheduled.ps1'
if (-not (Test-Path -LiteralPath $wrapper -PathType Leaf)) { throw 'BACKUP_V2_TASK_RUNNER_MISSING' }
$timezone = Get-TimeZone
if ($timezone.Id -cne 'Central America Standard Time' -or $timezone.SupportsDaylightSavingTime) {
  throw 'BACKUP_V2_TASK_TIMEZONE_MISMATCH'
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$wrapper`""
$forbidden = @('SUPABASE_DB_URL','SERVICE_ROLE','CLOUDINARY_API_SECRET','B2_APPLICATION_KEY','RECOVERY_KEY','PASSWORD')
foreach ($token in $forbidden) { if ($arguments -match [regex]::Escape($token)) { throw 'BACKUP_V2_TASK_ARGUMENT_SECRET_DETECTED' } }
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $stable
$trigger = if ($Activate) {
  New-ScheduledTaskTrigger -Daily -At '03:00'
} else {
  New-ScheduledTaskTrigger -Once -At ([DateTime]'2099-01-01T03:00:00')
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12)
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Car Zone Backup V2: encrypted five-component B2 generation; DPAPI current-user runtime.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName $taskName
if ($task.Actions[0].WorkingDirectory -cne $stable -or $task.Settings.MultipleInstances -cne 'IgnoreNew' -or
    -not $task.Settings.StartWhenAvailable -or $task.Principal.RunLevel -cne 'Limited') {
  throw 'BACKUP_V2_TASK_POST_REGISTRATION_VERIFY_FAILED'
}
[pscustomobject]@{
  Result = 'PASS'
  TaskName = $taskName
  StablePath = $stable
  Activated = [bool]$Activate
  StartWhenAvailable = [bool]$task.Settings.StartWhenAvailable
  MultipleInstances = [string]$task.Settings.MultipleInstances
  RunLevel = [string]$task.Principal.RunLevel
  UserSidMatches = ($task.Principal.UserId -in @($identity.Name, $identity.User.Value))
  SecretValuesInDefinition = 0
} | ConvertTo-Json -Compress
