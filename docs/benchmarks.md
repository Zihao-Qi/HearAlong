# Benchmarks

Public measurements of HearAlong's local transcription. The method below is written by hand. The results section is regenerated from the raw JSON by `npm run bench:report`; do not edit it by hand.

## Method

### Corpus

The set is the AMI Meeting Corpus, the official Full-corpus-ASR **SC** (unseen evaluation) meetings:

`ES2004a` `ES2004b` `ES2004c` `ES2004d` `IS1009a` `IS1009b` `IS1009c` `IS1009d` `TS3003a` `TS3003b` `TS3003c` `TS3003d` `EN2002a` `EN2002b` `EN2002c` `EN2002d`

Two microphone conditions, both 16 kHz mono 16-bit WAV:

- **Mix-Headset** — the close-talk headset mix.
- **Array1-01** — one far-field array microphone, the published channel closest to a person sitting in the room.

AMI Meeting Corpus, CC BY 4.0. Carletta et al., "The AMI Meeting Corpus", 2005. Licence: https://creativecommons.org/licenses/by/4.0/

Annotations: `https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip`

Audio: `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/<ID>/audio/<ID>.<Mix-Headset|Array1-01>.wav`

Files land in `app/artifacts/bench/ami/` (`download/`, `annotations/words/`, `audio/<ID>/`), which is git-ignored. Set `HEARALONG_BENCH_DIR` to replace `app/artifacts/bench` as the root (`$HEARALONG_BENCH_DIR/ami` and `$HEARALONG_BENCH_DIR/results`). SHA-256s are written to `ami/manifest.json`. A complete file, one whose hash is already recorded, is not downloaded again.

### Reference words

For each meeting, read `annotations/words/<ID>.<A-D>.words.xml` (NITE XML, ISO-8859-1 unless the declaration says UTF-8). The reference is every speaker's `<w>` element, ordered by start time, then speaker letter, then end time. Drop `punc="true"` tokens, `trunc="true"` (truncated) words, and every element that is not `<w>` (`vocalsound`, `disfmarker`, `gap`, and the rest). A time window is half-open on the AMI clock: keep a word whose start is `>= from` and `< to`.

### Custom-normalized WER

Accuracy is **custom-normalized WER**, not directly comparable to published Whisper/NIST scores. The policy below is custom, not a standard English equivalence normalizer; its implementation is identified by the recorded app commit.

WER = (substitutions + deletions + insertions) / N, where N is the number of reference words after normalization. A corpus figure sums the counts across sessions and divides once. It is not the mean of the per-session rates.

The same normalizer is applied to the reference and to the hypothesis:

1. Unicode NFKC, then lower case. Curly apostrophes (U+2018, U+2019, U+201A, U+201B, U+2032, U+2035, U+02BC) become `'`. Hyphens U+2010 and U+2011 become `-` (NFKC does not fold them).
2. `-` and `_` become a space, so `well-known`, `uh-huh`, and `uh_huh` split.
3. Other characters that are not a letter, digit, or word-internal apostrophe become a space. An apostrophe with a letter or digit on both sides stays (`don't`). Neighbors split rather than glue (`3.14` becomes two tokens, and so does `2,000`).
4. A token of only digits whose integer value is 0–9999 becomes English words with no "and" (`2` and `two` match, `101` is `one hundred one`, `0` is `zero`). Leading zeros use that integer (`007` is `seven`). A larger digit string stays as digits (`10000`).
5. Remove the fillers `uh`, `um`, `hmm`, `mm`, `mhm`, `ah`, `eh`, `oh`. After the hyphen split, the pairs `uh huh` and `mm hmm` are removed together, so `uh-huh` does not leave a `huh`. A lone `huh` stays.
6. Collapse whitespace.

Limits: ordinals (`2nd`) and decades (`1990s`) are not expanded; decimal and thousands punctuation splits numbers before expansion (`3.5` → `three five`, `2,000` → `two zero`). Years expand as cardinals, leading-zero sequences lose their zeros, and numbers above 9999 stay digits. British “and” and contraction variants are not equated. Filler removal is lossy (`oh no` matches `no`). Formatting differences can therefore count as recognition errors, and distinct utterances can normalize identically.

### File custom-normalized WER

`npm run bench:wer` transcribes each selected WAV with the same store, queue, and local recognizer as `scripts/transcribe-file.ts` (the original file is read in place). The hypothesis is the final segments' text, joined in time order. The reference is the whole meeting. Raw JSON is `app/artifacts/bench/results/wer-<timestamp>.json`: per-session counts, totals, requested sessions × mics, failed and unfinished chunk counts, wall time, and audio duration. Both runners record the selected model file's basename, SHA-256 and byte size (hashed once before measurement), git commit and dirty flag, Node version, macOS version, chip (`sysctl -n machdep.cpu.brand_string`), RAM (`hw.memsize`) and logical cores (`hw.logicalcpu`). The selected model path is fixed for the whole run. Dirty source is refused unless `--allow-dirty` is passed; that state is recorded and never pooled with clean runs.

