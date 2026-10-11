# Installs or updates the app on our own computer (selfhost/), from this one, over SSH.
#
#   powershell -ExecutionPolicy Bypass -File deploy\selfhost-deploy.ps1 -Server <ip or name> [-User root]
#        install or update the app (the data on the server is never touched)
#   ... -ImportData        also load the newest backup from %USERPROFILE%\SadBudushego-Backup
#                          (data and files) and give every account a new random password —
#                          only for a server with no data yet
#   ... -SetOwnerPassword  asks here for the owner's name and new password and sets them on the
#                          server — typed in this window, never shown, never stored here
#
# Access: the SSH key %USERPROFILE%\.ssh\sadb_server (its .pub half is what the server's
# authorized_keys gets). The service key the Vercel functions use is taken from Lockbox into
# memory and handed to the server on SSH's input — never on a command line, never printed.

param(
  [Parameter(Mandatory = $true)][string]$Server,
  [string]$User = 'root',
  [switch]$ImportData,
  [switch]$SetOwnerPassword,
  [string]$Key = (Join-Path $env:USERPROFILE '.ssh\sadb_server')
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$ssh = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:SystemRoot 'System32\OpenSSH\scp.exe'
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $Key)) { throw "No SSH key at $Key" }
$target = "$User@$Server"
$sshOpts = @('-i', $Key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30')
$sudo = if ($User -eq 'root') { '' } else { 'sudo ' }

function Remote([string]$command, [string]$stdin) {
  if ($stdin) { $stdin | & $ssh @sshOpts $target $command } else { & $ssh @sshOpts $target $command }
  if ($LASTEXITCODE -ne 0) { throw "On the server: '$command' failed ($LASTEXITCODE)" }
}

# ---- the package ----
Write-Output '== packing the app'
$pkg = Join-Path ([IO.Path]::GetTempPath()) ('sadb-' + [Guid]::NewGuid().ToString('N') + '.tgz')
Push-Location $root
try {
  & $tar -czf $pkg service-manager.html firebase-messaging-sw.js vendor novoe selfhost yandex/data-api/api.js yandex/data-api/core.js yandex/data-api/accounts.js yandex/data-api/auth.js yandex/data-api/images.js yandex/backup/backup.js
  if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
} finally { Pop-Location }
Write-Output ('   {0:N1} MB' -f ((Get-Item $pkg).Length / 1MB))

# ---- the service key the Vercel functions use, from Lockbox ----
$env:YC_CLI_INITIALIZATION_SILENCE = 'true'
$yc = Join-Path $env:USERPROFILE 'yandex-cloud\bin\yc.exe'
$eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
$iam = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
$ErrorActionPreference = $eap
$serviceKey = ''
if ($iam) {
  try {
    $payload = Invoke-RestMethod -Uri 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/e6qb5fo5urknt3m4ne3c/payload' -Headers @{ Authorization = "Bearer $iam" } -TimeoutSec 60
    $serviceKey = ($payload.entries | Where-Object { $_.key -eq 'SERVICE_KEY' }).textValue
  } catch { }
  $payload = $null
}
$iam = $null
if (-not $serviceKey) { Write-Output '   (Lockbox not reachable: the server keeps its own service key; the Vercel functions will not reach it until it is set)' }

# ---- install / update ----
Write-Output "== uploading to $target"
& $scp @sshOpts -q $pkg "${target}:/tmp/sadb-pkg.tgz"
if ($LASTEXITCODE -ne 0) { throw 'upload failed' }
Remove-Item $pkg
Write-Output '== installing'
$install = "${sudo}bash -c 'set -e; rm -rf /tmp/sadb-pkg; mkdir -p /tmp/sadb-pkg; tar -xzf /tmp/sadb-pkg.tgz -C /tmp/sadb-pkg; read -r SADB_SERVICE_KEY || true; export SADB_SERVICE_KEY; bash /tmp/sadb-pkg/selfhost/setup.sh; rm -rf /tmp/sadb-pkg /tmp/sadb-pkg.tgz'"
Remote $install $serviceKey
$serviceKey = $null

# ---- first data ----
if ($ImportData) {
  $bk = Join-Path $env:USERPROFILE 'SadBudushego-Backup'
  $snap = Get-ChildItem (Join-Path $bk 'data') -Filter '*.json.gz' | Sort-Object Name | Select-Object -Last 1
  if (-not $snap) { throw "No backup in $bk\data" }
  Write-Output "== uploading the backup of $($snap.BaseName) and $((Get-ChildItem (Join-Path $bk 'files') -File).Count) files (may take a while)"
  Remote "rm -rf /tmp/sadb-import; mkdir -p /tmp/sadb-import"
  & $scp @sshOpts -q $snap.FullName "${target}:/tmp/sadb-import/snapshot.json.gz"
  if ($LASTEXITCODE -ne 0) { throw 'upload of the backup failed' }
  & $scp @sshOpts -q -r (Join-Path $bk 'files') "${target}:/tmp/sadb-import/"
  if ($LASTEXITCODE -ne 0) { throw 'upload of the files failed' }
  Write-Output '== loading it'
  Remote "${sudo}chown -R sadb:sadb /tmp/sadb-import && ${sudo}sadb-admin import /tmp/sadb-import/snapshot.json.gz --files /tmp/sadb-import/files && ${sudo}sadb-admin init-credentials && ${sudo}rm -rf /tmp/sadb-import"
}

# ---- the owner's password ----
if ($SetOwnerPassword) {
  $name = Read-Host 'Имя пользователя владельца'
  $p1 = Read-Host 'Новый пароль владельца (не отображается)' -AsSecureString
  $p2 = Read-Host 'Ещё раз' -AsSecureString
  $plain = { param($s) [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
  $a = & $plain $p1; $b = & $plain $p2
  if ($a -ne $b) { throw 'Пароли не совпадают — ничего не изменено' }
  Remote "${sudo}sadb-admin set-password owner" ($name + "`n" + $a + "`n" + $b)
  $a = $null; $b = $null
}

Write-Output '== state'
Remote "systemctl is-active sad-budushego caddy; curl -s -m 5 http://127.0.0.1:8080/healthz; echo"
