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
  client can't just claim to be the owner. Verification state is in-memory
  only and resets on refresh
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
  ultra loops, with a subtle audio-reactive pulse while it talks
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
│   └── webauthn-login-verify.js
├── scripts/
│   └── generate-audio-manifest.js  # scans assets/audio/, writes manifest.json
├── netlify.toml
└── package.json
```

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

The "Unlock Owner" option (in the ☰ menu) opens a modal offering two ways
in — pick one or set up both:

- **Security key**: the modal's "Use Security Key" button only *logs in*
  with an already-registered key — there's no UI for registration. To
  register one, call `webauthn-register-options` then
  `webauthn-register-verify` directly (e.g. via a small script or `curl`
  sequence using `@simplewebauthn/browser`'s `startRegistration`) once,
  from a trusted device.
- **Password**: just set the `OWNER_PASSWORD` env var (and
  `OWNER_TOKEN_SECRET`, required either way) — no registration step.

Both paths verify server-side in `ask-ai.js` via a signed token; there's no
way to unlock owner mode by sending a raw flag from the browser.

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