Benchmark settlement waits for every chunk to become terminal, including scheduled automatic retries, with a 30-minute deadline after queueing the file (or stopping live capture). Exhausted failures, cancelled chunks, or unfinished chunks mark the run as an error, not a completed repetition. This is an opt-in benchmark path; `transcribe-file.ts`'s CLI output is unchanged.

### Preview lag and final lag

`npm run bench:live` plays one WAV excerpt in real time through the real page and server, using the rehearsal tool: a disposable headless Chromium (`MEETING_TEST_CHROME`), a temporary data folder under `app/artifacts/rehearsal/runs`, and an ephemeral port. It does not use the user's browser profile, the app's `data` folder, or port 4318.

The excerpt starts at `--from` (M:SS on the AMI clock) and lasts `--minutes` (default 10). The live reference is the same half-open window. The live custom-normalized WER compares the saved final transcript of that window with the AMI reference for the same window. A live run with no spoken-to-visible final samples is an error run.

The headline is spoken to visible. The report gives p50, p95, max, and the number of samples.

**When the audio was spoken.** The fake microphone plays the WAV in real time. Each PCM upload carries `X-Capture-Wall-Ms`, the wall time of that frame's first sample (`captureWallMs` in `public/pcm-worklet.js`, sent by `public/app.js`). `X-Start-Ms` is that sample's meeting time. A later position in the frame was spoken at `captureWallMs + (meetingMs - startMs)`, the sample offset the worklet already adds (`index * 1000 / sampleRate`). `spokenAt` in `scripts/bench/snapshot.ts` applies that sum. A position on a boundary between two frames uses the later frame. A position more than 1 ms past every frame, or in a gap between frames, is left unmapped, and that sight is left out of the lag. The unit test in `test/bench.test.ts` checks a fictional frame: the first sample, a sample 500 ms in, the frame's end, the next frame, the 1 ms rounding slack, a gap, and a missing, zero, or non-numeric capture header. That test is the check of the mapping. A discontinuity listed inside a frame stays linear; this rehearsal plays the file straight through.

**When the text is visible.** Before navigation, the harness installs a `MutationObserver` in the page. It reads `#transcript .para[data-kind="active"] .preview-text` for the grey draft and each `#transcript .para[data-kind="final"] span[data-id]` for one saved segment. Those are the nodes `scripts/m9a-page-check.ts` and `scripts/listen-check.ts` already use. The observer stamps `Date.now()` in the page, the same clock as `X-Capture-Wall-Ms`. A copy every 100 ms, and a push on each new sight, brings the stamps back to the runner. The JSON field `clockOffsetMs` is the page clock minus the Node clock, taken at the midpoint of one round trip. Both lag ends are page timestamps, so the subtraction leaves that offset unused.

- **Preview lag** — each time a grey draft row's `data-end` moves forward, the visible time minus the spoken time of that new end. The row is one `data-key`. A repeat, a retraction, or silence that leaves `data-end` where it is adds no sample. A jump across a silent stretch is timed to the new end, so the silence is not added on top. Pending rows stay in the pending layer and out of this draft.
- **Final lag** — the first time each saved segment's `span[data-id]` is visible, minus the spoken time of that segment's end. `segmentNode` in `public/app.js` sets `data-id` and does not set an end. The paragraph's `data-end` is the end of the whole paragraph, so a segment does not use it. When the span has no `data-end`, the harness maps the span id to `endMs` from the segments snapshot it already polls (the same response that feeds `LagMeter`; each poll's `segments` carry `id` and `endMs`). A later poll overwrites the same id. A segment the snapshot never listed is left out. A second segment that joins an existing paragraph is its own span, so it is its own sample, at the time that span first appears. A later redraw of the same id adds nothing. Headline final `n` counts segments, the same unit as the diagnostic final `n`.

`visibleLags` in `scripts/bench/snapshot.ts` turns the sights into those samples. The unit test in `test/bench.test.ts` feeds it fictional sights: a draft that grows, a repeat, a retraction, a jump across silence, the same sights out of order, a final segment, a second sight of that segment, a segment whose end has no frame, and a paragraph whose second segment appears later with no end on the span (the end comes from a fictional snapshot). Reversing those sights gives the same samples.

