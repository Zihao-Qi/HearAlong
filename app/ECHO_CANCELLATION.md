# Live acoustic echo cancellation

When a microphone and a live call (app or tab) record the same meeting, the
server uses the call audio as WebRTC AEC3's far-end reference. The microphone's
cleaned stream feeds **both grey previews and sealed recognition chunks**.
Microphone playback after sealing intentionally plays that cleaned audio. The
text echo rules remain a backup; AEC is not a guarantee of perfect recognition.
No UI preference is involved. Native capture changes only improve timestamp metadata.

## Ownership and durability

- `LiveCapture.accept` still saves raw frames with `MeetingStore.addFrame` before
  any AEC work. Admission hashes, sequence checks, retry/dedup and durable frame
  files are unchanged. Only newly admitted frames enter AEC; a retry is never
  processed twice.
- `echo-audio.ts` owns bounded worker transport, deadlines and lifecycle. It starts
  one `worker_threads` worker per microphone recording when a timestamped live
  call reference exists. With no call (or legacy frames without wall timestamps),
  audio passes through synchronously, without a worker or added waiting.
- `echo-worker.ts` alone loads the production WASM. `echo-scheduler.ts` owns
  incremental reference waiting and explicit tail-flush scheduling; its explicit
  clock is also used by the long-call simulation. `echo-timeline.ts` owns the
  reference timeline, 10 ms render/capture interleaving and aligned sample routing. AEC runs at 48 kHz internally, using the library's 16↔48 kHz resampling.
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
does not evict that frame's pre-sleep audio. Small overlaps use the latest start. Confirmed reference gaps up to 5 ms hold
that boundary sample; unknown/larger gaps remain missing. Partial 10 ms blocks
carry across contiguous spans/frames rather than inserting padding.

The reference is shifted **earlier by 100 ms** by default. Set
`MEETING_AEC_REFERENCE_LEAD_MS` to a finite value from 0 to 300 to tune it; invalid
values use the default. Public AMI tests of 0/50/100/150 ms supported 100 ms: it
preserved aligned double-talk WER while tolerating reference timestamps 100 ms
late. This is not a fix for arbitrary drift/late delivery (500 ms is still outside
this chosen margin).

Capture processes only the arrived reference prefix, waiting at most **1500 ms
from admission**, including the short output lookahead. Uncovered input spans
pass through raw rather than taking suppression output from a silent reference.
The kernel's impulse latency is measured (165 samples in the pinned build) and
removed from its output position. Output waits for the corresponding input sample;
Stop/checkpoint/reset flush enough trailing input to recover the complete tail.
Cleaned/raw switches crossfade same-position values over at most 80 samples (5 ms),
never copying/replaying old microphone samples. A timeout/checkpoint fades its
unemitted tail to raw before publication, so a later missing-reference span cannot
introduce an edge after the previous frame has already escaped. The split/merge FIR still colors
the waveform; phase coloration is not a missing/repeated frame or sample shift.

A main-thread **2000 ms watchdog** covers worker startup, crashes, invalid output,
backlog and hangs. All fallback is **literal raw PCM** for every unemitted sample:
no prior correction, held sample, delta ramp or synthesized transition is added.
A failure-point discontinuity is preferable to injected audio. It disables a genuinely failed
worker for the recording, and logs once. A watchdog serviced over 3 s late after
whole-process sleep instead permits a fresh worker on resumed capture. A forced
seal signals flush BEFORE waiting for its pending frame results. Stop sends an
immediate checkpoint outside the per-source queue, so a normal seal already
waiting on that queue cannot delay the signal. Validation/end-state changes stay
serialized on the source chain. Recording never
depends on AEC succeeding.

A reference with no new frame for more than 3 s or an end more than 5 s behind the
mic is inactive: no reference wait, one reason log, raw until fresh timed frames
resume. Losing reference wall-clock metadata also retires it. More than 10 total
seconds of live-call missing-reference fallback logs once (shared with the failure
log budget), instead of silently remaining ineffective.

The first live remote is pinned; other remotes are bounded standby histories,
not render input. Ending a non-pinned remote never retires the mic. When the pin
ends, its spans remain available for the mic's final second without waiting for
future render; after the mic crosses that end, a live standby can take over with
a reset **in the existing worker**, before retirement is considered. A fully
covered last frame flushes its latency tail as soon as reference is ended. Ended
render history is retained for up to 10 s even before the first mic upload, to
support a delayed overlapping mic frame; crossing its end and retiring the final
session frees it immediately. Raw frames never await retirement, and no per-mic
retirement promise is retained. Global flush/close awaits the bounded retirement
set. Mic Stop, close, abandonment and inactive-end flush before sealing.
Microphone end, meeting pruning and server close stop owned workers. References/history do not survive a server restart:
**recovered frames seal raw**, even if a newly resumed part of that recording
later has a fresh live canceller. A first mic frame arriving before any call
reference is known also passes through raw; text echo protection remains useful
at these edges.

## Native and page clocks

The page clock slews accumulated drift only at frame boundaries, at <=2 ms per
second of captured audio. A pause or UTC adjustment between consecutive render
quanta can step in either direction; crossing 100 ms of cumulative drift does not.
Every in-frame step exceeding the 2 ms slew bound records its sample offset,
including 100 ms–5 s pauses. Post-cut spans anchor at the cut's absolute `toWallMs`,
not an approximate sum. Only positive gaps **>5 s** are user-visible; short/signed
steps only correct alignment and effective frame ends.

The native tap retains each callback's host timestamp plus absolute/continuous
clock observations in its preallocated banks. On the framing thread, a bounded
epoch history is recalibrated against UTC once per second. Timestamp lookup uses
the input's capture epoch, so a pre-sleep callback delivered after wake does not
inherit wake's sleep offset or a newer wall-clock correction. Clock bookkeeping
and UTC reads never run in IO. Timestamp spans survive converter priming and
framing. `X-Capture-Wall-Ms` is the actual frame placement, all interior clock
steps exceeding the slew bound use `X-Capture-Discontinuities`, and
`X-Start-Ms` remains the original compact sample clock. Fake-only Swift checks
exercise this without a real process tap.

## Packaging, license, and checks

`@ennuicastr/webrtcaec3.js` is an exact **0.3.0 production dependency**. The desktop
packager installs production dependencies and copies `src/` plus all root
`THIRD-PARTY-LICENSES/` notices into the app. It runs the shipped Node against
`src/echo-audio.ts --self-test` after signing: this test-only headless switch
starts a worker, loads the adjacent packaged `.wasm`, processes a terminal impulse in otherwise silent audio, verifies its flushed
tail and measured processing delay, reports its in-bundle path, and exits. No server, Electron UI, audio device, playback,
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

`test/echo-review.test.ts` covers each review regression with boundary impulses,
a measured-delay identity kernel, actual WASM tail/peak checks and worker/Stop
ordering. `test/echo-long-call.test.ts` runs two-hour simulations in both +/-200 ppm
directions through the production scheduler, requiring bit-exact sample identity,
bounded waiting/storage, a 10 s sleep, a +30 s wall-clock step, a pre-sleep reference
callback delivered after wake, and call leave/rejoin. `test/echo-review2.test.ts`
covers literal-raw failure, no-wait ended reference (including the first mic
frame), standby handoff, retirement collection, Stop behind a waiting seal and
short/signed clock-cut placement. The separate
`scripts/aec-long-check.ts --out NEW_DIR` runs 7200 synthetic seconds through
actual WASM, checking marker survival, alignment, waiting and memory without any
speech model, devices or network.
