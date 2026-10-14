# Сад Будущего — sessions from the phone

This folder only exists so Remote Control (deploy\claude-remote.ps1) can start sessions from the
phone — Claude Code never saves trust for the home folder. The project itself is the git repo at
**C:\Users\yosef** (service-manager.html, deploy\, selfhost\, yandex\, api\): work there, and run
git as `git -C C:\Users\yosef …`.

- Always answer the user in Hebrew.
- The memory folder is shared with the desktop sessions (a junction) — read MEMORY.md first.
- A change to service-manager.html goes live with
  `powershell -ExecutionPolicy Bypass -File C:\Users\yosef\deploy\selfhost-page.ps1` (after commit + push).
  Server code changes need the user to run C:\Users\yosef\deploy\selfhost-windows.ps1 (UAC) at the computer.
- Another session (the desktop one) may be working in the same repo: check `git -C C:\Users\yosef status` first.