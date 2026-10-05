# Publishes the site's files to Yandex Cloud Object Storage (bucket sad-budushego-site), from
# which the API gateway serves sad-budushego.ru in Russia. Run from the project folder after a
# change to service-manager.html, the service worker or vendor/:
#
#   powershell -ExecutionPolicy Bypass -File deploy\yandex-site.ps1
#
# The page and the service worker are never cached (an update reaches everyone at once);
# vendor/ is cached for a year — each library version has a folder of its own, so a new
# version is a new address, never a changed file.
#
#   -Rehearsal  publishes only a copy of the page with DATA_BACKEND = 'yandex' and REHEARSAL on
#               (no emails, no Telegram check, a label on screen), at /test - the
#               move's rehearsal, on the data copied into Yandex. The real page is untouched.

param([switch]$Rehearsal)

$ErrorActionPreference = 'Stop'
$yc = "$env:USERPROFILE\yandex-cloud\bin\yc.exe"
$bucket = 'sad-budushego-site'
$root = Split-Path -Parent $PSScriptRoot

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'application/javascript; charset=utf-8';
            '.css' = 'text/css; charset=utf-8'; '.woff2' = 'font/woff2' }
$noCache = 'no-store, no-cache, must-revalidate'
$forever = 'public, max-age=31536000, immutable'

$files = @(
  @{ path = 'service-manager.html'; cache = $noCache },
  @{ path = 'firebase-messaging-sw.js'; cache = $noCache }
)
Get-ChildItem -Path (Join-Path $root 'vendor') -Recurse -File | ForEach-Object {
  $files += @{ path = $_.FullName.Substring($root.Length + 1).Replace('\', '/'); cache = $forever }
}

if ($Rehearsal) {
  $page = [IO.File]::ReadAllText((Join-Path $root 'service-manager.html'), [Text.Encoding]::UTF8)
  $swaps = @{ "const DATA_BACKEND = 'firebase';" = "const DATA_BACKEND = 'yandex';"; 'const REHEARSAL = false;' = 'const REHEARSAL = true;' }
  foreach ($from in $swaps.Keys) {
    if (([regex]::Matches($page, [regex]::Escape($from))).Count -ne 1) { throw "The page does not have exactly one line: $from" }
    $page = $page.Replace($from, $swaps[$from])
  }
  $copy = Join-Path ([IO.Path]::GetTempPath()) 'rehearsal-test.html'
  [IO.File]::WriteAllText($copy, $page, (New-Object Text.UTF8Encoding($false)))
  $ErrorActionPreference = 'Continue'
  & $yc storage s3api put-object --bucket $bucket --key 'test' --body $copy --content-type $types['.html'] --cache-control $noCache 2>&1 | Out-Null
  $ok = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = 'Stop'
  [IO.File]::Delete($copy)
  if (-not $ok) { throw 'Upload of the rehearsal page failed' }
  Write-Output 'uploaded  test  (service-manager.html with DATA_BACKEND = yandex, REHEARSAL = true)'
  return
}

foreach ($f in $files) {
  $full = Join-Path $root $f.path
  $type = $types[[IO.Path]::GetExtension($full).ToLower()]
  if (-not $type) { throw "No content type for $($f.path)" }
  # A dropped connection to Yandex's API is retried a few times before giving up.
  $ok = $false
  for ($try = 1; $try -le 4 -and -not $ok; $try++) {
    $ErrorActionPreference = 'Continue'
    & $yc storage s3api put-object --bucket $bucket --key $f.path --body $full --content-type $type --cache-control $f.cache 2>&1 | Out-Null
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = 'Stop'
    if (-not $ok) { Start-Sleep -Seconds (3 * $try) }
  }
  if (-not $ok) { throw "Upload failed: $($f.path)" }
  Write-Output ("uploaded  {0,-60} {1}" -f $f.path, $f.cache)
}
Write-Output "Done: $($files.Count) files."
