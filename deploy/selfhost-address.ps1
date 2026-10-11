# Points the site's address at this computer (deploy\selfhost-windows.ps1) — or back at Yandex
# Cloud — and keeps it pointed while this house's internet address changes (MGTS hands out a new
# one now and then).
#
#   powershell -ExecutionPolicy Bypass -File deploy\selfhost-address.ps1
#        where the records point now, and this house's internet address
#   ... -Here     www.sad-budushego.ru and sad-budushego.ru → this house's internet address;
#                 the task «SadBudushego Address» (every 5 minutes and at boot, as you, also
#                 before anyone signs in) moves them along when that address changes; and once
#                 the world sees the new address, the server is restarted so that Caddy fetches
#                 its HTTPS certificates at once
#   ... -Yandex   both back at the Yandex Cloud gateway, as they were; the task removed. Only
#                 after what was entered here has been carried to Yandex — never two places
#                 taking data at once
#   ... -Check    what the task runs: if the records point at an address (not at Yandex) and
#                 this house's address is another, move them to it
#
# DNS: Yandex Cloud DNS, through yc signed in as you. -Here and -Yandex ask Windows for
# administrator rights (the task, the restart). The task writes to
# %LOCALAPPDATA%\SadBudushego\address.log.

param([switch]$Here, [switch]$Yandex, [switch]$Check, [switch]$Elevated)

$ErrorActionPreference = 'Stop'
$Zone = 'dnsev43n919so40upjer'
$Names = @('sad-budushego.ru.', 'www.sad-budushego.ru.')
$Gateway = 'd5do4n0o23evidqovr16.jki8ffxa.apigw.yandexcloud.net.'
$Ttl = '300'
$TaskName = 'SadBudushego Address'
$dir = Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:TEMP }) 'SadBudushego'
$log = Join-Path $dir 'address.log'
$savedFile = Join-Path $dir 'dns-yandex.json'
$api = "https://dns.api.cloud.yandex.net/dns/v1/zones/$Zone"
New-Item -ItemType Directory -Force $dir | Out-Null

function Say([string]$m) {
  Write-Output $m
  if ($Check) { Add-Content -Path $log -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 }
}

# ---- administrator rights for -Here / -Yandex: run again, elevated, in a window of its own ----
$me = [Security.Principal.WindowsIdentity]::GetCurrent()
if (($Here -or $Yandex) -and -not ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated')
  if ($Here) { $a += '-Here' }
  if ($Yandex) { $a += '-Yandex' }
  Write-Output 'Windows will ask for permission; the work goes on in a new window.'
  $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $a -Wait -PassThru
  if (Test-Path (Join-Path $dir 'switch.log')) { Get-Content (Join-Path $dir 'switch.log') -Encoding UTF8 | Where-Object { $_ -notmatch '^\*{10}|^(Start|End) time|^(Username|RunAs User|Configuration Name|Machine|Host Application|Process ID|PSVersion|PSEdition|PSCompatibleVersions|BuildVersion|CLRVersion|WSManStackVersion|PSRemotingProtocolVersion|SerializationVersion|Windows PowerShell transcript)' } }
  exit $p.ExitCode
}

function Get-Iam {
  $env:YC_CLI_INITIALIZATION_SILENCE = 'true'
  $yc = Join-Path $env:USERPROFILE 'yandex-cloud\bin\yc.exe'
  $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $t = ((& $yc iam create-token 2>$null | Out-String) -split "`r?`n" | Where-Object { $_ -match '^t1.' } | Select-Object -First 1)
  $ErrorActionPreference = $eap
  if (-not $t) { throw 'yc gave no token (signed in?)' }
  return $t
}

# The record sets of the site's two names that say where it is (A, AAAA, CNAME, ANAME).
function Get-Sets([string]$iam) {
  $r = Invoke-RestMethod -Uri "$api`:listRecordSets?pageSize=1000" -Headers @{ Authorization = "Bearer $iam" } -TimeoutSec 60
  return @($r.recordSets | Where-Object { $Names -contains $_.name -and @('A', 'AAAA', 'CNAME', 'ANAME') -contains $_.type })
}

