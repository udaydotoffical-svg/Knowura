# Knowura AI

An education-focused AI chat assistant built as a static site + Netlify
Functions backend. Sign in with Google (or continue as a guest), chat with
an LLM that remembers facts about you across sessions, and — if you're the
owner — unlock an uncensored "owner mode" with a hardware security key.

## Features

- **Chat** powered by Groq (`openai/gpt-oss-20b`), with Markdown rendering
  for responses (headings, lists, code blocks, tables, etc.)
- **Live web search** — the backend detects search-worthy questions
  ("latest", "current", "who is", …) and augments answers with results from
  the Tavily API
- **Persistent memory** — facts about the user and a rolling conversation
  summary are extracted automatically and stored in `localStorage`, then fed
  back into every request. Opt-in, on by default — toggle it off from the
  menu and it stops reading/writing memory (existing memory isn't deleted;
  use Clear Memory for that)
- **Google Sign-In** for identity, with a guest mode that skips auth entirely.
  A "Stay signed in on this device" checkbox (checked by default) on the
  startup screen remembers your display name in `localStorage` and skips the
  startup screen on your next visit — there's no server-side session, so
  logging out (Settings → Log Out) just clears that local record
- **Owner mode** — unlocks an unrestricted system prompt for the site owner
  only, via a FIDO2/WebAuthn hardware security key **or** a password (for
  when a key isn't handy). Either path returns a short-lived, server-signed
  token (`OWNER_TOKEN_SECRET`) that `ask-ai.js` actually verifies — the
  client can't just claim to be the owner. The token lasts 4 hours and is
  kept in `localStorage` so a refresh stays unlocked — tick "This isn't my PC"
  in the unlock modal to keep it in memory for that tab only
- **Lofi music player** — a Spotify-inspired panel (now-playing card, seek
  bar, prev/play/next, volume, track queue) that auto-discovers every mp3 in
  `public/assets/audio/`. Drop a new track in that folder and it just shows
  up — no code changes needed (see [Adding tracks](#adding-tracks))
- **Live Voice mode** — a hands-free, phone-call-style conversation with
  Knowura. Default is **Seamless**: it auto-detects when you start/stop
  talking (client-side voice-activity detection on mic volume, no button
  press), transcribes with Groq Whisper, runs it through the same chat
  pipeline as typed messages, and speaks the reply back with Groq's Orpheus
  TTS — then automatically starts listening again. **Push to Talk** is
  available as an alternative in Settings if you'd rather control exactly
  when it listens. The avatar is a full-screen animated gif (your own art,
  in `assets/images/`) that swaps between idle/listening/thinking/speaking/
  ultra loops, with a subtle audio-reactive pulse while it talks. The call
  screen's backdrop is the same wallpaper as the rest of the app (not a
  blurred view of the chat transcript behind it), and a CC button toggles
  closed captions of Knowura's spoken replies (on by default)
- **Wake word ("Hey Knowura")** — optional, configurable in Settings:
  *Voice Mode Only* (default) lets you say it mid-call to interrupt Knowura
  and grab its attention; *Chat & Voice* also listens in the background
  (typed or spoken) to jump straight into a call; *Off* disables it. Spoken
  detection uses the browser's built-in Web Speech API (Chromium browsers
  only) and is best-effort by nature — see [Live Voice caveats](#live-voice--wake-word-caveats)
- **Settings menu** (⚙ in the header) — voice mode, wake word, and log out
- **Ultra Think mode** — a toggle (in the chat input row and inside Live
  Voice) that switches the backend to `openai/gpt-oss-120b` with
  `reasoning_effort: "high"` for slower, more rigorous answers, and surfaces
  the model's reasoning trace in a collapsible section. Can also be turned
  on/off just by typing or saying things like "activate thinking mode" —
  no toggle click needed. Active in Live Voice, it swaps the orb into a
  distinct red "ultra" animation

## Tech stack

- Static frontend: plain HTML/CSS/JS (`public/index.html`), [marked](https://github.com/markedjs/marked)
  for Markdown, [@simplewebauthn/browser](https://simplewebauthn.dev/) for
  passkey auth
- Backend: [Netlify Functions](https://docs.netlify.com/functions/overview/)
  (`functions/`), using [@simplewebauthn/server](https://simplewebauthn.dev/)
  and [@netlify/blobs](https://docs.netlify.com/blobs/overview/) to store the
  WebAuthn challenge/credential
- LLM: [Groq](https://groq.com/) · Web search: [Tavily](https://tavily.com/)

## Project structure

```
knowura/
├── public/                  # Netlify publish directory
│   ├── index.html
│   ├── terms.html            # /terms  (Terms & Conditions)
│   ├── privacy.html          # /privacy (Privacy Policy)
│   ├── eula.html             # /eula    (End User License Agreement)
│   ├── 404.html              # custom not-found page (Vercel + Netlify pick it up automatically)
│   ├── legal.css             # shared styles for those three pages
│   └── assets/
│       ├── images/          # logo, background, and the orb avatar gifs
│       └── audio/           # mp3 tracks + auto-generated manifest.json
├── functions/                # Netlify Functions (serverless backend)
│   ├── ask-ai.js             # chat + web search + Ultra Think, calls Groq
│   ├── transcribe.js         # speech-to-text via Groq Whisper (Live Voice)
│   ├── speak.js              # text-to-speech via Groq Orpheus TTS (Live Voice)
│   ├── owner-password-verify.js  # password fallback for Owner Mode
│   ├── _ownerToken.js        # shared HMAC token sign/verify (not a route)
│   ├── webauthn-register-options.js
│   ├── webauthn-register-verify.js
│   ├── webauthn-login-options.js
│   ├── webauthn-login-verify.js
│   ├── google-signin-verify.js   # server-side Google ID-token verification
│   ├── _userToken.js         # shared HMAC user-session token sign/verify (not a route)
│   ├── chat-load.js          # loads a signed-in user's cloud chat document
│   ├── chat-save.js          # overwrites a signed-in user's cloud chat document
│   ├── _vercelAdapter.js     # wraps a Netlify handler into Vercel's (req, res) shape
│   └── _store.js             # picks Netlify Blobs vs. a private Vercel Blob store at runtime
├── api/                      # Vercel Functions — one-line wrappers around functions/*.js
│   └── *.js                  # via _vercelAdapter.js, so both platforms run identical logic
├── scripts/
│   ├── generate-audio-manifest.js  # scans assets/audio/, writes manifest.json
│   └── check-init.js         # runs public/index.html's inline script against a stub
│                              # DOM in real Node/V8 to catch runtime init errors
│                              # (e.g. TDZ) that plain syntax/reference checks miss —
│                              # `npm run check:init` after editing that script
├── netlify.toml
├── vercel.json
└── package.json
```

### Deploying to both Netlify and Vercel

Knowura runs on either platform from this same repo, unmodified:

- **`functions/`** holds the actual logic (Netlify's native format,
  `exports.handler = async (event, context) => ({statusCode, headers, body})`).
- **`api/`** is Vercel's function convention — each file there is a one-line
  wrapper (`_vercelAdapter.js`) that adapts a `functions/*.js` handler into
  Vercel's `(req, res)` shape. No logic is duplicated between the two.
- **`public/index.html` needs zero changes either way** — it always calls
  `/.netlify/functions/*`, and `vercel.json` rewrites those same paths to
  `/api/*` on Vercel, so both deployments respond to identical URLs.
- **Storage is fully independent per platform, by design** — the two
  deployments do not share WebAuthn credentials or cloud chat data.
  `functions/_store.js` picks the backend automatically at runtime via
  `process.env.VERCEL` (set only on Vercel): Netlify uses `@netlify/blobs`
  as before, Vercel uses a **private** Vercel Blob store (`access: 'private'`
  — reads require the store's own token, not just a guessable URL, same
  "only this server can read it" guarantee as Netlify's manual-mode token).
  Every function that touches storage (`webauthn-*.js`, `chat-load.js`,
  `chat-save.js`) goes through this one shared abstraction.
- On Vercel, create a Blob store and attach it to the project (Vercel's
  dashboard → Storage, or `vercel blob create-store --access private`) —
  this auto-injects `BLOB_READ_WRITE_TOKEN` into the project's env vars, no
  manual copying needed. `NETLIFY_SITE_ID`/`NETLIFY_BLOBS_TOKEN` are **not**
  needed on Vercel at all.
- Copy the rest of the env vars (see the table above) into Vercel's
  dashboard too. One caveat: WebAuthn (`RP_ID`/`ORIGIN`) is origin-bound by
  design, so the security-key Owner Mode unlock only works from whichever
  single origin those two vars are set to on a given deployment — each
  platform can have its own values, but a single deployment can't unlock
  via security key from two different domains. The password fallback works
  from either, and since credentials aren't shared, Owner Mode has to be
  registered separately on each platform if you want the security-key path
  on both.

## Performance

- **Lite mode** (`html.lite`) turns off the expensive effects — backdrop blur, the prompt-box glow,
  sparks and animations — and swaps in a smaller wallpaper. Settings → Performance: **Auto**
  (default: Lite on devices reporting ≤4 GB RAM or ≤2 cores, or after a runtime lag watchdog sees
  sustained slow frames while you interact), **Lite**, or **Full**. It's decided in a tiny inline
  script in `<head>` so weak devices never paint the heavy version first.
- The wallpaper is 1920px (`background.jpg`, ~9 MB decoded) with a 1280px `background-lite.jpg`;
  don't drop a multi-thousand-pixel original back in — a 6000×4000 JPEG decodes to ~96 MB of RAM.
- The Live Voice avatar gif is only loaded while a call is open, music doesn't preload, and very
  long sessions/guest chat lists are capped.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

Set these in the Netlify UI (Site settings → Environment variables) or in a
local `.env` for `netlify dev`:

| Variable              | Used for                                              |
|-----------------------|--------------------------------------------------------|
| `GROQ_API_KEY`        | Chat completions, Whisper transcription, and Orpheus TTS — all via Groq |
| `TAVILY_API_KEY`      | Live web search results                                 |
| `RP_ID`               | WebAuthn relying party ID (your domain, e.g. `knowura.example`) |
| `ORIGIN`              | WebAuthn expected origin (e.g. `https://knowura.example`) |
| `NETLIFY_SITE_ID`     | Required by `@netlify/blobs` outside Netlify's own runtime |
| `NETLIFY_BLOBS_TOKEN` | Required by `@netlify/blobs` outside Netlify's own runtime |
| `OWNER_PASSWORD`      | Password fallback for unlocking Owner Mode without a security key |
| `OWNER_TOKEN_SECRET`  | Signs the short-lived token both unlock paths issue — pick a long random string. **Owner mode silently fails closed without this set**, on both the security-key and password paths |
| `GOOGLE_CLIENT_ID`    | Server-side copy of the OAuth client ID (same value as the `data-client_id` hardcoded in `index.html`) — used by `google-signin-verify.js` to check a credential's `aud` before trusting it |
| `WEBAUTHN_SETUP_SECRET` | Only needed for first-time security-key registration: the caller must send it as the `X-Setup-Secret` header. Unset = registration is disabled. Once a key exists, replacing it needs a valid owner token (`X-Owner-Token`) instead. Remove it after setup |
| `KNOWURA_TOKEN_REVOKE_BEFORE` | Optional kill switch: a millisecond timestamp — every user session token issued before it stops working (e.g. `Date.now()` in a console) |
| `KNOWURA_USER_TOKEN_SECRET` | Signs the session token issued after a verified Google sign-in (`_userToken.js`), used by `chat-load.js`/`chat-save.js` to trust which account's blob to read/write. Separate secret from `OWNER_TOKEN_SECRET` — different trust domain, don't reuse |

Live Voice mode also needs the site to be served over **HTTPS** (or
`localhost`) and the browser's microphone permission — both `getUserMedia`
and `AudioContext` require a secure context.

#### Live Voice + wake word caveats

- Voice-activity detection uses a fixed volume threshold (`VAD_SPEECH_RMS` in
  `public/index.html`) tuned by eye, not measured against real hardware — if
  it cuts you off too early/late on your mic, adjust that constant (and
  `VAD_SILENCE_MS`, the pause length before it decides you're done talking).
- The wake word ("Hey Knowura") relies on the non-standard Web Speech API
  (`SpeechRecognition`), which only has solid support in Chrome/Edge and, in
  Chrome, sends audio to Google's servers for recognition. Firefox/Safari
  will silently just not enable it. Treat it as a bonus, not a guarantee.
- None of the voice code was tested against real microphone/speaker hardware
  or a live Groq key while building this — worth a real run-through after
  deploying, especially the VAD threshold and the Orpheus voice name.
- Groq deprecates models on a fairly short cycle (this project already hit
  it twice: `llama-3.1-8b-instant` and `playai-tts` were both retired mid-
  project). If chat, transcription, or TTS suddenly stop working, check
  [console.groq.com/docs/deprecations](https://console.groq.com/docs/deprecations)
  before assuming it's a code bug — the model name in `ask-ai.js`/`speak.js`/
  `transcribe.js` may just need updating. Some models (Orpheus TTS included)
  also require accepting their terms once in the Groq console before the API
  key can use them: `console.groq.com/playground?model=canopylabs/orpheus-v1-english`.

If you fork this project, also swap the Google OAuth client ID hardcoded in
`public/index.html` (`data-client_id`) for your own, registered at the
[Google Cloud Console](https://console.cloud.google.com/apis/credentials).

### 3. Set up owner unlock (one-time, admin only)

The Unlock Owner modal (not shown in any menu — it's opened by a hidden gesture in the app) offers two ways
in — pick one or set up both:

- **Security key**: the modal's "Use Security Key" button only *logs in*
  with an already-registered key — there's no UI for registration. To
  register one, set `WEBAUTHN_SETUP_SECRET`, then call
  `webauthn-register-options` and `webauthn-register-verify` directly with an
  `X-Setup-Secret: <that value>` header (e.g. via a small script using
  `@simplewebauthn/browser`'s `startRegistration`) once, from a trusted
  device, and remove the env var afterwards. Registration endpoints reject
  everyone else, so nobody can swap in their own key.
- **Password**: just set the `OWNER_PASSWORD` env var (and
  `OWNER_TOKEN_SECRET`, required either way) — no registration step.

Both paths verify server-side in `ask-ai.js` via a signed token; there's no
way to unlock owner mode by sending a raw flag from the browser.

### Security & abuse protection

- **Auth routes** (owner password, security-key login/registration, Google sign-in) allow
  **5 attempts per 15 minutes per IP** (Google sign-in counts *failed* attempts, so a shared
  school network isn't locked out). Counters live in the private storage so they hold across
  serverless instances.
- **Message limits** protect the API keys: a per-minute burst limit, a cap per person per
  5-hour window (guest `LIMIT_GUEST`=60, signed-in `LIMIT_USER`=150, voice `LIMIT_VOICE`=40;
  window length `LIMIT_WINDOW_HOURS`), a small cap for background helper calls, and a global
  daily circuit breaker (`LIMIT_GLOBAL_DAILY`). **Owner mode is never limited.** See
  `.env.example` for defaults.
  Hitting a limit shows a pop-up with a live countdown (and, for guests, a prompt to sign in
  with Google for a bigger allowance). Limits are counted on the server against a verified
  identity — the signed-in account, else the IP address as the hosting platform reports it
  (never a client-supplied header; IPv6 by /64). Background helper calls are only allowed in
  proportion to real messages, so they can't be used as a side door. Add Upstash Redis
  (`UPSTASH_REDIS_REST_URL/TOKEN`) to make the counters exact under parallel bursts.
- **Owner mode via Google:** signing in with the Google account in `OWNER_EMAIL` (verified by
  Google) switches to owner mode automatically; the server issues the owner token, and
  reloading keeps it. Optionally pin the exact account with `OWNER_GOOGLE_SUB`.
- **Payloads:** every function requires the right method, same-origin browser calls (extra
  origins via `ALLOWED_ORIGINS`), a JSON *object* within a byte budget, and validates each
  field's type and length. Cloud chat documents are rebuilt from a whitelist before saving.
  Client-supplied `system` messages are dropped; saved "memory" is fenced off as untrusted data.
- **Rendering:** the user's own messages are escaped, and all saved/AI HTML is sanitized with
  DOMPurify. The front-end libraries are self-hosted in `public/assets/vendor/`. A strict
  Content-Security-Policy (plus HSTS, frame, referrer and permissions headers) is set in
  `vercel.json` / `netlify.toml`.
- **Secrets:** everything sensitive is an environment variable (`.env.example` lists them);
  `.env*` is git-ignored and `npm run check:secrets` (also part of `npm test`) fails if a
  credential-looking string is committed. The Google OAuth *client ID* in `index.html` is
  public by design.

Run the tests with `npm test`.

### 4. Run locally

```bash
netlify dev
```

This serves `public/` and proxies `/.netlify/functions/*` to the functions
in `functions/`.

## Adding tracks

Drop any `.mp3` file into `public/assets/audio/` — the player picks it up
automatically, no code changes needed:

- **On Netlify**: `netlify.toml` runs `npm run build` before every deploy,
  which regenerates `assets/audio/manifest.json` from whatever's in the
  folder. Just commit the mp3 and push.
- **Locally**: run `npm run generate:audio` to regenerate the manifest
  yourself before testing.

The frontend fetches `assets/audio/manifest.json` on load and builds the
track list from it. Track titles are auto-derived from the filename
(`flower-cup.mp3` → "Flower Cup"); rename the file if you want a different
display name. If the manifest is ever missing or empty, the player falls
back to the five tracks bundled with the repo.

## Deploy

Push to your connected Git provider — Netlify picks up `netlify.toml`
automatically (`command = "npm run build"`, `publish = "public"`,
`functions = "functions"`).

---

Built by Uday Singh.
