# Knowura for Windows

A small tray app around https://knowura.vercel.app/assistant. The page itself is the website, so it updates the moment the
site does: nothing to re-install for normal changes.

- **Alt+Space** opens the assistant on the **text box** (ready to type, microphone off); **Ctrl+Space** opens it in **voice mode**. If Windows won't give one up, the fallbacks are **Ctrl+Alt+K** (text) and **Ctrl+Alt+V** (voice). Pressing the other hotkey while it is open switches modes; pressing the same one again hides it.
- **Esc**, **Minimize** or **End call** tucks it back into the tray. Pulling the handle up opens the full Knowura app in its own window.
- Tray menu: start with Windows, hide when I click away, open the full app, quit.

## Low memory
No GPU process, a capped JS heap, one small renderer, and after the popup has been hidden for two minutes its window is
destroyed completely (only the tray stays) and rebuilt the next time you open it.

## Build
`npm ci && npm start` runs it; `npm run dist` makes the installer and the portable `.exe` in `dist/`
(the GitHub workflow "Build Windows app" does this on a Windows runner and publishes a release).
The app is not code-signed, so Windows SmartScreen may warn on first run (More info, then Run anyway).
