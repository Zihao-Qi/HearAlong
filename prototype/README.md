# HearAlong: setup and details

Local speech recognition, selectable transcript text, draft notes, a live board, project memory, and evidence-linked plans. The supported desktop workflow is macOS with Google Chrome. Fixtures are fictional; recordings, personal materials, model weights, runtime databases, and saved AI sessions are not distributed.

## Setup and start

Requirements:
- Node.js ≥ 22.19.0 and npm.
- Google Chrome for the app. Browser checks and rehearsals require `MEETING_TEST_CHROME` pointing to a disposable Chromium executable; they never default to the user's browser.
- FFmpeg and ffprobe on PATH for audio import and recognition.
- A compatible speech model for `transcribe-cpp`; the setup page finds installed models or downloads Parakeet.
- Optional AI: Pi signed in to your model subscription. A pinned Pi is included; a Pi on PATH is preferred. Calculations also need `uv`; the app prepares a pinned Python environment. Web lookup needs Pi's `pi-web-access` package enabled.

```sh
git clone https://github.com/Zihao-Qi/HearAlong.git
cd HearAlong/prototype
npm ci --ignore-scripts
npm start
```

The setup page finds or downloads a speech model, checks FFmpeg, and offers optional AI and microphone setup.

Open **http://127.0.0.1:4318** (not `localhost`: the server validates host and origin). Starting the server does not start recording. Use the microphone button only with everyone's consent; Ctrl+C stops the server. The root-level `Start Prototype.command` starts the same server and opens Chrome; set `MEETING_CLOUD=0` in its environment if you want local-only operation.

If a speech model or FFmpeg goes missing later, existing meetings remain readable; use Settings › This Mac › Setup to restore speech. Advanced options: `MEETING_MODEL_PATH=/path/to/model.gguf` overrides the saved speech choice; Pi Voice settings are also discovered read-only. The unit tests and `app-check` below need neither speech weights nor a cloud account.

## Use

- Create a meeting, start the microphone, or replay a recording you supply. Call-audio capture uses Chrome's share-audio controls when available. Me/Them labels identify capture channels, not individual people.
- Attach project materials by path. The app reads them for glossary generation, answers, and plans; attach only material you intend to share with the configured AI provider.
- Select transcript text for explanation, lookup, calculation, or another question. Evidence checks verify that quotes occur in supplied sources, not that the underlying claims are true.
- Review draft notes, board cards, project-memory changes, and plans before relying on them. Plans can add steps to project to-dos.
- Export corrected or raw transcript Markdown. Settings control model choices, mini-window behavior, and audio retention.

## Privacy and optional AI

**Cloud AI is enabled by default unless `MEETING_CLOUD=0`.** With it enabled, Pi may send transcript excerpts, selected text, project-memory snapshots, attached-material excerpts, and tool inputs/results to your configured provider. Web tools contact external services. Calculations execute generated Python in a scratch environment; review sensitive inputs before enabling them.

Audio recognition stays local. Do not treat that as a guarantee that all app data stays local when optional AI is on. When Pi lists them, setup defaults to `openai-codex/gpt-6.1-sol` (main/correction) and `openai-codex/gpt-6-luna` (quick). Choose any listed pair in Settings › Setup. Advanced overrides: `MEETING_HEAVY_MODEL`, `MEETING_CORRECTION_MODEL`, and `MEETING_QUICK_MODEL`.

Runtime data lives in `data/`, or `MEETING_DATA_DIR`: SQLite records, audio, imports, notes, project memory, tool scratch files, and AI session logs. These can contain sensitive content and are Git-ignored. Audio retention defaults to one day after completed processing; settings also offer a week, a month, or always. Transcripts and notes are retained. Do not publish runtime folders or logs.

Quote checks are counted locally in `data/metrics/quote-checks.json`: per feature (board, notes, plans, actions), model id and ISO week, how many model claims passed the evidence check and how many failed, by a fixed list of reasons (such as `quote_not_found` or `no_citation`). The file holds counts only, never quotes, text, meeting ids, paths or times finer than a week, and it never leaves the Mac. `node --experimental-strip-types scripts/quote-metrics.ts [file or data folder] [--json]` prints the share that failed per feature and model; it only reads.

## Public repository guard

