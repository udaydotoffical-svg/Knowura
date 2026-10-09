# Repo layout

```
public/            the website (served as-is). index.html is the app, assistant.html the assistant panel
  assets/ui/       GENERATED shared UI + theme files (npm run build): do not edit by hand
  assets/icons/    app icons, tiles and the 48px favicon (old root URLs redirect here)
  assets/brand/    logo and K mark
  assets/{images,audio,fonts,vendor,video,attach}/
functions/         one file per endpoint (Netlify style)
  _lib/            shared helpers for the endpoints (limits, tokens, store, safety, ...); not endpoints
api/               thin Vercel wrappers that call the functions/ handlers (Vercel's 12-function limit: see misc.js)
android/           the Android app (assistant panel, bubble, TWA launcher)
desktop/           the Windows (Electron) app
scripts/           build-shared-ui.js, build-themes.js, write-version.js, pixel-icons/ (icon builder), checks
test/              npm test
design/            artwork sources that are not served
.github/workflows/ Android and Windows builds
```

Rules of thumb
- Change the app UI in `public/index.html` or `public/assistant.html`, then run `npm run build` (it regenerates `public/assets/ui/`).
- A new endpoint is a file in `functions/`, a wrapper in `api/` (or an op in `api/misc.js`), and shared code goes in `functions/_lib/`.
- `npm test` fails if a generated file is stale or a referenced file is missing.