# Deletions and additions in one change: all applied, or none.
function Update-Sets([string]$iam, $deletions, $additions) {
  $body = @{ deletions = @($deletions | ForEach-Object { @{ name = $_.name; type = $_.type; ttl = "$($_.ttl)"; data = @($_.data) } }); additions = @($additions | ForEach-Object { @{ name = $_.name; type = $_.type; ttl = "$($_.ttl)"; data = @($_.data) } }) } | ConvertTo-Json -Depth 6
  $op = Invoke-RestMethod -Uri "$api`:updateRecordSets" -Method Post -Headers @{ Authorization = "Bearer $iam" } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
  if ($op.error) { throw "DNS change refused: $($op.error.message)" }
}

function Test-Private([string]$ip) {
  $o = $ip.Split('.') | ForEach-Object { [int]$_ }
  return ($o[0] -eq 10) -or ($o[0] -eq 127) -or ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) -or ($o[0] -eq 192 -and $o[1] -eq 168) -or ($o[0] -eq 100 -and $o[1] -ge 64 -and $o[1] -le 127) -or ($o[0] -eq 169 -and $o[1] -eq 254) -or ($o[0] -eq 0)
}

# This house's internet address: asked through the cable (or the Wi-Fi) itself — not through the
# VPN, which would answer with its own.
function Get-HouseIp {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  $ads = Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | Sort-Object { if ($_.MediaType -eq '802.3') { 0 } else { 1 } }
  foreach ($ad in $ads) {
    $cfg = Get-NetIPConfiguration -InterfaceIndex $ad.ifIndex
    if (-not $cfg.IPv4DefaultGateway) { continue }
    foreach ($local in @($cfg.IPv4Address | ForEach-Object IPAddress)) {
      $r = & $curl -s -m 10 --interface $local 'https://ipv4-internet.yandex.net/api/v0/ip' 2>$null
      $ip = "$r".Trim().Trim('"')
      if ($ip -match '^\d{1,3}(\.\d{1,3}){3}$' -and -not (Test-Private $ip)) { return $ip }
    }
  }
  return $null
}

function Show-Sets($sets) { foreach ($s in $sets) { Say ("   {0,-24} {1,-6} {2}" -f $s.name, $s.type, ($s.data -join ', ')) } }

