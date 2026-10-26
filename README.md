<img src="prototype/public/icons/icon-192.png" width="96" alt="HearAlong app icon">

# HearAlong

[![CI](https://github.com/Zihao-Qi/HearAlong/actions/workflows/ci.yml/badge.svg)](https://github.com/Zihao-Qi/HearAlong/actions/workflows/ci.yml)

**A private, on-device Mac assistant that listens alongside you in meetings and talks, and turns them into a live transcript, explanations and next steps.**

Speech recognition runs entirely on your Mac. You follow the conversation as it happens, select any line to have it explained, and get notes and evidence-backed next-step plans afterwards. The design is calm and focused, made for someone who mostly listens.

> Designed and directed by **Zihao Qi**, and built with a team of AI agents that he orchestrated (see [How it was built](#how-it-was-built)).

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
- **Tested like a product.** 390 unit and integration tests, plus browser checks in headless Chrome: layouts at 11 window sizes, the mini window, the plans view, an end-to-end smoke test with real local speech recognition, and a *rehearsal* tool that replays a recording as a live microphone.

How these work, with links to the code: [Architecture](docs/architecture.md).

## How it was built

HearAlong was built by one person directing a small team of AI agents, each with a clear role:

| Role | Who | Responsibility |
|---|---|---|
| Product owner | **Zihao Qi** | The product, the requirements and every decision; testing on real meetings and lectures |
| Architect and lead | Claude (Anthropic) | Architecture and design notes, a written contract for each task, acceptance and final quality judgement |
| Implementer | GPT (OpenAI), via the Pi agent | The code and routine debugging, each task on its own Git branch |
| Reviewers | GPT and Gemini (Google), fresh sessions | An independent logic review of every change; hands-on UI review in a real browser |

**Every change follows the same loop:**
1. A design note, then a contract: what to build, the edge cases, the evidence required, and when to stop and ask.
2. Implementation on its own branch.
3. Two independent reviews, followed by bounded fixes.
4. Acceptance: the risky code is read line by line, not just the reports, and then the full checks run.

**An example of the process at work:** an automated clean-up once rewrote a browser security header (`frame-ancestors` → `frame-channels`) together with its test. Every test still passed. The change was caught at acceptance, by reading the diff.

## Getting started

Requirements: macOS, Google Chrome, Node.js 22.19 or later, and FFmpeg. AI features are optional and need the Pi agent signed in to your own model subscription. Without them, recording and transcription still work fully on the Mac.

```sh
git clone https://github.com/Zihao-Qi/HearAlong.git
cd HearAlong/prototype
npm ci --ignore-scripts
npm start
```

The setup page finds or downloads a speech model, checks FFmpeg, and offers optional AI and microphone setup. Full settings and privacy details are in [prototype/README.md](prototype/README.md).

## Privacy

Audio and speech recognition never leave the Mac. AI features are optional: when they are on, selected transcript excerpts and project materials go to the model provider you sign in with. Runtime data (recordings, transcripts, notes) is kept locally and is never part of this repository. All examples and test data in this repository are fictional.

## Roadmap

- A faster live view: pushed updates instead of polling.
- Lecture mode: slides beside the transcript, explanations grounded in the lecture.

## Tech stack

TypeScript on Node.js (server), plain JavaScript (UI), SQLite, Swift (macOS helper and native mini window), `transcribe-cpp` with NVIDIA Parakeet (speech recognition), the Pi agent (language models), Playwright (browser checks).

## License

MIT, see [LICENSE](LICENSE). Vendored libraries keep their own licenses: see [prototype/public/vendor/README.md](prototype/public/vendor/README.md) and [THIRD-PARTY-LICENSES/](THIRD-PARTY-LICENSES/).
