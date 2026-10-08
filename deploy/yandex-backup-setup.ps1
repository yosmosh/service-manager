# One-time setup of the weekly backup (see yandex/backup). Safe to run again: it only creates
# what is missing.
#
#   powershell -ExecutionPolicy Bypass -File deploy\yandex-backup-setup.ps1
#
# Creates:
#   - service account «backup» with, on the folder:
#       ydb.editor               read the database, write appdata/backup_status
#       storage.uploader         read the files, add objects to the backup bucket (no deleting)
#       functions.functionInvoker  so the timer may start the function
#   - Cloud Function «backup» (its code goes up with deploy\yandex-backup.ps1)
#   - timer trigger «backup-weekly»: Sundays 00:00 UTC (03:00 Moscow)
# The bucket sad-budushego-backup (private, versioning on, data snapshots kept a year, old
# versions 90 days) was created on 2026-10-09.
# (The yc CLI's serverless commands fail on this machine — see deploy\yandex-data-api.ps1 — so
# the function and the trigger are made over REST.)

$ErrorActionPreference = 'Stop'
$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$folderId = 'b1gomtpk23dslrh2dhk6'

function Yc { $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; $o = (& $yc @args 2>$null | Out-String); $ErrorActionPreference = $eap; return $o }

# The service account and its roles.
$sa = (Yc iam service-account get --name backup --format json) | ConvertFrom-Json -ErrorAction SilentlyContinue
if (-not $sa) {
  $null = Yc iam service-account create --name backup --description "Weekly backup: reads the app's data and files, adds to sad-budushego-backup; cannot delete"
  $sa = (Yc iam service-account get --name backup --format json) | ConvertFrom-Json
}
if (-not $sa.id) { throw 'Service account «backup» was not created' }
Write-Output ("service account backup: " + $sa.id)
foreach ($role in 'ydb.editor', 'storage.uploader', 'functions.functionInvoker') {
  $null = Yc resource-manager folder add-access-binding $folderId --role $role --subject ("serviceAccount:" + $sa.id)
  Write-Output ("  role " + $role)
}

$token = ((Yc iam create-token) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
if (-not $token) { throw 'No IAM token from yc' }
$h = @{ Authorization = "Bearer $token" }
function WaitOp($op) {
  for ($i = 0; $i -lt 60; $i++) {
    $o = Invoke-RestMethod -Uri ("https://operation.api.cloud.yandex.net/operations/" + $op.id) -Headers $h
    if ($o.done) { if ($o.error) { throw ($o.error | ConvertTo-Json -Depth 6) }; return $o }
    Start-Sleep -Seconds 3
  }
  throw 'Operation still running'
}

# The function.
$fns = Invoke-RestMethod -Uri "https://serverless-functions.api.cloud.yandex.net/functions/v1/functions?folderId=$folderId" -Headers $h
$fn = @($fns.functions) | Where-Object { $_.name -eq 'backup' } | Select-Object -First 1
if (-not $fn) {
  $body = @{ folderId = $folderId; name = 'backup'; description = 'Weekly backup of the app data and files into sad-budushego-backup' } | ConvertTo-Json
  $o = WaitOp (Invoke-RestMethod -Method Post -Uri 'https://serverless-functions.api.cloud.yandex.net/functions/v1/functions' -Headers $h -ContentType 'application/json' -Body $body)
  $fn = $o.response
}
Write-Output ("function backup: " + $fn.id)

# The weekly timer.
$trs = Invoke-RestMethod -Uri "https://serverless-triggers.api.cloud.yandex.net/triggers/v1/triggers?folderId=$folderId" -Headers $h
$tr = @($trs.triggers) | Where-Object { $_.name -eq 'backup-weekly' } | Select-Object -First 1
if (-not $tr) {
  $body = @{
    folderId = $folderId; name = 'backup-weekly'; description = 'Sundays 03:00 Moscow'
    rule = @{ timer = @{
      cronExpression = '0 0 ? * SUN *'
      invokeFunctionWithRetry = @{ functionId = $fn.id; functionTag = '$latest'; serviceAccountId = $sa.id
        retrySettings = @{ retryAttempts = '2'; interval = '60s' } }   # Yandex allows 10s-1m
    } }
  } | ConvertTo-Json -Depth 8
  $o = WaitOp (Invoke-RestMethod -Method Post -Uri 'https://serverless-triggers.api.cloud.yandex.net/triggers/v1/triggers' -Headers $h -ContentType 'application/json' -Body $body)
  $tr = $o.response
}
Write-Output ("trigger backup-weekly: " + $tr.id)
Write-Output 'Setup done. Next: deploy\yandex-backup.ps1'
