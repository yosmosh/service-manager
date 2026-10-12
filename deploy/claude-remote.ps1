# Opens a Claude Code session on this computer that you can continue from anywhere — the Claude
# app on the phone, or claude.ai — through Remote Control. It runs in this window, in the
# project folder; closing the window ends it. Uses the newest Claude Code on this computer (the
# installed one, or one that came with an editor's extension), signed in as you.
#
#   powershell -ExecutionPolicy Bypass -File deploy\claude-remote.ps1

$ErrorActionPreference = 'Stop'
$found = @(@("$env:USERPROFILE\.local\bin\claude.exe") | Where-Object { Test-Path $_ })
foreach ($root in "$env:USERPROFILE\.antigravity-ide\extensions", "$env:USERPROFILE\.antigravity\extensions", "$env:USERPROFILE\.vscode\extensions") {
  $found += Get-ChildItem $root -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } | Where-Object { Test-Path $_ }
}
$ver = { param($p) try { [version](((& $p --version 2>$null) -join '') -replace '^\s*([\d.]+).*$', '$1') } catch { [version]'0.0' } }
$exe = $found | Sort-Object { & $ver $_ } | Select-Object -Last 1
if (-not $exe) { throw 'Claude Code was not found on this computer' }

Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Output "Claude Code $((& $exe --version) -join ''), Remote Control on — open the Claude app → Code to continue from the phone."
& $exe --remote-control 'sad-budushego'
