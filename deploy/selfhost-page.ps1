# Puts the new service-manager.html on this computer's server — no administrator rights needed:
# the server serves the page straight from disk, and open pages pick up the new version by
# themselves (they check /app-version). The server's own code, Node and Caddy still go through
# deploy\selfhost-windows.ps1, which also grants the right to replace the page.
#
#   powershell -ExecutionPolicy Bypass -File deploy\selfhost-page.ps1

param([string]$Root = 'C:\SadBudushego')

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'service-manager.html'
$dest = Join-Path $Root 'app\service-manager.html'
$bytes = [IO.File]::ReadAllBytes($src)

# Written into the existing file (its rights stay as the installer set them).
try { $fs = [IO.File]::Open($dest, [IO.FileMode]::Truncate, [IO.FileAccess]::Write) }
catch { throw "Cannot write $dest — run deploy\selfhost-windows.ps1 once (it grants the right to replace the page)" }
try { $fs.Write($bytes, 0, $bytes.Length) } finally { $fs.Close() }

$got = Join-Path ([IO.Path]::GetTempPath()) ('sadb-page-' + [Guid]::NewGuid().ToString('N') + '.html')
& (Join-Path $env:SystemRoot 'System32\curl.exe') -s -m 15 -o $got 'http://127.0.0.1:8080/service-manager.html'
$same = (Test-Path $got) -and ((Get-FileHash $got).Hash -eq (Get-FileHash $src).Hash)
Remove-Item $got -ErrorAction SilentlyContinue
if (-not $same) { throw 'The server does not serve the new page — check C:\SadBudushego\logs' }
Write-Output ("== the page is live: {0:N0} KB, served by this computer" -f ($bytes.Length / 1KB))