$transcript = $false
try {
  if ($Elevated) { Start-Transcript -Path (Join-Path $dir 'switch.log') -Force | Out-Null; $transcript = $true }

  if ($Check) {
    # ---- the task: follow this house's address, if the site is here ----
    $iam = Get-Iam
    $sets = Get-Sets $iam
    $a = @($sets | Where-Object type -eq 'A')
    if ($a.Count -ne $Names.Count -or $sets.Count -ne $a.Count) { return }   # not here: nothing to follow
    $ip = Get-HouseIp
    if (-not $ip) { Say 'no internet address found (no connection?) — nothing changed'; return }
    if (@($a | Where-Object { @($_.data).Count -ne 1 -or $_.data[0] -ne $ip }).Count -eq 0) { return }
    Update-Sets $iam $a @($a | ForEach-Object { @{ name = $_.name; type = 'A'; ttl = $Ttl; data = @($ip) } })
    Say "the house's address changed: $(($a | ForEach-Object { $_.data -join ',' } | Select-Object -Unique) -join ', ') → $ip; records moved"

  } elseif ($Here) {
    # ---- the site → this computer ----
    $ip = Get-HouseIp
    if (-not $ip) { throw 'This house''s internet address could not be found — nothing changed' }
    $iam = Get-Iam
    $sets = Get-Sets $iam
    Say '== now:'; Show-Sets $sets
    $yandexSets = @($sets | Where-Object { $_.type -ne 'A' -and $_.type -ne 'AAAA' })
    if ($yandexSets.Count) { $yandexSets | ConvertTo-Json -Depth 6 | Set-Content -Path $savedFile -Encoding UTF8 }
    $additions = @($Names | ForEach-Object { @{ name = $_; type = 'A'; ttl = $Ttl; data = @($ip) } })
    Update-Sets $iam $sets $additions
    Say "== the site's address → this house, ${ip}:"; Show-Sets (Get-Sets $iam)

    Say "== the task «$TaskName»: follows the house's address every 5 minutes"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Check"
    $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 5)))
    $principal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Сад Будущего: keeps www.sad-budushego.ru pointed at this house (deploy\selfhost-address.ps1)' -Force | Out-Null

    # Caddy fetches its certificates once the world sees the new address — so wait for that.
    Say '== waiting until the world sees the new address (up to 7 minutes)'
    $deadline = (Get-Date).AddMinutes(7)
    do {
      Start-Sleep -Seconds 20
      $seen = @('8.8.8.8', '1.1.1.1', '77.88.8.8' | ForEach-Object {
        try { @(Resolve-DnsName -Name 'www.sad-budushego.ru' -Type A -Server $_ -DnsOnly -NoHostsFile -ErrorAction Stop | Where-Object Type -eq 'A' | ForEach-Object IPAddress) -contains $ip } catch { $false }
      })
      Say ("   " + (($seen | ForEach-Object { if ($_) { 'yes' } else { 'not yet' } }) -join ' / '))
    } while ((@($seen | Where-Object { -not $_ }).Count) -and (Get-Date) -lt $deadline)
    Say '== restarting the server, so Caddy fetches the certificates now'
    & (Join-Path $PSScriptRoot 'selfhost-windows.ps1') -Restart
    Say '== waiting for https://www.sad-budushego.ru (up to 5 minutes)'
    $deadline = (Get-Date).AddMinutes(5); $ok = $false
    do {
      Start-Sleep -Seconds 15
      $code = & (Join-Path $env:SystemRoot 'System32\curl.exe') -s -o NUL -m 15 -w '%{http_code}' 'https://www.sad-budushego.ru/healthz' 2>$null
      $ok = "$code" -eq '200'
    } while (-not $ok -and (Get-Date) -lt $deadline)
    Say $(if ($ok) { '== https://www.sad-budushego.ru answers from this computer' } else { "== not answering yet over HTTPS — see C:\SadBudushego\logs\caddy.log" })

  } elseif ($Yandex) {
    # ---- the site → back to Yandex Cloud ----
    Say 'Everything entered on this computer since the switch is NOT in Yandex. Switch back only after it has been carried over.'
    if ((Read-Host 'Напишите YANDEX, чтобы вернуть адрес в Yandex Cloud') -cne 'YANDEX') { throw 'Not confirmed — nothing changed' }
    $iam = Get-Iam
    $sets = Get-Sets $iam
    $back = if (Test-Path $savedFile) { @(Get-Content $savedFile -Raw -Encoding UTF8 | ConvertFrom-Json) } else {
      @(@{ name = 'sad-budushego.ru.'; type = 'ANAME'; ttl = $Ttl; data = @($Gateway) }, @{ name = 'www.sad-budushego.ru.'; type = 'CNAME'; ttl = $Ttl; data = @($Gateway) })
    }
    Update-Sets $iam $sets $back
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Say '== the site''s address → Yandex Cloud:'; Show-Sets (Get-Sets $iam)
    Say '== then stop this computer''s copy: deploy\selfhost-windows.ps1 -Stop'

  } else {
    $iam = Get-Iam
    Say '== the records:'; Show-Sets (Get-Sets $iam)
    Say "== this house's internet address: $(Get-HouseIp)"
  }
} catch {
  Say "FAILED: $($_.Exception.Message)"
  $failed = $true
} finally {
  if ($transcript) { Stop-Transcript | Out-Null }
  if ($Elevated) { Read-Host 'Готово — нажмите Enter, чтобы закрыть окно' | Out-Null }
}
if ($failed) { exit 1 }
