# Installs or updates «Сад Будущего» on this Windows computer, so that the computer serves the
# site itself — the Windows twin of selfhost/setup.sh (Ubuntu). Needs administrator rights and
# asks Windows for them by itself (the «Разрешить этому приложению…» window):
#
#   powershell -ExecutionPolicy Bypass -File deploy\selfhost-windows.ps1
#        install or update the app (the data is never touched)
#   ... -ImportData        also load the newest backup from %USERPROFILE%\SadBudushego-Backup
#                          (data and files) and give every account a new random password —
#                          only when there is no data here yet
#   ... -SetOwnerPassword  asks for the owner's name and new password and sets them — typed in
#                          the window, never shown, never stored
#   ... -ResetPasswords    also give every employee and provider (not the owner) a new, easy
#                          password; the list opens in Notepad from a file only you can read,
#                          and the file is deleted when you press Enter
#   ... -Restart           only start it all again (right after the site's address has been
#                          pointed here, so that the HTTPS certificates are fetched at once)
#   ... -Stop              stop it and keep it stopped, also after a restart of the computer
#                          (before the address goes back to Yandex)
#
# What it sets up, in C:\SadBudushego:
#   app\         the app (replaced as a whole on every update)
#   node\        Node.js        caddy\  Caddy — HTTPS, with its own certificates, renewed by itself
#   data\        db\ (documents), files\ (photos, documents), backups\ (a snapshot every night)
#   env          settings and secrets — only administrators and the service can read it
#   logs\        what the server and Caddy write, and this script's last run (install.log)
# The scheduled task «SadBudushego Server» starts it at boot, before anyone signs in, as the
# low-rights account LOCAL SERVICE (selfhost/windows-service.js keeps the server and Caddy
# running); a firewall rule lets the internet reach Caddy on ports 80 and 443; and the power
# settings keep the computer awake (mains or battery, lid closed or not), its network adapter on,
# and Windows Update restarts between 00:00 and 06:00 only.

param(
  [switch]$ImportData,
  [switch]$SetOwnerPassword,
  [switch]$ResetPasswords,
  [switch]$Restart,
  [switch]$Stop,
  [string]$Root = 'C:\SadBudushego',
  [switch]$Elevated
)

$ErrorActionPreference = 'Stop'
$NodeVersion = '22.23.3'
$NodeSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
$CaddyVersion = '2.11.4'
$CaddySha512 = 'cd5ccfd86a4b40732cf715890d0dca5bf3f63adefec5a7914de85adf240c60ce7e5d2791631b88ef9758e46b23bb1730e020b9c5d696889740b284ffd4788e35'
$TaskName = 'SadBudushego Server'
$repo = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $Root 'logs'
$installLog = Join-Path $logs 'install.log'

# ---- administrator rights: run again, elevated, in a window of its own; then show what it did ----
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-Root', "`"$Root`"")
  foreach ($s in 'ImportData', 'SetOwnerPassword', 'ResetPasswords', 'Restart', 'Stop') { if ((Get-Variable $s).Value) { $a += "-$s" } }
  Write-Output 'Windows will ask for permission; the work goes on in a new window.'
  $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
  if (Test-Path $installLog) { Get-Content $installLog -Encoding UTF8 | Where-Object { $_ -notmatch '^\*{10}|^(Start|End) time|^(Username|RunAs User|Configuration Name|Machine|Host Application|Process ID|PSVersion|PSEdition|PSCompatibleVersions|BuildVersion|CLRVersion|WSManStackVersion|PSRemotingProtocolVersion|SerializationVersion|Windows PowerShell transcript)' } }
  exit $p.ExitCode
}

