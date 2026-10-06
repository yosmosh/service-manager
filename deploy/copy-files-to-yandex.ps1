# Step 2b of the move to Yandex Cloud: copies every file in the app's registry
# (Firestore appdata/files_registry) from Firebase Storage to the Yandex bucket
# sad-budushego-files, under the same id (files/<id>). Firebase is only read, never changed.
#
# Safe to stop and run again: a file already in the bucket at its full size is skipped.
# The registry's addresses are switched later, at the move itself, not here.
#
#   powershell -ExecutionPolicy Bypass -File deploy\copy-files-to-yandex.ps1 [-Limit N]

param([int]$Limit = 0)
$ErrorActionPreference = 'Stop'
$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$FS = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents'
$API = 'https://d5do4n0o23evidqovr16.jki8ffxa.apigw.yandexcloud.net/db/v1'
$PUBLIC = 'https://storage.yandexcloud.net/sad-budushego-files/files/'
$log = Join-Path $env:TEMP 'copy-files-to-yandex.log'

Add-Type -AssemblyName System.Net.Http
$http = New-Object System.Net.Http.HttpClient
$http.Timeout = [TimeSpan]::FromMinutes(10)

# The service key: from Lockbox, into memory only.
$ErrorActionPreference = 'Continue'
# yc may also print a sign-in notice; with ErrorActionPreference Stop that alone would abort
# the script, so the token is picked out of its output with the notice tolerated.
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$token = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
$ErrorActionPreference = $eap
if (-not $token) { throw 'No IAM token from yc (run: yc iam create-token)' }
$ErrorActionPreference = 'Stop'
$payload = Invoke-RestMethod -Uri 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/e6qb5fo5urknt3m4ne3c/payload' -Headers @{ Authorization = "Bearer $token" }
$SK = ($payload.entries | Where-Object { $_.key -eq 'SERVICE_KEY' }).textValue

$reg = Invoke-RestMethod -Uri "$FS/appdata/files_registry"
$files = @($reg.fields.files.mapValue.fields.PSObject.Properties | ForEach-Object {
  $f = $_.Value.mapValue.fields
  [pscustomobject]@{ id = $_.Name; name = $f.name.stringValue; type = $f.type.stringValue; url = $f.url.stringValue }
} | Where-Object { $_.url -like 'https://firebasestorage.googleapis.com/*' })
"{0:HH:mm:ss} files in the registry with a Firebase address: {1}" -f (Get-Date), $files.Count | Tee-Object -FilePath $log -Append

$done = 0; $skipped = 0; $failed = 0; $bytes = 0
foreach ($f in $files) {
  if ($Limit -and ($done + $failed) -ge $Limit) { break }
  try {
    # Already there? A HEAD on its public address answers with the size.
    $head = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, ($PUBLIC + $f.id))
    $hr = $http.SendAsync($head).Result
    if ($hr.IsSuccessStatusCode -and $hr.Content.Headers.ContentLength -gt 0) { $skipped++; continue }

    $src = $http.GetAsync($f.url).Result
    if (-not $src.IsSuccessStatusCode) { throw ("Firebase answered " + [int]$src.StatusCode) }
    $data = $src.Content.ReadAsByteArrayAsync().Result
    $type = if ($f.type) { $f.type } elseif ($src.Content.Headers.ContentType) { $src.Content.Headers.ContentType.MediaType } else { 'application/octet-stream' }

    # Where to put it — the data API signs a PUT for this exact id.
    $presignBody = @{ id = $f.id; name = $f.name; type = $type } | ConvertTo-Json -Compress
    $p = Invoke-RestMethod -Method Post -Uri "$API/admin:presignCopy" -Headers @{ 'X-Service-Key' = $SK } -ContentType 'application/json' -Body $presignBody
    $put = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Put, [string]$p.uploadUrl)
    $put.Content = [System.Net.Http.ByteArrayContent]::new([byte[]]$data)
    $put.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($type)
    $pr = $http.SendAsync($put).Result
    if (-not $pr.IsSuccessStatusCode) { throw ("Yandex answered " + [int]$pr.StatusCode + " " + $pr.Content.ReadAsStringAsync().Result) }
    # Counted only once it can be read back at its address, whole.
    $check = $http.SendAsync([System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Head, ($PUBLIC + $f.id))).Result
    if (-not $check.IsSuccessStatusCode -or $check.Content.Headers.ContentLength -ne $data.Length) {
      throw ("not readable after upload: HEAD " + [int]$check.StatusCode + ", " + $check.Content.Headers.ContentLength + " of " + $data.Length + " bytes")
    }
    $done++; $bytes += $data.Length
    if ($done % 25 -eq 0) { "{0:HH:mm:ss} copied {1}, skipped {2}, failed {3}, {4:N0} MB" -f (Get-Date), $done, $skipped, $failed, ($bytes / 1MB) | Tee-Object -FilePath $log -Append }
  } catch {
    $failed++
    "{0:HH:mm:ss} FAILED {1} ({2}): {3}" -f (Get-Date), $f.id, $f.name, $_.Exception.Message | Tee-Object -FilePath $log -Append
  }
}
"{0:HH:mm:ss} DONE: copied {1}, already there {2}, failed {3}, {4:N0} MB this run" -f (Get-Date), $done, $skipped, $failed, ($bytes / 1MB) | Tee-Object -FilePath $log -Append
