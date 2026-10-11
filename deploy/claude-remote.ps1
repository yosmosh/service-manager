# Opens a Claude Code session on this computer that you can continue from anywhere — the Claude
# app on the phone, or claude.ai — through Remote Control. It runs in this window, in the
# project folder; closing the window ends it. Uses the Claude Code that came with the editor's
# extension (the newest one installed), signed in as you.
#
#   powershell -ExecutionPolicy Bypass -File deploy\claude-remote.ps1

$ErrorActionPreference = 'Stop'
$roots = @("$env:USERPROFILE\.antigravity\extensions", "$env:USERPROFILE\.vscode\extensions")
$ver = { param($d) try { [version]($d.Name -replace '^anthropic\.claude-code-([\d.]+).*$', '$1') } catch { [version]'0.0' } }
$exe = Get-ChildItem $roots -Directory -ErrorAction SilentlyContinue |
  Where-Object Name -like 'anthropic.claude-code-*' |
  Sort-Object { & $ver $_ } |
  ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } |
  Where-Object { Test-Path $_ } | Select-Object -Last 1
if (-not $exe) { throw 'Claude Code was not found among the editor extensions' }

Set-Location (Split-Path -Parent $PSScriptRoot)
Write-Output "Claude Code $((& $exe --version) -join ''), Remote Control on — open the Claude app → Code to continue from the phone."
& $exe --remote-control 'sad-budushego'
