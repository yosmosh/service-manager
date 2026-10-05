# Copies the app's data from Firestore into Yandex (YDB) - see migrate-data-to-yandex.js.
#
#   powershell -ExecutionPolicy Bypass -File deploy\migrate-data-to-yandex.ps1 [-Force] [-Node <path to node.exe>]
#
# -Force: the switch itself - the passwords in use on Firebase replace any set in Yandex since.
# Run copy-files-to-yandex.ps1 first, so every file the data points at is already there.
# The service key goes from Lockbox to the copy's environment, in memory only.

param([switch]$Force, [string]$Node = 'node')

$ErrorActionPreference = 'Stop'
$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$token = (& $yc iam create-token 2>$null | Out-String).Trim()
$payload = Invoke-RestMethod -Uri 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/e6qb5fo5urknt3m4ne3c/payload' -Headers @{ Authorization = "Bearer $token" }
$env:SERVICE_KEY = ($payload.entries | Where-Object { $_.key -eq 'SERVICE_KEY' }).textValue
$payload = $null
if (-not $env:SERVICE_KEY) { throw 'SERVICE_KEY not found in Lockbox' }

$script = Join-Path $PSScriptRoot 'migrate-data-to-yandex.js'
$args2 = @($script)
if ($Force) { $args2 += '--force' }
try {
  & $Node @args2
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:SERVICE_KEY -ErrorAction SilentlyContinue
}
exit $code
