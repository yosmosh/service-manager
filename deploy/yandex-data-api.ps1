# Publishes yandex/data-api as a new version of the Cloud Function «data-api»: the app's data
# (YDB) and files (Object Storage), served with Firestore's REST shapes at /db/... on the
# API gateway. Yandex installs the npm dependencies from package.json while building.
#
#   powershell -ExecutionPolicy Bypass -File deploy\yandex-data-api.ps1
#
# Its secrets (token signing key, service key, bucket access key) are in Lockbox secret
# «data-api» and reach the function as environment variables - never through this script.
# (The yc CLI's serverless commands fail on this machine - a Yandex endpoint signed by a CA
# Windows doesn't trust - so the Functions REST API is used directly.)

$ErrorActionPreference = 'Stop'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'yandex\data-api'
$functionId = 'd4e7okpot0k25pk5b8em'
$serviceAccountId = 'ajediqo8e0399kg5966s'   # data-api: ydb.editor, storage.editor, Lockbox reader
$secretId = 'e6qb5fo5urknt3m4ne3c'

# yc may also print a sign-in notice; with ErrorActionPreference Stop that alone would abort
# the script, so the token is picked out of its output with the notice tolerated.
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$token = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
$ErrorActionPreference = $eap
if (-not $token) { throw 'No IAM token from yc (run: yc iam create-token)' }
$h = @{ Authorization = "Bearer $token" }
$secret = Invoke-RestMethod -Uri "https://lockbox.api.cloud.yandex.net/lockbox/v1/secrets/$secretId" -Headers $h
$secretVersion = $secret.currentVersion.id

$zip = Join-Path ([IO.Path]::GetTempPath()) ("data-api-" + [Guid]::NewGuid().ToString('N') + ".zip")
$files = 'index.js','api.js','core.js','store-ydb.js','files.js','auth.js','accounts.js','package.json' | ForEach-Object { Join-Path $src $_ }
Compress-Archive -Path $files -DestinationPath $zip
$content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
[IO.File]::Delete($zip)

$secrets = 'AUTH_SECRET','SERVICE_KEY','S3_KEY_ID','S3_SECRET' | ForEach-Object { @{ id = $secretId; versionId = $secretVersion; key = $_; environmentVariable = $_ } }
$body = @{
  functionId = $functionId
  runtime = 'nodejs22'
  entrypoint = 'index.handler'
  resources = @{ memory = '268435456' }
  executionTimeout = '30s'
  serviceAccountId = $serviceAccountId
  content = $content
  environment = @{
    YDB_CONNECTION_STRING = 'grpcs://ydb.serverless.yandexcloud.net:2135/ru-central1/b1gdo73rvt6pupbc15hp/etnu02142tck5q7mdbp0'   # database in the path: ydb-sdk takes a bare '/' path over ?database=
    YDB_METADATA_CREDENTIALS = '1'
    FILES_BUCKET = 'sad-budushego-files'
  }
  secrets = @($secrets)
} | ConvertTo-Json -Depth 6

$op = Invoke-RestMethod -Method Post -Uri 'https://serverless-functions.api.cloud.yandex.net/functions/v1/versions' -Headers $h -ContentType 'application/json' -Body $body
Write-Output ("building version (operation " + $op.id + ")...")
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 5
  $o = Invoke-RestMethod -Uri ("https://operation.api.cloud.yandex.net/operations/" + $op.id) -Headers $h
  if ($o.done) {
    if ($o.error) { throw ("Build failed: " + ($o.error | ConvertTo-Json -Depth 6)) }
    Write-Output ("Done: version " + $o.response.id + " is live.")
    return
  }
}
throw "Build still running after 5 minutes - check the function in the console."
