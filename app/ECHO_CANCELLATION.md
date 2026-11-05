# Live acoustic echo cancellation

When a microphone and a live call (app or tab) record the same meeting, the
server uses the call audio as WebRTC AEC3's far-end reference. The microphone's
cleaned stream feeds **both grey previews and sealed recognition chunks**.
Microphone playback after sealing intentionally plays that cleaned audio. The
text echo rules remain a backup; AEC is not a guarantee of perfect recognition.
No UI preference and no capture-helper change are involved.

## Ownership and durability

- `LiveCapture.accept` still saves raw frames with `MeetingStore.addFrame` before
  any AEC work. Admission hashes, sequence checks, retry/dedup and durable frame
  files are unchanged. Only newly admitted frames enter AEC; a retry is never
  processed twice.
- `echo-audio.ts` owns bounded worker transport, deadlines and lifecycle. It starts
  one `worker_threads` worker per microphone recording when a timestamped live
  call reference exists. With no call (or legacy frames without wall timestamps),
  audio passes through synchronously, without a worker or added waiting.
- `echo-worker.ts` alone loads the production WASM. `echo-timeline.ts` owns the
  worker's reference timeline, 10 ms render/capture interleaving and adaptive
  state. AEC runs at 48 kHz internally, using the library's 16↔48 kHz resampling.
- `LiveCapture` retains cleaned frames only in memory until seal. Ordered ready
  frames feed the draft; replay after a pause cut also uses cleaned frames.
  `MeetingStore.sealWindow` accepts a same-length processed window, hashes/writes
  it using the existing atomic publication, then removes raw frame files as
  before. There is no additional durable audio tree or schema migration.

## Alignment and bounded fallback

Every frame's first sample is placed by its own `captureWallMs`, not meeting
start, receipt time, or the previous frame's duration. This corrects slow drift
at frame boundaries. Capture discontinuities split the PCM into wall-clock
spans; AEC history resets across significant capture-time jumps. Reference
storage is bounded by ten PCM frames, not wall duration, so an inside-frame sleep
does not evict that frame's pre-sleep audio. Small overlaps use the latest start.

The reference is shifted **earlier by 100 ms** by default. Set
`MEETING_AEC_REFERENCE_LEAD_MS` to a finite value from 0 to 300 to tune it; invalid
values use the default. Public AMI tests of 0/50/100/150 ms supported 100 ms: it
preserved aligned double-talk WER while tolerating reference timestamps 100 ms
late. This is not a fix for arbitrary drift/late delivery (500 ms is still outside
this chosen margin).

Capture waits until the aligned reference horizon covers its frame, for at most
**1500 ms from admission**. Uncovered 10 ms blocks pass through raw exactly,
rather than taking suppression output from a silent reference. A main-thread
**2000 ms watchdog** also covers worker startup, crashes, invalid output, backlog
and hangs. It resolves all pending frames raw, disables AEC for that microphone
recording, and logs once. A seal waits for its pending frame results within this
same bound; recording/transcription does not fail because AEC is unavailable.
The small filter/resampling latency (~10 ms) is not removed from the PCM clock.

Call ending flushes pending capture and stops its workers; subsequent microphone
frames have zero AEC waiting. Microphone end, meeting pruning and server close
also stop workers. References/history do not survive a server restart:
**recovered frames seal raw**, even if a newly resumed part of that recording
later has a fresh live canceller. A first mic frame arriving before any call
reference is known also passes through raw; text echo protection remains useful
at these edges.

## Packaging, license, and checks

`@ennuicastr/webrtcaec3.js` is an exact **0.3.0 production dependency**. The desktop
packager installs production dependencies and copies `src/` plus all root
`THIRD-PARTY-LICENSES/` notices into the app. It runs the shipped Node against
`src/echo-audio.ts --self-test` after signing: this test-only headless switch
starts a worker, loads the adjacent packaged `.wasm`, processes silence, reports
its in-bundle path, and exits. No server, Electron UI, audio device, playback,
process tap or network access is involved. The signature is verified again after
loading, ensuring no bundle writes were needed.

The dependency is dormant upstream (last release/commit January 2024) and has no
internal delay getter. Its notices include WebRTC BSD-3-Clause and patent grant,
Abseil Apache-2.0 with attribution NOTICE, and Emscripten/musl/glue permissions.
No internal delay estimate is claimed; the separate offline trial tool remains
available in `scripts/aec-trial.ts`.

`test/echo-audio.test.ts` exercises timing, drift, discontinuities, missing/late
reference, waiting, worker crash/hang, no-call and call-end passthrough, raw
persistence, retry dedup, cleaned sealing/replay, simultaneous Stop and recovery.
`script` checks run without personal recordings:

```sh
# PUBLIC_PAIRS is a previously generated public AMI trial directory; OUT must be new.
nice -n 19 env -u GEMINI_API_KEY -u OPENAI_API_KEY -u ANTHROPIC_API_KEY \
  MEETING_MODEL_PATH=/absolute/path/to/model.gguf \
  MEETING_TEST_CHROME=/absolute/path/to/disposable/chrome-headless-shell \
  node --experimental-strip-types scripts/aec-live-check.ts \
  --pairs "$PUBLIC_PAIRS" --out "$OUT"
```

This uses the rehearsal file-audio path, fresh server directories and ephemeral
ports. It runs raw/AEC pairs at 120 ms acoustic delay, a call joining after four
seconds (70 ms path), and call timestamps 100 ms late (30 ms path). It records
stored microphone finals separately from text-rule-filtered displayed finals,
grey-preview observations, AEC-added waiting and compute time. Stored final
segments are assigned to talk states by their start time; native word-list scores
are also retained because recovery can return text not fully represented by its
word list. These are synthetic paths and finite samples, not a universal WER or
hallucination guarantee.
