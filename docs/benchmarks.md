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

### Word error rate

WER = (substitutions + deletions + insertions) / N, where N is the number of reference words after normalization. A corpus figure sums the counts across sessions and divides once. It is not the mean of the per-session rates.

The same normalizer is applied to the reference and to the hypothesis:

1. Unicode NFKC, then lower case. Curly apostrophes (U+2018, U+2019, U+201A, U+201B, U+2032, U+2035, U+02BC) become `'`. Hyphens U+2010 and U+2011 become `-` (NFKC does not fold them).
2. `-` and `_` become a space, so `well-known`, `uh-huh`, and `uh_huh` split.
3. Other characters that are not a letter, digit, or word-internal apostrophe become a space. An apostrophe with a letter or digit on both sides stays (`don't`). Neighbors split rather than glue (`3.14` becomes two tokens, and so does `2,000`).
4. A token of only digits whose integer value is 0–9999 becomes English words with no "and" (`2` and `two` match, `101` is `one hundred one`, `0` is `zero`). Leading zeros use that integer (`007` is `seven`). A larger digit string stays as digits (`10000`).
5. Remove the fillers `uh`, `um`, `hmm`, `mm`, `mhm`, `ah`, `eh`, `oh`. After the hyphen split, the pairs `uh huh` and `mm hmm` are removed together, so `uh-huh` does not leave a `huh`. A lone `huh` stays.
6. Collapse whitespace.

### File WER

`npm run bench:wer` transcribes each selected WAV with the same store, queue, and local recognizer as `scripts/transcribe-file.ts` (the original file is read in place). The hypothesis is the final segments' text, joined in time order. The reference is the whole meeting. Raw JSON is `app/artifacts/bench/results/wer-<timestamp>.json`: per-session counts, totals, the model file's basename, wall time, audio duration, git commit, macOS version, `sysctl -n machdep.cpu.brand_string`, and RAM from `sysctl -n hw.memsize`.

### Preview lag and final lag

`npm run bench:live` plays one WAV excerpt in real time through the real page and server, using the rehearsal tool: a disposable headless Chromium (`MEETING_TEST_CHROME`), a temporary data folder under `app/artifacts/rehearsal/runs`, and an ephemeral port. It does not use the user's browser profile, the app's `data` folder, or port 4318.

The excerpt starts at `--from` (M:SS on the AMI clock) and lasts `--minutes` (default 10). The live reference is the same half-open window. The live WER compares the saved final transcript of that window with the AMI reference for the same window.

The headline is spoken to visible. The report gives p50, p95, max, and the number of samples.

**When the audio was spoken.** The fake microphone plays the WAV in real time. Each PCM upload carries `X-Capture-Wall-Ms`, the wall time of that frame's first sample (`captureWallMs` in `public/pcm-worklet.js`, sent by `public/app.js`). `X-Start-Ms` is that sample's meeting time. A later position in the frame was spoken at `captureWallMs + (meetingMs - startMs)`, the sample offset the worklet already adds (`index * 1000 / sampleRate`). `spokenAt` in `scripts/bench/snapshot.ts` applies that sum. A position on a boundary between two frames uses the later frame. A position more than 1 ms past every frame, or in a gap between frames, is left unmapped, and that sight is left out of the lag. The unit test in `test/bench.test.ts` checks a fictional frame: the first sample, a sample 500 ms in, the frame's end, the next frame, the 1 ms rounding slack, a gap, and a missing, zero, or non-numeric capture header. That test is the check of the mapping. A discontinuity listed inside a frame stays linear; this rehearsal plays the file straight through.

**When the text is visible.** Before navigation, the harness installs a `MutationObserver` in the page. It reads `#transcript .para[data-kind="active"] .preview-text` for the grey draft and each `#transcript .para[data-kind="final"] span[data-id]` for one saved segment. Those are the nodes `scripts/m9a-page-check.ts` and `scripts/listen-check.ts` already use. The observer stamps `Date.now()` in the page, the same clock as `X-Capture-Wall-Ms`. A copy every 100 ms, and a push on each new sight, brings the stamps back to the runner. The JSON field `clockOffsetMs` is the page clock minus the Node clock, taken at the midpoint of one round trip. Both lag ends are page timestamps, so the subtraction leaves that offset unused.

