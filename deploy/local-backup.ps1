# A copy of the app's backup on this computer, away from Yandex: every data snapshot and every
# file in the backup bucket (sad-budushego-backup) that isn't here yet is downloaded to
# %USERPROFILE%\SadBudushego-Backup. Nothing here is ever deleted — once a file has arrived it
# stays, whatever happens in the cloud. Run daily by the scheduled task «SadBudushego Backup»
# (see -Install), and by hand any time:
#
#   powershell -ExecutionPolicy Bypass -File deploy\local-backup.ps1            # copy now
#   powershell -ExecutionPolicy Bypass -File deploy\local-backup.ps1 -Install   # set up the daily task
#
# Access is the yc sign-in already on this computer (an IAM token, kept in memory only). What
# happened each run is in backup-log.txt in the backup folder.

param([switch]$Install, [string]$Dest = (Join-Path $env:USERPROFILE 'SadBudushego-Backup'))

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ($Install) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '"')
  $trigger = New-ScheduledTaskTrigger -Daily -At '10:00'
  # Missed because the computer was off: runs as soon as it is on again.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
  Register-ScheduledTask -TaskName 'SadBudushego Backup' -Action $action -Trigger $trigger -Settings $settings -Force `
    -Description 'Сад Будущего: копия резервной копии (данные и файлы) из Yandex на этот компьютер, каждый день. Скрипт: deploy\local-backup.ps1' | Out-Null
  Write-Output 'Installed: task «SadBudushego Backup», daily at 10:00 (or as soon as the computer is on).'
  return
}

$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = Join-Path $env:USERPROFILE 'yandex-cloud\bin\yc.exe'
$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
$bucket = 'sad-budushego-backup'
$base = 'https://storage.yandexcloud.net/' + $bucket

New-Item -ItemType Directory -Force -Path (Join-Path $Dest 'data'), (Join-Path $Dest 'files') | Out-Null
$logFile = Join-Path $Dest 'backup-log.txt'
function Log($m) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $m
  Add-Content -Path $logFile -Value $line -Encoding UTF8
  Write-Output $line
}

# yc may also print a sign-in notice; the token is picked out of its output.
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$token = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
$ErrorActionPreference = $eap
if (-not $token) { Log 'ОШИБКА: нет доступа к Yandex Cloud (yc iam create-token) — копия не обновлена'; exit 1 }
$auth = 'X-YaCloud-SubjectToken: ' + $token

# Every key under a prefix, a thousand at a time.
function Get-Keys($prefix) {
  $keys = New-Object System.Collections.Generic.List[string]
  $next = ''
  do {
    $url = $base + '?list-type=2&max-keys=1000&prefix=' + [uri]::EscapeDataString($prefix)
    if ($next) { $url += '&continuation-token=' + [uri]::EscapeDataString($next) }
    $text = & $curl -s -f --max-time 120 -H $auth $url
    if ($LASTEXITCODE -ne 0) { throw "Список $prefix не получен (curl $LASTEXITCODE)" }
    $xml = [xml](($text | Out-String))
    foreach ($c in @($xml.ListBucketResult.Contents)) { if ($c -and $c.Key) { $keys.Add([string]$c.Key) } }
    $next = if ([string]$xml.ListBucketResult.IsTruncated -eq 'true') { [string]$xml.ListBucketResult.NextContinuationToken } else { '' }
  } while ($next)
  return $keys
}

# One object to a file: downloaded beside it first, renamed only when complete.
function Save-Object($key, $target) {
  $part = $target + '.part'
  for ($try = 1; $try -le 3; $try++) {
    & $curl -s -f --max-time 900 -H $auth -o $part ($base + '/' + (($key -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'))
    if ($LASTEXITCODE -eq 0) { Move-Item -Force $part $target; return $true }
    Start-Sleep -Seconds (3 * $try)
  }
  Remove-Item -Force $part -ErrorAction SilentlyContinue
  return $false
}

$failed = 0
try {
  $stats = @{}
  foreach ($kind in 'data', 'files') {
    $keys = Get-Keys ($kind + '/')
    $new = 0
    foreach ($k in $keys) {
      $name = $k.Substring($kind.Length + 1)
      if (-not $name -or $name.Contains('/')) { continue }
      $target = Join-Path (Join-Path $Dest $kind) $name
      if (Test-Path -LiteralPath $target) { continue }
      if (Save-Object $k $target) { $new++ } else { $failed++; Log ('не скачан: ' + $k) }
    }
    $stats[$kind] = @{ total = $keys.Count; new = $new }
  }
  $here = { param($k) @(Get-ChildItem -LiteralPath (Join-Path $Dest $k) -File | Where-Object { $_.Name -notlike '*.part' }).Count }
  $msg = 'данные: новых {0}, всего на компьютере {1}; файлы: новых {2}, всего на компьютере {3}' -f `
    $stats.data.new, (& $here 'data'), $stats.files.new, (& $here 'files')
  if ($failed) { Log ('ЧАСТИЧНО — ' + $msg + '; не скачано: ' + $failed + ' (будут скачаны в следующий раз)'); exit 2 }
  Log ('OK — ' + $msg)
  Set-Content -Path (Join-Path $Dest 'last-success.txt') -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding UTF8
} catch {
  Log ('ОШИБКА: ' + $_.Exception.Message + ' — копия не обновлена, попробую в следующий раз')
  exit 1
}
