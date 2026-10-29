<img src="app/public/icons/icon-192.png" width="96" alt="HearAlong app icon">

# HearAlong

[![CI](https://github.com/Zihao-Qi/HearAlong/actions/workflows/ci.yml/badge.svg)](https://github.com/Zihao-Qi/HearAlong/actions/workflows/ci.yml)

**A private, on-device Mac assistant that listens alongside you in meetings and talks, and turns them into a live transcript, explanations and next steps.**

Speech recognition runs entirely on your Mac. You follow the conversation as it happens, select any line to have it explained, and get notes and evidence-backed next-step plans afterwards. The design is calm and focused, made for someone who mostly listens.

![HearAlong: the transcript beside the meeting's notes](docs/screenshots/notes.png)

*The transcript, with notes linked to the moment each point was said. Every example in this repository is fictional.*

---

## What it does

- **A live transcript, on device.** Room microphone or meeting-tab audio is transcribed locally with NVIDIA's Parakeet model (via `transcribe-cpp`). Grey preview text appears within about 2–3 seconds and turns into final text in place, so no word ever blanks out or appears twice.
- **Select a line, understand it.** Explain, Answer, look up or calculate from any transcript line, with sources: your project materials (PDFs and files), the web, and the conversation itself.
- **A board during the meeting.** Short cards with the key points, questions and decisions, as they come up.
- **Notes and plans after it.** Structured notes, then a plan for each open question. Every claim quotes the transcript, and each quote is checked against the exact text the agent read.
- **Project memory.** What was decided carries over to the next meeting of the same project, with a change history and Undo.
- **A floating mini window.** The newest lines and Stop stay above every app, including full-screen calls. It is a native macOS panel, drawn by a small Swift helper.

![Plans: an answer or the next step for each open question](docs/screenshots/plans.png)

*Plans after the meeting: an answer where the sources settle it, otherwise the next step, each one checked against the transcript.*

## Engineering highlights

- **Audio that is never lost.** Audio is saved in one-second frames before it is acknowledged. Recording survives a server restart, and a closed laptop lid shows up as a marked gap ("Not recorded for 8 minutes … the Mac was asleep"), measured from capture time rather than upload time.
- **A preview that never flickers.** The live text is composed by time from three layers: final, live and pending. Each stretch of audio is drawn from exactly one layer, so the handoff to final text is a single, flicker-free DOM update. Scrolling never moves text while you are selecting it.
- **Evidence-checked AI.** Notes, cards and plans must cite transcript lines. The server verifies each quote against what the agent actually saw, and plans are versioned so that a stale run can never overwrite a newer one.
- **Agents run as isolated processes.** The language-model agent ([Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) runs as separate processes, each in its own process group, with time limits, clean cancel and crash recovery. A crash or hang there can never stop a recording. The live board uses one warm process.
- **Decisions backed by experiments.** One example: sealing audio earlier would have cut the final-text delay from about 15 s to 6.5 s. An offline experiment on real recordings showed it made 2–8 percentage points more recognition errors and lost some technical terms, so it was not shipped.
- **Tested like a product.** 978 unit and integration tests, plus browser checks in headless Chrome: layouts at 11 window sizes, the mini window, the plans view, and an end-to-end smoke test with scripted speech recognition. Real local recognition is checked separately by `npm run smoke:stt`. A *rehearsal* tool replays a supplied recording as a live microphone.

How these work, with links to the code: [Architecture](docs/architecture.md).

## Engineering process

HearAlong is my project. I set its direction and requirements, made the product decisions and approved the major engineering ones, and tested it on real meetings and lectures. The code was written by AI agents, working within a process I set up and kept refining: written contracts, independent reviews and explicit acceptance checks.

| Role | Who | Responsibility |
|---|---|---|
| Owner and decision-maker | **Zihao Qi** | Product and requirements; product decisions and approval of major engineering ones; the working process and its rules; testing on real meetings and lectures |
| Architect and lead | Claude (Anthropic) | Architecture proposals, design notes, a written contract for each task, acceptance review |
| Implementer | GPT (OpenAI), via the Pi agent | Code and routine debugging, each task on its own Git branch |
| Reviewers | GPT and Gemini (Google), fresh sessions | Independent logic review of substantial changes; hands-on UI review in a real browser |

**Each substantial change follows the same loop:**
1. A design note, then a contract: what to build, the edge cases, the evidence required, and when to stop and ask.
2. Implementation on its own branch.
3. Independent review, followed by bounded fixes.
4. Acceptance: the risky code is read line by line, not just the reports, and then the full checks run.

**Review catches what tests miss.** An automated clean-up once rewrote a browser security header (`frame-ancestors` → `frame-channels`) together with its test, and every test still passed. It was caught at acceptance, by reading the diff.

## Getting started

### Install on your Mac

Requires macOS 26 or later, [Google Chrome](https://www.google.com/chrome/) and [Homebrew](https://brew.sh/) on PATH (including its Xcode command line tools). Apple Silicon is recommended; Intel works with slower, CPU-only transcription.

```sh
curl -fsSL https://github.com/Zihao-Qi/HearAlong/releases/latest/download/install.sh | sh
```

The installer verifies the release checksum, installs Node.js ≥ 22.19 (`node@22`) and FFmpeg ≥ 4.4 with Homebrew only if needed, and installs pinned runtime packages with npm. It never installs Homebrew or Chrome, and never asks for administrator privileges. It builds and ad-hoc signs the helper locally with Apple's Swift tools; no Apple Developer account is needed.

- Code: `~/Library/Application Support/HearAlong/app/`
- Recordings, transcripts, settings and downloaded speech models: `~/Library/Application Support/HearAlong/data/`
- Launcher: `~/Applications/HearAlong Helper.app`

It opens HearAlong in Chrome. In Setup, download the 731 MB speech model (or choose one already on your Mac). You can install HearAlong as a Chrome web app for its own Dock icon. Re-run the same command to upgrade; quit HearAlong first and let its helper/server exit. Upgrades keep your data and replace code only after download, checksum verification, package installation and helper build succeed.

To uninstall, quit HearAlong, then run:

```sh
sh "$HOME/Library/Application Support/HearAlong/app/install.sh" --uninstall
```

This removes the code and helper, **not your data**. Delete `~/Library/Application Support/HearAlong/data/` yourself only if you no longer want your meetings or models. Homebrew, Node, FFmpeg, saved Keychain keys and any Chrome web app remain; remove those separately if desired.

### Run from source

Requirements: macOS, Google Chrome, Node.js 22.19 or later, and FFmpeg. AI features are optional: use Ollama or LM Studio on this Mac, or explicitly opt in to a cloud provider through Pi. Without them, recording and transcription still work fully on the Mac.

```sh
git clone https://github.com/Zihao-Qi/HearAlong.git
cd HearAlong/app
npm ci --ignore-scripts
npm start
```

The setup page finds or downloads a speech model, checks FFmpeg, and offers optional AI and microphone setup. Full settings and privacy details are in [app/README.md](app/README.md).

## Privacy

Audio and speech recognition stay on the Mac. Settings › AI offers three modes:

- **On this Mac:** Pi uses models served by Ollama or LM Studio on loopback. Transcript text, materials, memory and Python results stay local. Pi's automatic internet traffic and user extensions/skills are disabled. Discovery and inference use direct loopback transport, ignore proxy settings and refuse redirects; web lookups are unavailable. The Board and corrections wait until recording stops. The suggested Ollama model is `qwen3.5:4b` (about 4 GB); set Ollama's context length to 32k for long meetings. Local AI jobs run one at a time; cloud notes parts remain parallel. Every local stage keeps thinking off by default; the notes-only opt-in and context room rule remain available for future use. Cold runs on `qwen3.5:4b` found thinking slower and less reliable for notes. LM Studio is unchanged.
- **Cloud:** explicitly consent to the selected providers before AI can run. Corrections send glossary terms and recent final speech; Board scans also send title, open cards and project memory. Notes send the whole final transcript. Explain/actions send selected lines, nearby speech, materials read by tools and a memory snapshot; calculations send their local Python output. Glossary builds send attached materials as read. Memory updates send memory items, cited meeting outcomes, memory-file additions and recent commit subjects/paths. Plans send notes, cited transcript lines, memory and materials read by tools. Web queries/addresses go to search/page services, and page text goes to the model. Pi may refresh its model catalog and provider credentials; installed user extensions may contact their services.
- **Off:** no AI jobs or model calls; recording, transcription, listening and exports remain available. `MEETING_CLOUD=0` forces Off for that start.

New installs default to local AI if available, otherwise Off. Previously set-up installs with listed cloud models retain cloud access with a one-time notice offering a switch. Adding a new provider requires consent again; changing the consented provider set cancels old cloud work. Pi telemetry and version checks are disabled in every mode. See [the per-feature data table](docs/architecture.md#what-each-feature-sends) for bounds and details. Speech and local-AI-model downloads are separate setup operations; calculation-capable jobs can prepare their managed Python dependencies on first use, as described below.

In both AI modes, AI file tools read only the task's currently attached meeting/project materials (a linked repo must also be attached), its supplied read-only memory snapshot, and its own scratch folder. Snapshot memory can include the project brief/history and other project meetings' saved notes. Materials are read-only; edits and outputs belong in scratch. Symlinks do not expand access, file tools refuse regular files with multiple hard links under every root, and generated Python cannot create symlinks or hard links. Hidden/credential paths, Pi sign-ins, Keychains and other HearAlong data remain excluded even inside a broader attached folder. Recursive searches refuse folders containing excluded/sensitive descendants (or more than 20,000 entries); search a smaller permitted folder or read a permitted file. Search tools may consult outside ignore files, such as `.gitignore` or the global Git ignore list, only to decide what to skip; their contents are not shown to the AI. Web tools accept HTTP(S) addresses but reject direct localhost, loopback, unspecified, private and link-local destinations, including alternate IP spellings. A public-looking hostname can still resolve to a private address (DNS rebinding); the hook does not resolve DNS. Local-file web fetches stay blocked; repositories cloned by web tools are not readable by file tools unless attached.

Tool-using tasks use bundled Pi and ignore project-local Pi resources, including those under a trusted parent. Generated Python runs sequentially, without network, clipboard, Spotlight, preferences, AppleEvents or permission to signal other processes; executable and file access is restricted to its scratch/material scope and allowed system/runtime locations. Extra read-only system locations include `/opt/homebrew/Cellar`, `/private/etc` and `/dev` (with `/dev/null` writable). The sandbox still allows other macOS system services by default apart from the named restrictions on clipboard, Spotlight, preferences, AppleEvents and Security. Calculations use an app-owned uv cache and managed Python under the data folder, not the user's uv cache or system Python. The first Compute, Plan or Explore run may download managed CPython 3.12 from uv's GitHub `python-build-standalone` releases and pinned numpy/scipy/sympy packages from the configured package index (PyPI by default), before calculation time starts. A small local process supervisor is compiled on first use, requiring Apple's Command Line Tools. Later calculations run offline. Generated code can in rare cases leave a background process running after a task; it cannot read file contents or extended attributes outside its allowed folders, use the network, or create links, but it can still see file names and sizes outside the data folder.

This is a tool boundary, not an OS sandbox around Pi itself. Trusted user extensions still run with the account's permissions; a later extension hook can change approved arguments, so enable only extensions you trust. In Cloud mode, file-tool results and Python output can go to the selected provider.

Runtime data (recordings, transcripts, notes and AI session logs) is kept locally and is never part of this repository. All examples and test data here are fictional.

## Roadmap

- A faster live view: pushed updates instead of polling.
- Lecture mode: slides beside the transcript, explanations grounded in the lecture.

## Tech stack

TypeScript on Node.js (server), plain JavaScript (UI), SQLite, Swift (macOS helper and native mini window), `transcribe-cpp` with NVIDIA Parakeet (speech recognition), the Pi agent (language models), Playwright (browser checks).

## License

MIT, see [LICENSE](LICENSE). Vendored libraries keep their own licenses: see [app/public/vendor/README.md](app/public/vendor/README.md) and [THIRD-PARTY-LICENSES/](THIRD-PARTY-LICENSES/).

---

Built by Zihao Qi with AI coding agents; see [Engineering process](#engineering-process).
