# Offline echo-cancellation trial

This documents the original offline experiment. Live product integration now
uses the same pinned package in a worker; see `../ECHO_CANCELLATION.md`. The trial
tool itself remains standalone, with no product integration. `aec-trial.ts` reads two **16 kHz mono little-endian
float32** recordings, writes a cleaned microphone file and diagnostics, and can
run the existing isolated speech worker on both versions. No upload, playback,
device access, server, or meeting database. Inputs are read-only.

## Run on two recordings

From `app/`, with dev dependencies installed (`npm ci`). Set `JOB` to an existing
scratch directory, and provide the actual meeting-clock start times:

```sh
nice -n 19 env -u GEMINI_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  MEETING_MODEL_PATH=/absolute/path/to/model.gguf \
  node --experimental-strip-types scripts/aec-trial.ts \
  --mic /absolute/path/to/microphone.f32 \
  --call /absolute/path/to/call.f32 \
  --mic-start-ms 1250 --call-start-ms 1000 \
  --out "$JOB/aec-output" --recognize --sweep
```

`--out` must **not exist**; its parent must already exist. Existing output files,
directories, and symlinks are rejected. All generated files are beneath this new
directory; input files are never rewritten. Input must be nonempty, whole-sample,
finite PCM in `[-1, 1]`. Processing is in memory; long recordings need substantial
RAM. The 8-hour input validation limit is not a memory-capacity promise.

- Omit `--recognize` for AEC only (no speech model needed).
- Recognition requires explicit `MEETING_MODEL_PATH`; it calls
  `discoverModel(explicitPath)`, never reads saved settings or searches caches.
  It uses `LocalRecognizer` / `stt-worker.ts`, the app's 20-second chunk size,
  recovery logic, and word timings, without the product's text echo rule.
- `--sweep` tries independent fresh AEC instances with extra **reference delays**
  of 0–300 ms in 20 ms steps. It reports energy for every candidate; it does not
  automatically select or replace the main output. Recognition is of the main
  `--extra-delay-ms` output only (default 0).
- Optional `--extra-delay-ms 60` explicitly delays the reference after start-time
  alignment. Excess delay can put the reference *after* the echo and break AEC.
- Optional `--echo-only 0:20,60:80` labels intervals **in seconds from the start of
  the microphone file**, not meeting time. Only label intervals known to contain
  no near-end speech. Without labels, ERLE is null rather than misleading.

Outputs:

- `cleaned.f32`: same sample count, sample rate and meeting-clock origin as mic.
  Resampling/filter latency is not compensated (about 10.4 ms in the AMI trial).
- `summary.json`: alignment, independent correlation delay, per-second power,
  dBFS and energy reduction, ERLE where labeled/measurable, AEC real-time factor,
  and optional sweep. Power reduction during double talk is **not** ERLE.
- `original-transcript.json`, `cleaned-transcript.json` with `--recognize`:
  complete text, meeting-clock word `startMs` / `endMs`, and worker metrics.
  Texts and word times are also printed. `runtime/` holds worker temporary files.

### Delay limitation

The pinned bindings expose `setAudioBufferDelay`, **not a delay getter or AEC3
metrics**. `aec3EstimatedDelayMs` is consequently null; no internal estimator
measurement is fabricated. `diagnosticDelay` is separately labeled waveform
cross-correlation (first 30 seconds, 1 kHz, ±1000 ms), with null below 0.1
correlation. Positive lag means mic echo trails the aligned reference. This is
not used to realign automatically and may be unreliable during near-end speech.

## Reproduce the public benchmark

```sh
nice -n 19 env -u GEMINI_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  MEETING_MODEL_PATH=/absolute/path/to/model.gguf \
  node --experimental-strip-types scripts/bench/aec-run.ts \
  --corpus /absolute/path/to/read-only/bench --out "$JOB/ami-aec"
```