**Diagnostic: reached server to available on server.** The run still feeds `LagMeter` (`scripts/lag-meter.ts`). Zero is the PCM upload's HTTP 201. Appearance is the segments snapshot, polled every 250 ms. Preview samples are growth of a draft's `coveredUntilMs`. Final samples are the first time a segment id appears. The report places this table under the spoken-to-visible headline. It is the server path.

**Sanity check.** Spoken-to-visible includes framing and the page, so a headline median should not beat the matching diagnostic median. If the headline preview or final p50 is more than 250 ms below its diagnostic p50, the JSON field `warning` records that and the run prints it on stderr. The run still finishes and still writes the result. A side with no samples is not compared. The same unit test checks the 250 ms boundary, including a headline that is lower and one that is not.

### Resources

Every 1 s, `ps -axo pid=,ppid=,pcpu=,rss=,command=` samples the Node process that hosts the server, and every descendant whose command is `stt-worker.ts` or `stt-stream-worker.ts` plus processes those workers spawn (the decoder). Chrome is a descendant and is not counted as a speech worker. When both the final-text worker and the preview worker are alive, one sample sums them. CPU is sampled macOS `ps %cpu`: a **decaying average over up to a minute**, not instantaneous or one-second interval utilization. **100% = one core**; values can exceed 100% and are not normalized to the whole machine. Averaging history changes when workers restart. RSS from `ps` is kilobytes, stored as bytes. The report gives mean, p95, and sampled max for each role; one-second sampling can miss short-lived processes and true peaks. Sampling starts once recording is up and continues while the tail is still being transcribed.

### How to rerun

From `app/`, with provider keys unset. Fetch needs network access; measurement needs a local speech model, downloaded corpus and (for live) disposable Chromium. The report command needs none of these. Point `MEETING_TEST_CHROME` at a disposable Chromium, not the Chrome you browse with. The model is the one HearAlong already uses (`MEETING_MODEL_PATH` or Pi's voice settings).

```sh
npm run bench:fetch
npm run bench:wer -- --run-label full
npm run bench:wer -- --sessions ES2004a --mic Mix-Headset --run-label pilot
npm run bench:live -- --session ES2004a --mic Mix-Headset --from 0:00 --minutes 10 --run-label live-es2004a
npm run bench:report
```

`bench:report` reads every `results/*.json`, or the files you pass. It emits one block per cohort, newest first (by newest run), with run and finished-run counts. Cohorts match kind; model basename + SHA-256; chip, RAM and logical cores; app commit and dirty state; and exact condition: requested sessions × mics set for file accuracy, or session, mic, from and minutes for live. Labels do not define cohorts. Different conditions are never pooled. Results missing the new provenance fields go in one inspection-only **Legacy** block, with no cross-run statistics.

Within each cohort it prints medians and min–max spreads from eligible finished repetitions only, including in the per-session table. Each metric reports its eligible run count; lag/resource summaries contribute only when their `n > 0` (accuracy requires reference N > 0). Missing is `n/a`, never zero. Errored runs remain visible with failed/unfinished chunk counts but contribute to no median. Three comparable finished runs are the intended spread; a single eligible run is explicitly counted as one, not repeatability evidence.

## Known limits

- **Live tail visibility:** queue settlement does not wait for every saved final to reach the real DOM or the segment-end snapshot before closing Chromium. Tail samples can be censored; no expected/observed/unmapped coverage accounting yet. Lag is conditional on recognized, mapped, observed text, not all speech. The diagnostic warning is a heuristic, not validation.
- **Live input alignment:** fake-microphone playback can start before the capture graph is ready. Startup loss/offset and captured duration are not measured. WER still scores the requested interval; half-open reference selection by word start can include clipped boundary words.
- **Reference integrity:** extraction is not atomic or verified against the archive; partial XML and missing speaker files can be accepted. Extracted references are not fingerprinted in results. Blank/whitespace timestamp attributes can silently become zero; negative/reversed times are not validated.
- **Corpus trust:** fetch checks local hashes but can adopt preexisting nonempty files (trust on first use). Hashes do not establish official-source identity; approved corpus checksums and an immutable scored-input manifest are not pinned to runs.
- **Provenance beyond this minimum:** no versioned measurement schema, selected backend/config, Chromium/native-runtime versions, or source-diff identity. `--allow-dirty` records only a flag, not the dirty bytes; same-commit dirty runs are not uniquely reproducible. Do not modify model/source files during a run.
- **Interpretation:** custom normalization has the numeric/lexical limits listed above; macOS CPU values have a decaying time base, and one-second resource sampling misses true peaks. No end-to-end browser/audio alignment or tail-observation validation is supplied by the offline unit tests.

## Results

<!-- bench:begin -->
not yet measured
<!-- bench:end -->