- **Preview lag** — each time a grey draft row's `data-end` moves forward, the visible time minus the spoken time of that new end. The row is one `data-key`. A repeat, a retraction, or silence that leaves `data-end` where it is adds no sample. A jump across a silent stretch is timed to the new end, so the silence is not added on top. Pending rows stay in the pending layer and out of this draft.
- **Final lag** — the first time each saved segment's `span[data-id]` is visible, minus the spoken time of that segment's end. `segmentNode` in `public/app.js` sets `data-id` and does not set an end. The paragraph's `data-end` is the end of the whole paragraph, so a segment does not use it. When the span has no `data-end`, the harness maps the span id to `endMs` from the segments snapshot it already polls (the same response that feeds `LagMeter`; each poll's `segments` carry `id` and `endMs`). A later poll overwrites the same id. A segment the snapshot never listed is left out. A second segment that joins an existing paragraph is its own span, so it is its own sample, at the time that span first appears. A later redraw of the same id adds nothing. Headline final `n` counts segments, the same unit as the diagnostic final `n`.

`visibleLags` in `scripts/bench/snapshot.ts` turns the sights into those samples. The unit test in `test/bench.test.ts` feeds it fictional sights: a draft that grows, a repeat, a retraction, a jump across silence, the same sights out of order, a final segment, a second sight of that segment, a segment whose end has no frame, and a paragraph whose second segment appears later with no end on the span (the end comes from a fictional snapshot). Reversing those sights gives the same samples.

**Diagnostic: reached server to available on server.** The run still feeds `LagMeter` (`scripts/lag-meter.ts`). Zero is the PCM upload's HTTP 201. Appearance is the segments snapshot, polled every 250 ms. Preview samples are growth of a draft's `coveredUntilMs`. Final samples are the first time a segment id appears. The report places this table under the spoken-to-visible headline. It is the server path.

**Sanity check.** Spoken-to-visible includes framing and the page, so a headline median should not beat the matching diagnostic median. If the headline preview or final p50 is more than 250 ms below its diagnostic p50, the JSON field `warning` records that and the run prints it on stderr. The run still finishes and still writes the result. A side with no samples is not compared. The same unit test checks the 250 ms boundary, including a headline that is lower and one that is not.

### Resources

Every 1 s, `ps -axo pid=,ppid=,pcpu=,rss=,command=` samples the Node process that hosts the server, and every descendant whose command is `stt-worker.ts` or `stt-stream-worker.ts` plus processes those workers spawn (the decoder). Chrome is a descendant and is not counted as a speech worker. When both the final-text worker and the preview worker are alive, one sample sums them. CPU is the `ps` percent. RSS from `ps` is kilobytes, stored as bytes. The report gives mean, p95, and max for each role. Sampling starts once recording is up and continues while the tail is still being transcribed.

### How to rerun

From `app/`, with provider keys unset. Fetch and the two measurement commands need a network and a speech model; the report command does not. Point `MEETING_TEST_CHROME` at a disposable Chromium, not the Chrome you browse with. The model is the one HearAlong already uses (`MEETING_MODEL_PATH` or Pi's voice settings).

```sh
npm run bench:fetch
npm run bench:wer -- --run-label full
npm run bench:wer -- --sessions ES2004a --mic Mix-Headset --run-label pilot
npm run bench:live -- --session ES2004a --mic Mix-Headset --from 0:00 --minutes 10 --run-label live-es2004a
npm run bench:report
```

`bench:report` reads every `results/*.json`, or the files you pass. With two or more finished runs it prints the median and the min–max spread. Three runs are the intended spread. A run that stopped early is listed and left out of the median.

## Results

<!-- bench:begin -->
not yet measured
<!-- bench:end -->