New-Item -ItemType Directory -Force $logs | Out-Null
Start-Transcript -Path $installLog -Force | Out-Null
$failed = $false
try {
  $nodeExe = Join-Path $Root 'node\node.exe'
  $caddyExe = Join-Path $Root 'caddy\caddy.exe'
  $app = Join-Path $Root 'app'
  $envFile = Join-Path $Root 'env'
  $sid = @{ System = '*S-1-5-18'; Admins = '*S-1-5-32-544'; LocalService = '*S-1-5-19'; Me = '*' + $me.User.Value }

  function Grant([string]$path, [string[]]$grants, [switch]$Only) {
    $a = @($path)
    if ($Only) { $a += '/inheritance:r' }
    $a += '/grant:r'
    $a += $grants
    & icacls.exe @a | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls $path failed" }
  }

  function Read-Env {
    $h = [ordered]@{}
    if (Test-Path $envFile) { foreach ($l in [IO.File]::ReadAllLines($envFile)) { if ($l -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() } } }
    return $h
  }

  function Stop-App {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
    # And whatever it had started (the server, Caddy, a snapshot) — by where they run from.
    $deadline = (Get-Date).AddSeconds(20)
    do {
      $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) })
      $left | Stop-Process -Force -ErrorAction SilentlyContinue
      if ($left.Count) { Start-Sleep -Milliseconds 500 }
    } while ($left.Count -and (Get-Date) -lt $deadline)
  }

  function Start-App {
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $ok = $false
    for ($i = 0; $i -lt 40 -and -not $ok; $i++) {
      Start-Sleep -Seconds 1
      try { $ok = (Invoke-WebRequest -Uri 'http://127.0.0.1:8080/healthz' -UseBasicParsing -TimeoutSec 3).Content -eq 'ok' } catch { }
    }
    $caddyUp = @(Get-Process caddy -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $caddyExe }).Count -gt 0
    Write-Output ('== server: ' + $(if ($ok) { 'running' } else { "NOT answering — see $logs\server.log and service.log" }))
    Write-Output ('== HTTPS (Caddy): ' + $(if ($caddyUp) { 'running' } else { "not running — see $logs\caddy.log" }))
    if (-not $ok) { $script:failed = $true }
  }

  # selfhost/admin.js with the settings from env. Output in this window and in install.log.
  function Invoke-Admin([string[]]$adminArgs) {
    $e = Read-Env
    foreach ($k in 'APP_DIR', 'DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH_SECRET') { Set-Item "env:$k" $e[$k] }
    try {
      $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      & $nodeExe (Join-Path $app 'selfhost\admin.js') @adminArgs 2>&1 | ForEach-Object { "$_" }
      $code = $LASTEXITCODE
      $ErrorActionPreference = $eap
      if ($code -ne 0) { throw "admin.js $($adminArgs[0]) failed" }
    } finally { foreach ($k in 'APP_DIR', 'DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH_SECRET') { Remove-Item "env:$k" -ErrorAction SilentlyContinue } }
  }

  function Get-Verified([string]$url, [string]$algo, [string]$hash) {
    $f = Join-Path ([IO.Path]::GetTempPath()) ('sadb-' + [Guid]::NewGuid().ToString('N') + '.zip')
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $pp = $ProgressPreference; $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $f -UseBasicParsing -TimeoutSec 900
    $ProgressPreference = $pp
    if ((Get-FileHash $f -Algorithm $algo).Hash -ne $hash) { Remove-Item $f; throw "$url does not match its checksum — not installed" }
    return $f
  }

  # A zip's single top folder, or its files, into $dest (replaced).
  function Expand-To([string]$zip, [string]$dest) {
    $tmp = "$dest.new"
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $tmp | Out-Null
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $zip -C $tmp
    if ($LASTEXITCODE -ne 0) { throw "unpacking $zip failed" }
    Remove-Item $zip
    $inner = @(Get-ChildItem $tmp)
    $from = if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { $inner[0].FullName } else { $tmp }
    Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $from $dest
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---- only stop / only restart / only the owner's password ----
  if ($Stop) {
    Write-Output '== stopping'
    Stop-App
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
    Write-Output '== stopped; it will not start again until this script runs without -Stop'
  } elseif ($Restart) {
    Write-Output '== restarting'
    Stop-App
    Start-App
  } else {
    if ($SetOwnerPassword -and -not $ImportData -and -not $ResetPasswords) {
      Stop-App
    } else {
      # ---- install / update ----
      Write-Output "== installing into $Root"
      Stop-App
      foreach ($d in 'data\db', 'data\files', 'data\backups', 'caddy-data') { New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null }
      # Only administrators and the service; the service may change data, logs and certificates only.
      Grant $Root @("$($sid.System):(OI)(CI)F", "$($sid.Admins):(OI)(CI)F", "$($sid.LocalService):(OI)(CI)RX") -Only
      foreach ($d in 'data', 'logs', 'caddy-data') { Grant (Join-Path $Root $d) @("$($sid.LocalService):(OI)(CI)M") }
      Grant $logs @("$($sid.Me):(OI)(CI)RX")

      $have = if (Test-Path $nodeExe) { (& $nodeExe -v) } else { '' }
      if ($have -ne "v$NodeVersion") {
        Write-Output "== Node.js $NodeVersion"
        Expand-To (Get-Verified "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip" SHA256 $NodeSha256) (Join-Path $Root 'node')
      }
      $have = if (Test-Path $caddyExe) { (& $caddyExe version) } else { '' }
      if ($have -notlike "v$CaddyVersion *") {
        Write-Output "== Caddy $CaddyVersion"
        Expand-To (Get-Verified "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" SHA512 $CaddySha512) (Join-Path $Root 'caddy')
      }

      # The app: the new version beside the old, then swapped.
      Write-Output '== the app'
      $new = "$app.new"
      Remove-Item $new -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force (Join-Path $new 'yandex\data-api'), (Join-Path $new 'yandex\backup') | Out-Null
      foreach ($f in 'service-manager.html', 'firebase-messaging-sw.js') { Copy-Item (Join-Path $repo $f) $new }
      foreach ($d in 'vendor', 'novoe', 'selfhost') { Copy-Item (Join-Path $repo $d) $new -Recurse }
      foreach ($f in 'api', 'core', 'accounts', 'auth', 'images') { Copy-Item (Join-Path $repo "yandex\data-api\$f.js") (Join-Path $new 'yandex\data-api') }
      Copy-Item (Join-Path $repo 'yandex\backup\backup.js') (Join-Path $new 'yandex\backup')
      Remove-Item "$app.old" -Recurse -Force -ErrorAction SilentlyContinue
      if (Test-Path $app) { Rename-Item $app 'app.old' }
      Rename-Item $new 'app'
      Remove-Item "$app.old" -Recurse -Force -ErrorAction SilentlyContinue
      # The page itself (only the page — not the server's code) may be replaced by you without
      # administrator rights: deploy\selfhost-page.ps1.
      Grant (Join-Path $app 'service-manager.html') @("$($sid.Me):M")

      # Settings, made once. The service key is the one the Vercel functions use (Lockbox) —
      # read into memory, written to env, never shown.
      $e = Read-Env
      $secret = { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
      $defaults = [ordered]@{ PORT = '8080'; HOST = '127.0.0.1'; APP_DIR = $app; DATA_DIR = (Join-Path $Root 'data'); PUBLIC_ORIGIN = 'https://www.sad-budushego.ru'; API_ORIGIN = 'https://api.sad-budushego.ru' }
      foreach ($k in $defaults.Keys) { if (-not $e[$k]) { $e[$k] = $defaults[$k] } }
      if (-not $e['AUTH_SECRET']) { $e['AUTH_SECRET'] = & $secret }
      $serviceKey = ''
      $env:YC_CLI_INITIALIZATION_SILENCE = 'true'
      $yc = Join-Path $env:USERPROFILE 'yandex-cloud\bin\yc.exe'
      if (Test-Path $yc) {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $iam = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
        $ErrorActionPreference = $eap
        if ($iam) {
          try {
            $payload = Invoke-RestMethod -Uri 'https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets/e6qb5fo5urknt3m4ne3c/payload' -Headers @{ Authorization = "Bearer $iam" } -TimeoutSec 60
            $serviceKey = ($payload.entries | Where-Object { $_.key -eq 'SERVICE_KEY' }).textValue
          } catch { }
          $payload = $null
        }
        $iam = $null
      }
      if ($serviceKey -and $serviceKey.Length -ge 32) { $e['SERVICE_KEY'] = $serviceKey; Write-Output '== service key: the one the Vercel functions use' }
      elseif (-not $e['SERVICE_KEY']) { $e['SERVICE_KEY'] = & $secret; Write-Output '== service key: Lockbox not reachable — a new one; the Vercel functions will not reach this server until it is set' }
      $serviceKey = $null
      if (-not (Test-Path $envFile)) { New-Item -ItemType File $envFile | Out-Null }
      Grant $envFile @("$($sid.System):F", "$($sid.Admins):F", "$($sid.LocalService):R") -Only
      [IO.File]::WriteAllLines($envFile, [string[]]@(foreach ($k in $e.Keys) { "$k=$($e[$k])" }), (New-Object Text.UTF8Encoding $false))
      $e = $null

      # HTTPS for the site's two addresses, in front of the server.
      $store = (Join-Path $Root 'caddy-data').Replace('\', '/')
      $caddyfile = @"
{
	admin off
	storage file_system $store
	servers {
		protocols h1 h2
	}
}

www.sad-budushego.ru, sad-budushego.ru {
	encode zstd gzip
	request_body {
		max_size 300MB
	}
	reverse_proxy 127.0.0.1:8080 {
		transport http {
			read_timeout 170s
			write_timeout 170s
		}
	}
}
"@
      [IO.File]::WriteAllText((Join-Path $Root 'Caddyfile'), $caddyfile.Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding $false))
      $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $check = & $caddyExe validate --config (Join-Path $Root 'Caddyfile') --adapter caddyfile 2>&1 | ForEach-Object { "$_" }
      $code = $LASTEXITCODE
      $ErrorActionPreference = $eap
      if ($code -ne 0) { $check | Select-Object -Last 5; throw 'Caddyfile is not valid' }

      # The task that keeps it running.
      Write-Output "== scheduled task «$TaskName»"
      $action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$app\selfhost\windows-service.js`" `"$Root`"" -WorkingDirectory $Root
      # At boot — and every five minutes after, in case it has stopped (if it runs, nothing happens).
      $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)))
      $who = (New-Object Security.Principal.SecurityIdentifier 'S-1-5-19').Translate([Security.Principal.NTAccount]).Value
      $principal = New-ScheduledTaskPrincipal -UserId $who -LogonType ServiceAccount -RunLevel Limited
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -Priority 4
      Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Сад Будущего: the site served from this computer (deploy\selfhost-windows.ps1)' -Force | Out-Null

      # The internet may reach Caddy — and only Caddy — on 80 and 443.
      Write-Output '== firewall: ports 80 and 443 for Caddy'
      Get-NetFirewallRule -Name 'SadBudushego-Web' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
      New-NetFirewallRule -Name 'SadBudushego-Web' -DisplayName 'Сад Будущего — сайт (80, 443)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 80, 443 -Program $caddyExe -Profile Any | Out-Null

      # Never asleep — on the battery either: a power cut takes the router down too, and when the
      # power comes back the computer must still be awake, or it serves nobody until someone wakes
      # it. (A battery run flat still hibernates, as before.) The lid does nothing; the USB network
      # adapter is never put to sleep to save power.
      Write-Output '== power: never asleep (mains or battery), the lid does nothing, the network adapter always on'
      foreach ($k in 'standby-timeout-ac', 'standby-timeout-dc', 'hibernate-timeout-ac', 'hibernate-timeout-dc') { & powercfg.exe /change $k 0 }
      & powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
      & powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
      & powercfg.exe /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
      & powercfg.exe /setdcvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
      & powercfg.exe /setactive SCHEME_CURRENT
      Get-NetAdapter -Physical | ForEach-Object { try { Disable-NetAdapterPowerManagement -Name $_.Name -NoRestart -ErrorAction Stop } catch { } }

      # Windows Update restarts the computer only between 00:00 and 06:00, not in the working day.
      Write-Output '== Windows Update: restarts only between 00:00 and 06:00'
      $wu = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
      if (-not (Test-Path $wu)) { New-Item -Path $wu -Force | Out-Null }
      Set-ItemProperty -Path $wu -Name ActiveHoursStart -Value 6 -Type DWord
      Set-ItemProperty -Path $wu -Name ActiveHoursEnd -Value 0 -Type DWord
      Set-ItemProperty -Path $wu -Name SmartActiveHoursState -Value 0 -Type DWord
    }

    # ---- first data ----
    if ($ImportData) {
      $bk = Join-Path $env:USERPROFILE 'SadBudushego-Backup'
      $snap = Get-ChildItem (Join-Path $bk 'data') -Filter '*.json.gz' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
      if (-not $snap) { throw "No backup in $bk\data" }
      Write-Output "== loading the backup of $($snap.BaseName) and its files (a few minutes)"
      Invoke-Admin @('import', $snap.FullName, '--files', (Join-Path $bk 'files'))
      Invoke-Admin @('init-credentials')
    }

    # ---- the owner's password: typed in this window, straight into admin.js ----
    if ($SetOwnerPassword) {
      Write-Output '== the owner''s name and new password (the password is not shown while typed)'
      $e = Read-Env
      foreach ($k in 'APP_DIR', 'DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH_SECRET') { Set-Item "env:$k" $e[$k] }
      $e = $null
      $p = Start-Process -FilePath $nodeExe -ArgumentList @("`"$app\selfhost\admin.js`"", 'set-password', 'owner') -NoNewWindow -Wait -PassThru
      foreach ($k in 'APP_DIR', 'DATA_DIR', 'PUBLIC_ORIGIN', 'AUTH_SECRET') { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
      Write-Output $(if ($p.ExitCode -eq 0) { '== the owner''s password is set' } else { '== the owner''s password was NOT changed' })
    }

    # ---- new passwords for everyone but the owner: the list only in a file only you can read ----
    $passList = $null
    if ($ResetPasswords) {
      $passList = Join-Path $Root ('passwords-' + (Get-Date -Format 'yyyy-MM-dd-HHmm') + '.txt')
      Write-Output '== new passwords for every employee and provider (not the owner)'
      Invoke-Admin @('reset-passwords', $passList)
      Grant $passList @("$($sid.System):F", "$($sid.Admins):F", "$($sid.Me):F") -Only
    }

    Start-App

    if ($passList) {
      Start-Process notepad.exe -ArgumentList "`"$passList`""
      Write-Output '== the list is open in Notepad: send each one only their own line, privately'
      Read-Host 'Когда разошлёте пароли — нажмите Enter, и файл со списком будет удалён' | Out-Null
      Remove-Item $passList -Force
      Write-Output '== the list file is deleted'
    }
  }
} catch {
  $failed = $true
  Write-Output "FAILED: $($_.Exception.Message)"
  Write-Output ($_.InvocationInfo.PositionMessage)
} finally {
  Stop-Transcript | Out-Null
  if ($Elevated) { Read-Host 'Готово — нажмите Enter, чтобы закрыть окно' | Out-Null }
}
if ($failed) { exit 1 }