Run `npm run guard:install` from `prototype/` to set the absolute main-tree `.githooks` path for every worktree, including older revisions (requires Git and Node.js).
Keep your ignored `private/public-denylist.txt` in the main working tree; linked worktrees share it, and missing/unreadable/empty lists block commits and pushes.
Hooks check identities, added lines/paths, refs, commit/tag messages, runtime/media/environment files and files over 2 MB; fix staged changes or rewrite offending commits/tags before pushing.

## Checks

Run from this directory:

```sh
npm test
npm run check                 # tsc --noEmit
MEETING_TEST_CHROME=/path/to/disposable/chromium node --experimental-strip-types scripts/app-check.ts
# Full isolated suite (Node, npm, FFmpeg/ffprobe and test Chromium must be installed):
MEETING_TEST_CHROME=/path/to/disposable/chromium npm run checks -- /path/to/new-output-dir
```

The full runner runs at most two suites at once, each under `nice -n 19` with a 20-minute timeout (`MEETING_CHECK_TIMEOUT_S=<seconds>` changes it; CI allows 30 minutes). Each suite has its own temporary directory; timeout cleanup finishes group escalation and removes only that suite's detached test browsers before reusing its slot. Logs, screenshots and `summary.txt` stay in the output directory, including the leftover test-browser count. HOME, HF_HOME and temporary state are isolated there; npm is offline, Pi is a metadata-only stand-in, model calls fail, and Node fetch/browser requests are loopback-only (Node redirects are checked before each hop). The runner generates fictional WAV audio, so a fresh checkout needs no untracked recording or speech weights. The browser checks it runs also install these guards when invoked directly.

`app-check` uses headless Chrome with disposable profiles, a temporary database and a free port. It checks installability and service-worker recovery when the local server stops and restarts. It makes no model calls. `board-focus-check.ts` exercises mini-card reveal and keyboard focus across periodic refreshes.

Other included tools:
- `npm run smoke:stt`: creates a synthetic speech clip with macOS `say`, then checks real local recognition. Requires a model and FFmpeg.
- `npm run smoke:browser`: UI smoke check with generated fictional audio, scripted speech recognition and fake streaming drafts; requires `MEETING_TEST_CHROME`, not a model or prior speech-smoke run.
- `scripts/plans-fixtures-build.ts`: regenerates the fictional Plans page fixtures. The unit suite checks that generated data stays current.
- `scripts/plans-check.ts`, `plans-lifecycle-check.ts`, `notes-ui-check.ts`, `m9a-page-check.ts`, `transcript-notes-page-check.ts`, and `audio-retention-check.ts`: browser/domain checks using temporary or fictional data.
- Layout, mini, launcher, native-mini, replay, and transcription tools document their required input arguments in their source. Supply only your own or synthetic recordings/stores; no private input is bundled. Native launcher checks require a separately built macOS helper and Swift tools.

The optional `scripts/build-app.sh` builds and registers the local macOS helper; it records your local executable paths in its generated bundle. Generated bundles belong in ignored `dist/` and must not be published as source. A browser-only start does not require the helper.

## Rehearse supplied audio

```sh
npm run rehearse -- /path/to/synthetic-mic.wav --from 0:00 --minutes 1
npm run rehearse -- /path/to/synthetic-mic.wav --them /path/to/synthetic-call.wav --from 0:00 --minutes .5
npm run rehearse -- --open /path/to/REPO_NAME/prototype/artifacts/rehearsal/runs/RUN_FOLDER
```

The visible Chrome session plays an uncompressed PCM or IEEE-float WAV as its microphone in real time; a new recording is started deliberately by this command. Cloud models are off unless `--with-models` is supplied. Each run uses a free port and a separate store under `artifacts/rehearsal/runs/`, never the ordinary app database. Profiles and trimmed WAVs are removed on exit; run data is kept so it can be reopened. Symlinks and hard-linked run files are refused.

`rehearsal-check.ts <mic.wav> [them.wav]` is an optional longer integration check using a 10-minute input offset; provide synthetic WAVs long enough for that offset and the subsequent minute. It is not part of `npm test`.

## Main modules and limits

`src/store.ts` owns SQLite state and durable audio; `live.ts`/`drafts.ts` manage capture and previews; `recognizer.ts` isolates native speech recognition in a child process. Notes, actions, board, projects, memory, and plans live in the corresponding `src/` modules. `public/` contains the browser UI; `launcher/` contains the optional Swift helper.

Imports are limited to 256 MiB; queued audio to 1,000 chunks. Material search is bounded and reports unreadable sources. Speech recognition and AI can mishear names, notation, conditions, and assignments. Verify important decisions against the recording and source materials.