Use the existing AMI bench layout, annotations and headset files. The runner
uses `bench/ami.ts`, `bench/ihm.ts` (official speaker/channel mapping) and
`bench/wer.ts`. It runs six 120-second pairs sequentially: five distinct headset
speaker pairs from different meetings, plus the first pair with a +500 ms
reference timestamp error. `--signal-only` omits recognition.

Each pair has 40 seconds each of scheduled far-only, near-only and double-talk
blocks. Complete 1–13 second AMI utterances are packed with natural internal
pauses, 350 ms gaps and 10 ms edge fades. Double-talk blocks contain both voices,
not continuous overlap at every sample. The room path has a 30–120 ms direct
delay, reflections at +12/+31/+59 ms, a 3 kHz low-pass, echo power −6…−12 dB
relative to near-end power, and deterministic light noise. Common peak attenuation
prevents clipping without changing relative levels. Headsets can retain corpus
crosstalk; different meetings prevent the two sources sharing the same bleed.

The reference file starts one second before mic. Pair 6 changes only its
reported timestamp by +500 ms (a fixed misalignment stress test, not a simulation
of continuously varying sample-clock drift). The extra-delay sweep cannot fix a
reference already 500 ms late without buffering/re-timestamping.

Scoring uses complete, state-aligned 20-second worker chunks, preserving word
errors/insertions and avoiding arbitrary word-boundary assignment. Far-only
leakage counts **all normalized output words**, including hallucinations; matched
far-reference words are also recorded. Benchmark `sweep-best` is an **oracle
selection using known echo-only energy**, not a deployable automatic selector or
a selection on WER. Every sweep setting's signal metrics are retained.

## Observed result (public AMI, Apple M2)

Using Parakeet unified English 0.6b Q8_0, `transcribe-cpp` 0.3.1:

| Five aligned pairs combined | Original | AEC3 | Oracle sweep-best |
| --- | ---: | ---: | ---: |
| Double-talk near-end WER (452 words) | 39.2% | 19.2% | 16.6% |
| Far-only output words | 384 | 8 | 0 |
| Near-only WER (425 words) | 9.4% | 9.4% | 9.4% |

**Verdict: neither for unconditional product adoption yet.** AEC3 is the promising
next trial candidate: it restores many near-end words and suppresses echo cheaply
(~0.0225 wall-time RTF). However one pair's near-only WER worsened from 7.4% to
10.3% (5 to 7 errors / 68 words), and the late-reference pair barely improved
(74.5% → 71.7% double-talk WER, 79 → 78 far-only words). Aggregate parity does
not satisfy a per-pair non-regression gate. SpeexDSP was not tried: the specified
fallback condition (AEC3 cannot run in Node) did not occur. No claim is made about
the user's recording or real speaker/microphone paths.

## Dependency assessment

Exact dependency (originally trial-only devDependency, now a production dependency
for live AEC): `@ennuicastr/webrtcaec3.js` **0.3.0**, published 2024-01-02,
well over two weeks before this trial. It loads packaged WASM directly in Node
22.22.2; no native compilation or network fetch is needed at runtime. AEC runs
synchronously in interleaved 10 ms render/capture frames, at 48 kHz internally
with the package's 16↔48 kHz resampling.

The repository is MIT. The package's WebRTC BSD-3-Clause, glue ISC/0-clause-style
permission, Abseil Apache-2.0, and Emscripten/musl MIT-style notices are compatible
with distribution alongside MIT code; retain the complete bundled `license.js`
and applicable Apache license/notice obligations if adopted/shipped. This trial
does not vendor or redistribute compiled artifacts.

Maintenance risk: npm's latest release and the upstream repository's latest
commit were both January 2024 (upstream commit
`e1d663e86f2ab03269b9ae873af38d0103c4df3d`). The package is dormant, has no real
npm test suite, and omits internal delay/quality telemetry. Pinning is appropriate
for this reproducible experiment, not an endorsement of long-term maintenance.

Focused tests: `test/aec-trial.test.ts` covers alignment, ERLE labeling, raw PCM
validation, output collision/symlink protection, delay diagnostic signs, real
WASM partial frames/free/recreate, and explicit-model requirements.
