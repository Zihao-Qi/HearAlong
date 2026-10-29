# HearAlong: setup and details

Local speech recognition, selectable transcript text, draft notes, a live board, project memory, and evidence-linked plans. The supported desktop workflow is macOS with Google Chrome. Fixtures are fictional; recordings, personal materials, model weights, runtime databases, and saved AI sessions are not distributed.

## Setup and start

For the one-command release installer, upgrades and uninstall instructions, see [Getting started](../README.md#getting-started). Installed releases keep code in `~/Library/Application Support/HearAlong/app/`, data in the separate `~/Library/Application Support/HearAlong/data/`, and the helper in `~/Applications/`. The following instructions run from a source checkout.

Requirements:
- Node.js ≥ 22.19.0 and npm.
- Google Chrome for the app. Browser checks and rehearsals require `MEETING_TEST_CHROME` pointing to a disposable Chromium executable; they never default to the user's browser.
- FFmpeg and ffprobe on PATH for audio import and recognition.
- A compatible speech model for `transcribe-cpp`; the setup page finds installed models or downloads Parakeet.
- Optional AI: Ollama or LM Studio on this Mac, or explicit consent to cloud models through Pi. A pinned Pi is included and always used for tool-using tasks; metadata/no-tools commands may still use Pi on PATH. Accounts and enabled user extensions retain their existing agent-directory configuration. Calculations run JavaScript on HearAlong's bundled Node with bundled mathjs; nothing is installed or downloaded for them. Web lookup needs Pi's `pi-web-access` package enabled.

```sh
git clone https://github.com/Zihao-Qi/HearAlong.git
cd HearAlong/app
npm ci --ignore-scripts
npm start
```

The setup page finds or downloads a speech model, checks FFmpeg, and offers optional AI and microphone setup.

Open **http://127.0.0.1:4318** (not `localhost`: the server validates host and origin). Starting the server does not start recording. Use the microphone button only with everyone's consent; Ctrl+C stops the server. The root-level `Start HearAlong.command` starts the same server and opens Chrome; set `MEETING_CLOUD=0` in its environment to force AI Off for that start.

If a speech model or FFmpeg goes missing later, existing meetings remain readable; use Settings › This Mac › Setup to restore speech. Advanced options: `MEETING_MODEL_PATH=/path/to/model.gguf` overrides the saved speech choice; Pi Voice settings are also discovered read-only. The unit tests and `app-check` below need neither speech weights nor a cloud account.

## Use

- Create a meeting, start the microphone, or replay a recording you supply. Call-audio capture uses Chrome's share-audio controls when available. Me/Them labels identify capture channels, not individual people.
- Attach project materials by path. The app reads them for glossary generation, answers, and plans; attach only material you intend to share with the configured AI provider.
- Select transcript text for explanation, lookup, calculation, or another question. Evidence checks verify that quotes occur in supplied sources, not that the underlying claims are true.
- Review draft notes, board cards, project-memory changes, and plans before relying on them. Plans can add steps to project to-dos.
- Export corrected or raw transcript Markdown. Settings control model choices, mini-window behavior, and audio retention.

## Privacy and optional AI

Choose **On this Mac**, **Cloud** or **Off** in Settings › AI (also in Setup). Main and Quick choices are saved separately for local and cloud AI. Audio and speech recognition always stay local.

- **On this Mac:** a bundled Pi extension discovers Ollama (`127.0.0.1:11434`) and LM Studio (`127.0.0.1:1234`). No model client is added to the server. Transcript text, materials, memory and tool results stay on this Mac. Pi runs offline, without user extensions, skills or provider keys in its environment, using an app-owned agent directory rather than user endpoint overrides or credential commands. Web lookups are unavailable. While any recording is in progress, the Board and glossary corrections wait; other AI jobs remain available. Discovery and both inference methods use direct, loopback-only transport, without environment proxies or redirects. Notes and inference check the model's measured loaded context, not its trained maximum; an unloaded model gets a one-word, one-token local warm-up before measurement, never meeting text. The suggested Ollama model is `qwen3.5:4b` (about 4 GB); set its context length to 32k in Ollama's settings so a long meeting fits. Cold loading may take up to five minutes. Unknown loaded context gives configuration guidance; failed loading names the model and server, and over-limit input is refused rather than sliced. Local model work uses one shared lane (including sequential notes parts); cloud notes stay parallel. Every local stage keeps thinking off by default, using the existing output allowance. Cold runs on `qwen3.5:4b` found thinking slower and less reliable for notes. The notes-only opt-in remains: up to 16384 output tokens after reserving input and a 512-token margin, falling back to thinking off below 6144 available tokens. LM Studio is unchanged. Each notes part retains its 600-second limit after lane admission. See [context admission and verification limits](../docs/local-ai-context.md). Plans and tool-using actions need a tool-capable model.
- **Cloud:** after explicit consent to the chosen provider set, glossary correction sends glossary terms and recent final lines. Board scans send title, glossary, open cards, memory and recent speech. Notes send the entire final transcript (corrected and as heard). Actions send selected lines, nearby transcript, materials read by tools and a read-only memory snapshot; Compute sends locally generated JavaScript output. Glossary builds send attached materials as read. Memory work sends memory items, cited meeting outcomes, memory-file additions and recent commit subjects/paths. Plans send notes, their cited transcript lines, memory and materials read by tools. Web queries and addresses go to Pi's web services; fetched page text goes to the model. Pi may refresh its model catalog and provider credentials, and user-enabled extensions may contact external services.
- **Off:** no AI jobs or model calls. Recording, transcription, listening and exports work as usual. `MEETING_CLOUD=0` forces Off for this start without replacing a saved mode. Metadata discovery is performed during initial setup or when explicitly choosing/rechecking a model mode, not as an AI job.

New installs start with local models if available, otherwise Off; cloud is never silently selected. An existing install that finished setup and still lists cloud models keeps cloud access with legacy consent and a one-time Change…/Keep cloud notice. New providers require fresh consent; changes to the consented provider set cancel all active/warm cloud work. Recording pauses preserve Board/correction pending work without consuming failure retries. Pi telemetry and its version check are disabled in all modes; Pi makes no automatic internet requests in local mode. Speech/local-model downloads are separate setup operations; calculations need no additional installation or downloads. Calculations run JavaScript in a network-blocked task sandbox. The [architecture data table](../docs/architecture.md#what-each-feature-sends) gives precise feature bounds.

### AI file and calculation boundary

In either AI mode, file tools read only the task's current attached meeting/project materials, any supplied read-only memory snapshot, and its scratch folder. A linked repository is readable only when also attached as material. Action snapshots can include project brief/history and saved notes from other meetings in the same project. Detaching a material removes it from later follow-up/retry launches. Materials are read-only; edits and outputs belong in scratch. Realpath checks prevent symlink escapes; file tools refuse regular files with multiple hard links under every root, and calculation code cannot create symlinks or hard links. Hidden/credential components, Pi sign-ins, Keychains and other HearAlong data are excluded even beneath broad attachments. Recursive searches refuse trees containing excluded/sensitive descendants, symlinks, unreadable directories, or more than 20,000 entries: search a smaller permitted folder or read a permitted file. Search tools may consult ignore files outside the allowed folders (such as `.gitignore` and the global Git ignore list) to decide what to skip; their contents are not shown to the AI. Web tools require HTTP(S) URLs and reject direct localhost, loopback, unspecified, private and link-local destinations, including alternate IP spellings. A public-looking hostname can still resolve to a private address (DNS rebinding); the hook does not resolve DNS. Local-file fetches are blocked, and web tools' cloned repositories are not readable unless attached. Calculation roots whose real paths contain a quote, backslash or newline must be renamed or detached; ordinary file-tool attachment remains available.

Tool tasks use bundled Pi with an explicit tool list and ignore project-local Pi resources regardless of inherited trust. JavaScript calculation calls run sequentially in fresh Node processes and cannot start programs or workers, with no networking (including Unix sockets), and no clipboard, Spotlight, preferences, AppleEvents, Keychain or Pi-sign-in access, and no permission to signal other processes. Calculations have a dedicated Seatbelt profile with no read access to task scratch, materials, memory snapshots or home contents, except explicitly selected installed runtime files; no file writes are allowed except `/dev/null`. Only Node, its shared libraries, startup system locations, the runner and maths dependencies are readable. The legacy task profile retains extra read-only system locations `/opt/homebrew/Cellar`, `/private/etc` and `/dev`; calculation code gets no general allowance for those locations. The sandbox still allows other macOS system services by default apart from the named restrictions on clipboard, Spotlight, preferences, AppleEvents and Security. The sandbox is not around Pi itself: trusted user extensions retain account permissions, and a later extension hook can rewrite approved arguments. Enable only extensions you trust. In Cloud mode, file-tool results and JavaScript output can be sent to the consented provider.

Calculations use the bundled maths library without installation or downloads. Node's permission model additionally restricts filesystem APIs to runner/library reads, but native APIs such as Node 22 SQLite are confined by Seatbelt too. Node 22 permissions do not control networking: Seatbelt is the network and cross-process signal boundary. Read task materials through Pi's file tools, not calculation code. Child processes, workers, native addons, WASI and inspector access are disabled. Numbers are IEEE doubles unless using mathjs BigNumber or fractions. The child environment is allowlisted to `LANG`, `LC_*` and `TZ` only. V8 old space is capped at 256 MB; a parent-side watchdog samples resident memory against 512 MB, including Buffer/ArrayBuffer storage. The watchdog is not a hard allocation quota. File metadata outside the data folder can remain visible. This is not an OS container.

When listed, cloud defaults remain `openai-codex/gpt-6.1-sol` (Main/correction) and `openai-codex/gpt-6-luna` (Quick), but do not authorize cloud use on their own. Advanced overrides `MEETING_HEAVY_MODEL`, `MEETING_CORRECTION_MODEL`, `MEETING_QUICK_MODEL`, `PLAN_MODEL` and `EXPLORE_MODEL` cannot bypass the active mode or cloud consent.

Runtime data lives in `data/`, or `MEETING_DATA_DIR`: SQLite records, audio, imports, notes, project memory, tool scratch files, and AI session logs. These can contain sensitive content and are Git-ignored. Audio retention defaults to one day after completed processing; settings also offer a week, a month, or always. Transcripts and notes are retained. Do not publish runtime folders or logs.

Quote checks are counted locally in `data/metrics/quote-checks.json`: per feature (board, notes, plans, actions), model id and ISO week, how many model claims passed the evidence check and how many failed, by a fixed list of reasons (such as `quote_not_found` or `no_citation`). The file holds counts only, never quotes, text, meeting ids, paths or times finer than a week, and it never leaves the Mac. `node --experimental-strip-types scripts/quote-metrics.ts [file or data folder] [--json]` prints the share that failed per feature and model; it only reads.

## Public repository guard

Run `npm run guard:install` from `app/` to set the absolute main-tree `.githooks` path for every worktree, including older revisions (requires Git and Node.js).
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

Calculation regressions run offline with `node --experimental-strip-types --import ./scripts/check-isolation.ts --test test/calculate.test.ts test/calculate-split.test.ts`. The mathjs-specific check skips explicitly until the pinned dependency has been installed as part of app packaging; other calculation checks need no additional packages.

The optional `scripts/build-app.sh` builds and registers the local macOS helper; it records your local executable paths in its generated bundle. Generated bundles belong in ignored `dist/` and must not be published as source. A browser-only start does not require the helper. The installer uses `sh scripts/build-app.sh --install OUTPUT_DIR DATA_DIR APP_ROOT` to build against the stable installed code path with a separate `MEETING_DATA_DIR`. `HEARALONG_TEST_MODE=1` enables test-only overrides for the installer: `HEARALONG_NO_REGISTER=1` disables LaunchServices registration and is mandatory in tests; `HEARALONG_LSREGISTER` can point to a fail-closed registration stub; and `HEARALONG_RELEASE_URL` can point to a release asset directory (allowing `file://` fixtures; non-test runs refuse non-`https` URLs and ignore these overrides). `HEARALONG_CHROME_APP` points to a disposable Chrome stand-in. They stub Homebrew, npm, Swift and macOS integration; no real install runs in the suite.

## Rehearse supplied audio

```sh
npm run rehearse -- /path/to/synthetic-mic.wav --from 0:00 --minutes 1
npm run rehearse -- /path/to/synthetic-mic.wav --them /path/to/synthetic-call.wav --from 0:00 --minutes .5
npm run rehearse -- --open /path/to/REPO_NAME/app/artifacts/rehearsal/runs/RUN_FOLDER
```

The visible Chrome session plays an uncompressed PCM or IEEE-float WAV as its microphone in real time; a new recording is started deliberately by this command. Cloud models are off unless `--with-models` is supplied. Each run uses a free port and a separate store under `artifacts/rehearsal/runs/`, never the ordinary app database. Profiles and trimmed WAVs are removed on exit; run data is kept so it can be reopened. Symlinks and hard-linked run files are refused.

`rehearsal-check.ts <mic.wav> [them.wav]` is an optional longer integration check using a 10-minute input offset; provide synthetic WAVs long enough for that offset and the subsequent minute. It is not part of `npm test`.

## Main modules and limits

`src/store.ts` owns SQLite state and durable audio; `live.ts`/`drafts.ts` manage capture and previews; `recognizer.ts` isolates native speech recognition in a child process. Notes, actions, board, projects, memory, and plans live in the corresponding `src/` modules. `public/` contains the browser UI; `launcher/` contains the optional Swift helper.

Imports are limited to 256 MiB; queued audio to 1,000 chunks. Material search is bounded and reports unreadable sources. Speech recognition and AI can mishear names, notation, conditions, and assignments. Verify important decisions against the recording and source materials.
