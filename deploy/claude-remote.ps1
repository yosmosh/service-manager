# Claude Code on this computer, reachable from anywhere — the Claude app on the phone, or
# claude.ai/code — through Remote Control. Uses the newest Claude Code on this computer (the
# installed one, or one that came with an editor's extension), signed in as you, in the project
# folder.
#
#   powershell -ExecutionPolicy Bypass -File deploy\claude-remote.ps1
#        the Remote Control server: from the phone you open sessions on this computer whenever
#        you like (it keeps running in this window — minimised is fine; closing it ends it)
#   ... -Install       also start it by itself, minimised, every time you sign in to Windows
#                      (a shortcut in Startup) — after the night's update restart it comes back
#                      as soon as someone signs in
#   ... -Uninstall     no longer start it at sign-in
#   ... -Interactive   one session in this window instead, also continued from the phone

param([switch]$Install, [switch]$Uninstall, [switch]$Interactive)

$ErrorActionPreference = 'Stop'
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Claude remote - Sad Budushego.lnk'
if ($Uninstall) { Remove-Item $lnk -ErrorAction SilentlyContinue; Write-Output 'No longer started at sign-in.'; return }
if ($Install) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $s.WorkingDirectory = Split-Path -Parent $PSScriptRoot
  $s.WindowStyle = 7   # minimised
  $s.Description = 'Claude Code Remote Control for Сад Будущего (deploy\claude-remote.ps1)'
  $s.Save()
  Write-Output "Starts by itself at every sign-in to Windows: $lnk"
}

$found = @(@("$env:USERPROFILE\.local\bin\claude.exe") | Where-Object { Test-Path $_ })
foreach ($root in "$env:USERPROFILE\.antigravity-ide\extensions", "$env:USERPROFILE\.antigravity\extensions", "$env:USERPROFILE\.vscode\extensions") {
  $found += Get-ChildItem $root -Directory -Filter 'anthropic.claude-code-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'resources\native-binary\claude.exe' } | Where-Object { Test-Path $_ }
}
$ver = { param($p) try { [version](((& $p --version 2>$null) -join '') -replace '^\s*([\d.]+).*$', '$1') } catch { [version]'0.0' } }
$exe = $found | Sort-Object { & $ver $_ } | Select-Object -Last 1
if (-not $exe) { throw 'Claude Code was not found on this computer' }

# Sessions start in claude-remote\ — not the home folder itself, whose trust Claude Code never
# saves (so every start would stop on the question). Its CLAUDE.md points at the project here,
# its settings add this folder to the workspace, and its memory folder is a junction to ours.
$work = Join-Path (Split-Path -Parent $PSScriptRoot) 'claude-remote'
if (-not (Test-Path (Join-Path $work 'CLAUDE.md'))) { throw "$work is missing — see the commit that made it" }
Set-Location $work
$Host.UI.RawUI.WindowTitle = 'Claude remote - Sad Budushego'
# One server is enough: another start (a second sign-in, a double click) leaves the running one.
if (-not $Interactive -and (Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.CommandLine -match 'remote-control' -and $_.CommandLine -match 'sad-budushego' })) {
  Write-Output 'The Remote Control server is already running.'; Start-Sleep -Seconds 5; return
}
Write-Output "Claude Code $((& $exe --version) -join ''), Remote Control — open the Claude app (or claude.ai/code) → Code on the phone."
if ($Interactive) { & $exe --remote-control 'sad-budushego' }
else { & $exe remote-control --name 'sad-budushego' --permission-mode auto --spawn=same-dir }
