# Publishes yandex/backup as a new version of the Cloud Function «backup» (made by
# deploy\yandex-backup-setup.ps1). With -RunNow it then runs one backup and prints how it went;
# the first one copies the files a part at a time, so run it until "filesLeft" is 0.
#
#   powershell -ExecutionPolicy Bypass -File deploy\yandex-backup.ps1 [-RunNow] [-SkipDeploy]

param([switch]$RunNow, [switch]$SkipDeploy)

$ErrorActionPreference = 'Stop'
$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'yandex\backup'
$folderId = 'b1gomtpk23dslrh2dhk6'

$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$token = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
$sa = ((& $yc iam service-account get --name backup --format json 2>$null | Out-String) | ConvertFrom-Json -ErrorAction SilentlyContinue)
$ErrorActionPreference = $eap
if (-not $token) { throw 'No IAM token from yc (run: yc iam create-token)' }
if (-not $sa) { throw 'No service account «backup» - run deploy\yandex-backup-setup.ps1 first' }
$h = @{ Authorization = "Bearer $token" }
$fns = Invoke-RestMethod -Uri "https://serverless-functions.api.cloud.yandex.net/functions/v1/functions?folderId=$folderId" -Headers $h
$fn = @($fns.functions) | Where-Object { $_.name -eq 'backup' } | Select-Object -First 1
if (-not $fn) { throw 'No function «backup» - run deploy\yandex-backup-setup.ps1 first' }

if (-not $SkipDeploy) {
  $zip = Join-Path ([IO.Path]::GetTempPath()) ("backup-" + [Guid]::NewGuid().ToString('N') + ".zip")
  Compress-Archive -Path ('index.js', 'backup.js', 'package.json' | ForEach-Object { Join-Path $src $_ }) -DestinationPath $zip
  $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
  [IO.File]::Delete($zip)
  $body = @{
    functionId = $fn.id
    runtime = 'nodejs22'
    entrypoint = 'index.handler'
    resources = @{ memory = '536870912' }
    executionTimeout = '600s'
    serviceAccountId = $sa.id
    content = $content
    environment = @{
      YDB_CONNECTION_STRING = 'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1gdo73rvt6pupbc15hp/etnu02142tck5q7mdbp0'
      YDB_METADATA_CREDENTIALS = '1'
      FILES_BUCKET = 'sad-budushego-files'
      BACKUP_BUCKET = 'sad-budushego-backup'
    }
  } | ConvertTo-Json -Depth 6
  $op = Invoke-RestMethod -Method Post -Uri 'https://serverless-functions.api.cloud.yandex.net/functions/v1/versions' -Headers $h -ContentType 'application/json' -Body $body
  Write-Output ("building version (operation " + $op.id + ")...")
  $built = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 5
    $o = Invoke-RestMethod -Uri ("https://operation.api.cloud.yandex.net/operations/" + $op.id) -Headers $h
    if ($o.done) {
      if ($o.error) { throw ("Build failed: " + ($o.error | ConvertTo-Json -Depth 6)) }
      Write-Output ("Done: version " + $o.response.id + " is live.")
      $built = $true; break
    }
  }
  if (-not $built) { throw 'Build still running after 5 minutes - check the function in the console.' }
}

if ($RunNow) {
  Write-Output 'running a backup (up to 10 minutes)...'
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ("https://functions.yandexcloud.net/" + $fn.id) -Headers $h -TimeoutSec 660
    Write-Output $r.Content
  } catch {
    # A run that went wrong answers 500 with the same report.
    $resp = $_.Exception.Response
    if ($resp) { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); Write-Output ("FAILED: " + $sr.ReadToEnd()) } else { throw }
  }
}
