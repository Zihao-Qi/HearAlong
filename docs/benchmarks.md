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

Accuracy is **custom-normalized WER**, not directly comparable to published Whisper/NIST scores. The policy below is custom, not a standard English equivalence normalizer; its implementation is identified by `normalizer` (`hearalong-2` currently; missing means `hearalong-1`) and the scoring commit. Re-scoring retains the original transcription commit, dirty state, model, machine, audio time and wall time, and adds `rescoredFrom`, `rescoredAt`, `scoringCommit` and `scoringDirty`.

WER = (substitutions + deletions + insertions) / N, where N is the number of reference words after normalization. A corpus figure sums the counts across sessions and divides once. It is not the mean of the per-session rates.

The same normalizer is applied to the reference and to the hypothesis:

1. Unicode NFKC. Curly apostrophes (U+2018, U+2019, U+201A, U+201B, U+2032, U+2035, U+02BC) become `'`. Hyphens U+2010 and U+2011 become `-` (NFKC does not fold them).
2. First join AMI letter-sequence tokens: only single letters each followed by `_`, optionally ending in a lowercase plural `s` (`T_V_` → `tv`, `L_C_D_` → `lcd`, `T_V_s` → `tvs`). Check the lowercase plural suffix before lowercasing the token; then lowercase and replace `-` and other `_` with a space, so `well-known`, `uh-huh`, and `uh_huh` still split.
3. Other characters that are not a letter, digit, or word-internal apostrophe become a space. An apostrophe with a letter or digit on both sides stays (`don't`). Neighbors split rather than glue (`3.14` becomes two tokens, and so does `2,000`).
4. Map lowercase tokens from British to American spelling using OpenAI Whisper's vendored `english.json` (`programme` → `program`, `colour` → `color`), plus explicit `recogniser(s)` → `recognizer(s)` entries absent from that dictionary. Unlisted words stay unchanged. Source commit and MIT licence are recorded in `app/scripts/bench/vendor/README.md`.
5. A token of only digits whose integer value is 0–9999 becomes English words with no "and" (`2` and `two` match, `101` is `one hundred one`, `0` is `zero`). Leading zeros use that integer (`007` is `seven`). A larger digit string stays as digits (`10000`).
6. Remove the fillers `uh`, `um`, `hmm`, `mm`, `mhm`, `ah`, `eh`, `oh`. After the hyphen split, the pairs `uh huh` and `mm hmm` are removed together, so `uh-huh` does not leave a `huh`. A lone `huh` stays.
7. Collapse whitespace.

Limits: ordinals (`2nd`) and decades (`1990s`) are not expanded; decimal and thousands punctuation splits numbers before expansion (`3.5` → `three five`, `2,000` → `two zero`). Years expand as cardinals, leading-zero sequences lose their zeros, and numbers above 9999 stay digits. British “and” and contraction variants are not equated. Filler removal is lossy (`oh no` matches `no`). Formatting differences can therefore count as recognition errors, and distinct utterances can normalize identically.

### File custom-normalized WER

`npm run bench:wer` transcribes each selected WAV with the same store, queue, and local recognizer as `scripts/transcribe-file.ts` (the original file is read in place). The hypothesis is the final segments' text, joined in time order. The reference is the whole meeting. Raw JSON is `app/artifacts/bench/results/wer-<timestamp>.json`: per-session counts, totals, requested sessions × mics, failed and unfinished chunk counts, wall time, and audio duration. Both runners record the selected model file's basename, SHA-256 and byte size (hashed once before measurement), git commit and dirty flag, Node version, macOS version, chip (`sysctl -n machdep.cpu.brand_string`), RAM (`hw.memsize`) and logical cores (`hw.logicalcpu`). The selected model path is fixed for the whole run. Dirty source is refused unless `--allow-dirty` is passed; that state is recorded and never pooled with clean runs.

Benchmark settlement waits for every chunk to become terminal, including scheduled automatic retries, with a 30-minute deadline after queueing the file (or stopping live capture). Exhausted failures, cancelled chunks, or unfinished chunks mark the run as an error, not a completed repetition. This is an opt-in benchmark path; `transcribe-file.ts`'s CLI output is unchanged.

### Single-speaker breakdown

Use the same word-level minimum-edit alignment as overall WER, with diagonal, deletion, then insertion tie-breaking. A normalized reference word is crosstalk if its time interval strictly overlaps any word from another speaker. Per speaker, gaps of at least 1.5 s split turns; turns of at most two normalized words are short. Single-speaker WER excludes both overlapping words and short turns. Insertions belong to the reference word before them; leading insertions belong to the first word (none for an empty reference). Each category stores S, D, I, hits and N per session. The diagnostic chunk-edge category marks words starting within 1 s, inclusive, of a 20 s boundary; it does not exclude words from single-speaker scoring. The crosstalk deletion share is overlapping deletions divided by all deletions. Categories are not disjoint.

### Individual-headset model-file check

`bench:fetch -- --mic Headset` fetches the individual channels for the same 16 SC meetings. `bench:ihm -- --allow-dirty` uses `annotations/corpusResources/meetings.xml` to map each speaker to a headset channel, and `annotations/segments/<ID>.<A-D>.segments.xml` for clips. Each clip uses that speaker's headset and reference words whose start falls in the half-open segment, with the same word filtering as above. A single loaded `LocalRecognizer` transcribes all clips directly, without 20 s chunking or stitching, through the existing STT worker (including its standard recovery policy). Saved `work/ihm/<stamp>/clips.jsonl` records hypotheses, segment bounds, both scores and recovery diagnostics. Corpus WER sums the clip counts, including empty-reference clips, rather than aligning across segment boundaries.

This is a check of the Q8 model file against NVIDIA's published **10.14% AMI WER** for `parakeet-unified-en-0.6b` (offline, Open ASR Leaderboard, whisper-normalizer 0.1.12), not an exact reproduction. Our normalizer is not whisper-normalizer: number formatting, filler removal and contraction handling differ. NVIDIA's segmentation may differ from AMI's segments file. The check reports both `hearalong-2` and the old `hearalong-1` WER in a separate `ihm` cohort.

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
npm run bench:rescore -- --all
npm run bench:fetch -- --mic Headset
npm run bench:ihm -- --allow-dirty
npm run bench:report
```

`bench:report` reads every `results/*.json`, or the files you pass. It emits one block per cohort, newest first (by newest run), with run and finished-run counts. Cohorts never pool normalizer versions (missing means `hearalong-1`) or differing scoring commits/dirty states. Cohorts match kind; model basename + SHA-256; chip, RAM and logical cores; app commit and dirty state; and exact condition: requested sessions × mics set for file accuracy, or session, mic, from and minutes for live. Labels do not define cohorts. Different conditions are never pooled. Results missing the new provenance fields go in one inspection-only **Legacy** block, with no cross-run statistics.

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
AMI Meeting Corpus, CC BY 4.0. Carletta et al., "The AMI Meeting Corpus", 2005. https://creativecommons.org/licenses/by/4.0/

Accuracy is custom-normalized WER; not directly comparable to published Whisper/NIST scores.

### Cohort 1 — ihm

1 run; 1 finished.

Normalizer: hearalong-2. Scoring commit: a2fed910a6dfa941250cdfc69596b48d808f4e25; scoring dirty: true.

Condition: sessions EN2002a, EN2002b, EN2002c, EN2002d, ES2004a, ES2004b, ES2004c, ES2004d, IS1009a, IS1009b, IS1009c, IS1009d, TS3003a, TS3003b, TS3003c, TS3003d × mics Headset.

| Run | Kind | Date | Label | Model basename | Model SHA-256 | Model bytes | Commit | Dirty | Node | macOS | Chip | RAM | Logical cores | Failed chunks | Unfinished chunks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ihm | 2026-10-30T16:28:32.292Z | ami-segments-own-headsets | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | a2fed910a6dfa941250cdfc69596b48d808f4e25 | true | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |

Check of the Q8 model file against NVIDIA’s published AMI 10.14% (offline, Open ASR Leaderboard). Not an exact reproduction: our normalizer is not whisper-normalizer (numbers, fillers, contractions differ); NVIDIA’s segmentation may differ from AMI’s segments file.

| Run | hearalong-2 WER | hearalong-1 WER | NVIDIA published WER | Clips |
| --- | --- | --- | --- | --- |
| 1 | 9.87% | 10.71% | 10.14% | 8247 |

#### Accuracy: custom-normalized WER

| Run | Custom-normalized WER | S | D | I | N | Audio | Wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 9.87% | 3322 | 2011 | 2893 | 83328 | 33952.9 s | 1347.2 s |

Median custom-normalized WER across 1 eligible run: 9.87% (min 9.87%, max 9.87%).

##### Per session

| Session | Mic | Run 1 | Median | Eligible runs |
| --- | --- | --- | --- | --- |
| EN2002a | Headset-0 | 13.27% | 13.27% | 1 |
| EN2002a | Headset-1 | 16.68% | 16.68% | 1 |
| EN2002a | Headset-2 | 6.53% | 6.53% | 1 |
| EN2002a | Headset-3 | 19.93% | 19.93% | 1 |
| EN2002b | Headset-0 | 17.80% | 17.80% | 1 |
| EN2002b | Headset-1 | 19.11% | 19.11% | 1 |
| EN2002b | Headset-2 | 7.49% | 7.49% | 1 |
| EN2002b | Headset-3 | 10.64% | 10.64% | 1 |
| EN2002c | Headset-1 | 8.53% | 8.53% | 1 |
| EN2002c | Headset-2 | 15.09% | 15.09% | 1 |
| EN2002c | Headset-3 | 8.92% | 8.92% | 1 |
| EN2002d | Headset-0 | 24.81% | 24.81% | 1 |
| EN2002d | Headset-1 | 7.85% | 7.85% | 1 |
| EN2002d | Headset-2 | 16.60% | 16.60% | 1 |
| EN2002d | Headset-3 | 12.36% | 12.36% | 1 |
| ES2004a | Headset-0 | 11.68% | 11.68% | 1 |
| ES2004a | Headset-1 | 4.68% | 4.68% | 1 |
| ES2004a | Headset-2 | 11.89% | 11.89% | 1 |
| ES2004a | Headset-3 | 5.81% | 5.81% | 1 |
| ES2004b | Headset-0 | 11.28% | 11.28% | 1 |
| ES2004b | Headset-1 | 4.81% | 4.81% | 1 |
| ES2004b | Headset-2 | 9.43% | 9.43% | 1 |
| ES2004b | Headset-3 | 4.65% | 4.65% | 1 |
| ES2004c | Headset-0 | 11.89% | 11.89% | 1 |
| ES2004c | Headset-1 | 7.48% | 7.48% | 1 |
| ES2004c | Headset-2 | 6.65% | 6.65% | 1 |
| ES2004c | Headset-3 | 6.58% | 6.58% | 1 |
| ES2004d | Headset-0 | 22.03% | 22.03% | 1 |
| ES2004d | Headset-1 | 6.16% | 6.16% | 1 |
| ES2004d | Headset-2 | 9.68% | 9.68% | 1 |
| ES2004d | Headset-3 | 5.67% | 5.67% | 1 |
| IS1009a | Headset-0 | 6.98% | 6.98% | 1 |
| IS1009a | Headset-1 | 13.61% | 13.61% | 1 |
| IS1009a | Headset-2 | 32.76% | 32.76% | 1 |
| IS1009a | Headset-3 | 9.80% | 9.80% | 1 |
| IS1009b | Headset-0 | 6.01% | 6.01% | 1 |
| IS1009b | Headset-1 | 8.83% | 8.83% | 1 |
| IS1009b | Headset-2 | 12.66% | 12.66% | 1 |
| IS1009b | Headset-3 | 4.99% | 4.99% | 1 |
| IS1009c | Headset-0 | 5.24% | 5.24% | 1 |
| IS1009c | Headset-1 | 7.09% | 7.09% | 1 |
| IS1009c | Headset-2 | 8.57% | 8.57% | 1 |
| IS1009c | Headset-3 | 7.51% | 7.51% | 1 |
| IS1009d | Headset-0 | 6.53% | 6.53% | 1 |
| IS1009d | Headset-1 | 16.33% | 16.33% | 1 |
| IS1009d | Headset-2 | 27.01% | 27.01% | 1 |
| IS1009d | Headset-3 | 6.55% | 6.55% | 1 |
| TS3003a | Headset-0 | 8.46% | 8.46% | 1 |
| TS3003a | Headset-1 | 72.15% | 72.15% | 1 |
| TS3003a | Headset-2 | 30.36% | 30.36% | 1 |
| TS3003a | Headset-3 | 17.35% | 17.35% | 1 |
| TS3003b | Headset-0 | 6.87% | 6.87% | 1 |
| TS3003b | Headset-1 | 21.79% | 21.79% | 1 |
| TS3003b | Headset-2 | 5.17% | 5.17% | 1 |
| TS3003b | Headset-3 | 5.27% | 5.27% | 1 |
| TS3003c | Headset-0 | 6.27% | 6.27% | 1 |
| TS3003c | Headset-1 | 18.48% | 18.48% | 1 |
| TS3003c | Headset-2 | 5.29% | 5.29% | 1 |
| TS3003c | Headset-3 | 5.78% | 5.78% | 1 |
| TS3003d | Headset-0 | 6.83% | 6.83% | 1 |
| TS3003d | Headset-1 | 22.96% | 22.96% | 1 |
| TS3003d | Headset-2 | 9.59% | 9.59% | 1 |
| TS3003d | Headset-3 | 9.21% | 9.21% | 1 |

### Cohort 2 — live

3 runs; 3 finished.

Normalizer: hearalong-1. Scoring commit: c531d9161c845b49cabb796d910d97f6cd2621a3; scoring dirty: false.

Condition: ES2004a, Mix-Headset, from 300 s, 10 minutes.

| Run | Kind | Date | Label | Model basename | Model SHA-256 | Model bytes | Commit | Dirty | Node | macOS | Chip | RAM | Logical cores | Failed chunks | Unfinished chunks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | live | 2026-10-30T07:13:58.878Z | live run 3 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 2 | live | 2026-10-30T07:03:56.595Z | live run 2 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 3 | live | 2026-10-30T06:53:53.696Z | live run 1 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |

#### Live latency

Spoken to visible. Preview lag is each time the grey draft grows. Final lag is the first time each saved segment is shown.

| Run | Session | Mic | From | Audio | Preview p50 | Preview p95 | Preview max | Preview n | Final p50 | Final p95 | Final max | Final n | Custom-normalized WER |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.20 s | 3.01 s | 7.13 s | 452 | 13.89 s | 23.78 s | 24.53 s | 142 | 19.55% |
| 2 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.19 s | 2.95 s | 7.27 s | 459 | 14.00 s | 23.36 s | 24.51 s | 139 | 17.26% |
| 3 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.43 s | 3.21 s | 7.13 s | 394 | 12.86 s | 22.45 s | 24.05 s | 131 | 19.00% |

Median preview p50 across 3 eligible runs: 2.20 s (min 2.19 s, max 2.43 s).
Median final p50 across 3 eligible runs: 13.89 s (min 12.86 s, max 14.00 s).

Clock offset (page minus Node), recorded and not used in the lag: 0.5 ms, 0.0 ms, 0.0 ms.

##### Diagnostic: reached server to available on server

LagMeter on the segments snapshot, from the PCM upload HTTP 201. This table is the server path, under the spoken-to-visible headline.

| Run | Preview p50 | Preview p95 | Preview max | Preview n | Final p50 | Final p95 | Final max | Final n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.30 s | 2.03 s | 6.52 s | 610 | 12.74 s | 22.60 s | 23.78 s | 142 |
| 2 | 1.31 s | 1.96 s | 6.55 s | 608 | 12.75 s | 21.83 s | 23.83 s | 142 |
| 3 | 1.30 s | 1.97 s | 6.52 s | 607 | 11.75 s | 21.82 s | 22.87 s | 131 |

Median diagnostic preview p50 across 3 eligible runs: 1.30 s (min 1.30 s, max 1.31 s).
Median diagnostic final p50 across 3 eligible runs: 12.74 s (min 11.75 s, max 12.75 s).

#### Resources

CPU is sampled macOS ps %cpu: a decaying average over up to a minute, not instantaneous or one-second utilization; 100% = one core. Maxima are sampled maxima. RSS is the resident set. The speech-worker columns sum the STT processes and whatever they spawn.

| Run | Server CPU mean | Server CPU p95 | Server CPU max | Server RSS mean | Server RSS p95 | Server RSS max | Worker CPU mean | Worker CPU p95 | Worker CPU max | Worker RSS mean | Worker RSS p95 | Worker RSS max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 14.0% | 21.5% | 60.3% | 314.8 MiB | 390.3 MiB | 402.0 MiB | 2.3% | 5.2% | 30.3% | 1819.2 MiB | 1872.7 MiB | 1881.3 MiB |
| 2 | 14.1% | 21.2% | 68.6% | 316.0 MiB | 395.7 MiB | 400.4 MiB | 2.5% | 6.1% | 98.3% | 1819.7 MiB | 1873.9 MiB | 1882.5 MiB |
| 3 | 13.2% | 19.0% | 67.9% | 318.0 MiB | 395.8 MiB | 404.9 MiB | 2.4% | 5.9% | 46.4% | 1819.0 MiB | 1871.4 MiB | 1879.6 MiB |

Median server CPU mean across 3 eligible runs: 14.0% (min 13.2%, max 14.1%).
Median server RSS mean across 3 eligible runs: 316.0 MiB (min 314.8 MiB, max 318.0 MiB).
Median worker CPU mean across 3 eligible runs: 2.4% (min 2.3%, max 2.5%).
Median worker RSS mean across 3 eligible runs: 1819.2 MiB (min 1819.0 MiB, max 1819.7 MiB).

### Cohort 3 — live

3 runs; 3 finished.

Normalizer: hearalong-2. Scoring commit: a2fed910a6dfa941250cdfc69596b48d808f4e25; scoring dirty: true.

Condition: ES2004a, Mix-Headset, from 300 s, 10 minutes.

| Run | Kind | Date | Label | Model basename | Model SHA-256 | Model bytes | Commit | Dirty | Node | macOS | Chip | RAM | Logical cores | Failed chunks | Unfinished chunks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | live | 2026-10-30T07:13:58.878Z | live run 3 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 2 | live | 2026-10-30T07:03:56.595Z | live run 2 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 3 | live | 2026-10-30T06:53:53.696Z | live run 1 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |

#### Live latency

Spoken to visible. Preview lag is each time the grey draft grows. Final lag is the first time each saved segment is shown.

| Run | Session | Mic | From | Audio | Preview p50 | Preview p95 | Preview max | Preview n | Final p50 | Final p95 | Final max | Final n | Custom-normalized WER |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.20 s | 3.01 s | 7.13 s | 452 | 13.89 s | 23.78 s | 24.53 s | 142 | 19.65% |
| 2 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.19 s | 2.95 s | 7.27 s | 459 | 14.00 s | 23.36 s | 24.51 s | 139 | 17.41% |
| 3 | ES2004a | Mix-Headset | 5:00 | 600.0 s | 2.43 s | 3.21 s | 7.13 s | 394 | 12.86 s | 22.45 s | 24.05 s | 131 | 18.47% |

Median preview p50 across 3 eligible runs: 2.20 s (min 2.19 s, max 2.43 s).
Median final p50 across 3 eligible runs: 13.89 s (min 12.86 s, max 14.00 s).

Clock offset (page minus Node), recorded and not used in the lag: 0.5 ms, 0.0 ms, 0.0 ms.

##### Diagnostic: reached server to available on server

LagMeter on the segments snapshot, from the PCM upload HTTP 201. This table is the server path, under the spoken-to-visible headline.

| Run | Preview p50 | Preview p95 | Preview max | Preview n | Final p50 | Final p95 | Final max | Final n |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1.30 s | 2.03 s | 6.52 s | 610 | 12.74 s | 22.60 s | 23.78 s | 142 |
| 2 | 1.31 s | 1.96 s | 6.55 s | 608 | 12.75 s | 21.83 s | 23.83 s | 142 |
| 3 | 1.30 s | 1.97 s | 6.52 s | 607 | 11.75 s | 21.82 s | 22.87 s | 131 |

Median diagnostic preview p50 across 3 eligible runs: 1.30 s (min 1.30 s, max 1.31 s).
Median diagnostic final p50 across 3 eligible runs: 12.74 s (min 11.75 s, max 12.75 s).

#### Resources

CPU is sampled macOS ps %cpu: a decaying average over up to a minute, not instantaneous or one-second utilization; 100% = one core. Maxima are sampled maxima. RSS is the resident set. The speech-worker columns sum the STT processes and whatever they spawn.

| Run | Server CPU mean | Server CPU p95 | Server CPU max | Server RSS mean | Server RSS p95 | Server RSS max | Worker CPU mean | Worker CPU p95 | Worker CPU max | Worker RSS mean | Worker RSS p95 | Worker RSS max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 14.0% | 21.5% | 60.3% | 314.8 MiB | 390.3 MiB | 402.0 MiB | 2.3% | 5.2% | 30.3% | 1819.2 MiB | 1872.7 MiB | 1881.3 MiB |
| 2 | 14.1% | 21.2% | 68.6% | 316.0 MiB | 395.7 MiB | 400.4 MiB | 2.5% | 6.1% | 98.3% | 1819.7 MiB | 1873.9 MiB | 1882.5 MiB |
| 3 | 13.2% | 19.0% | 67.9% | 318.0 MiB | 395.8 MiB | 404.9 MiB | 2.4% | 5.9% | 46.4% | 1819.0 MiB | 1871.4 MiB | 1879.6 MiB |

Median server CPU mean across 3 eligible runs: 14.0% (min 13.2%, max 14.1%).
Median server RSS mean across 3 eligible runs: 316.0 MiB (min 314.8 MiB, max 318.0 MiB).
Median worker CPU mean across 3 eligible runs: 2.4% (min 2.3%, max 2.5%).
Median worker RSS mean across 3 eligible runs: 1819.2 MiB (min 1819.0 MiB, max 1819.7 MiB).

### Cohort 4 — wer

3 runs; 3 finished.

Normalizer: hearalong-1. Scoring commit: c531d9161c845b49cabb796d910d97f6cd2621a3; scoring dirty: false.

Condition: sessions EN2002a, EN2002b, EN2002c, EN2002d, ES2004a, ES2004b, ES2004c, ES2004d, IS1009a, IS1009b, IS1009c, IS1009d, TS3003a, TS3003b, TS3003c, TS3003d × mics Array1-01, Mix-Headset.

| Run | Kind | Date | Label | Model basename | Model SHA-256 | Model bytes | Commit | Dirty | Node | macOS | Chip | RAM | Logical cores | Failed chunks | Unfinished chunks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | wer | 2026-10-30T06:19:36.877Z | wer run 3 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 2 | wer | 2026-10-30T05:45:23.788Z | wer run 2 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 3 | wer | 2026-10-30T05:15:22.716Z | wer run 1 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |

#### Accuracy: custom-normalized WER

| Run | Custom-normalized WER | S | D | I | N | Audio | Wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 25.70% | 7652 | 33070 | 2369 | 167674 | 65248.2 s | 2037.7 s |
| 2 | 25.70% | 7652 | 33070 | 2369 | 167674 | 65248.2 s | 2033.9 s |
| 3 | 25.70% | 7652 | 33070 | 2369 | 167674 | 65248.2 s | 1782.3 s |

Median custom-normalized WER across 3 eligible runs: 25.70% (min 25.70%, max 25.70%).

##### Per session

| Session | Mic | Run 1 | Run 2 | Run 3 | Median | Eligible runs |
| --- | --- | --- | --- | --- | --- | --- |
| EN2002a | Array1-01 | 38.77% | 38.77% | 38.77% | 38.77% | 3 |
| EN2002a | Mix-Headset | 34.74% | 34.74% | 34.74% | 34.74% | 3 |
| EN2002b | Array1-01 | 37.05% | 37.05% | 37.05% | 37.05% | 3 |
| EN2002b | Mix-Headset | 33.13% | 33.13% | 33.13% | 33.13% | 3 |
| EN2002c | Array1-01 | 32.42% | 32.42% | 32.42% | 32.42% | 3 |
| EN2002c | Mix-Headset | 27.16% | 27.16% | 27.16% | 27.16% | 3 |
| EN2002d | Array1-01 | 37.78% | 37.78% | 37.78% | 37.78% | 3 |
| EN2002d | Mix-Headset | 34.63% | 34.63% | 34.63% | 34.63% | 3 |
| ES2004a | Array1-01 | 26.86% | 26.86% | 26.86% | 26.86% | 3 |
| ES2004a | Mix-Headset | 17.73% | 17.73% | 17.73% | 17.73% | 3 |
| ES2004b | Array1-01 | 19.66% | 19.66% | 19.66% | 19.66% | 3 |
| ES2004b | Mix-Headset | 15.75% | 15.75% | 15.75% | 15.75% | 3 |
| ES2004c | Array1-01 | 20.93% | 20.93% | 20.93% | 20.93% | 3 |
| ES2004c | Mix-Headset | 17.28% | 17.28% | 17.28% | 17.28% | 3 |
| ES2004d | Array1-01 | 30.75% | 30.75% | 30.75% | 30.75% | 3 |
| ES2004d | Mix-Headset | 25.33% | 25.33% | 25.33% | 25.33% | 3 |
| IS1009a | Array1-01 | 26.15% | 26.15% | 26.15% | 26.15% | 3 |
| IS1009a | Mix-Headset | 23.90% | 23.90% | 23.90% | 23.90% | 3 |
| IS1009b | Array1-01 | 21.53% | 21.53% | 21.53% | 21.53% | 3 |
| IS1009b | Mix-Headset | 19.26% | 19.26% | 19.26% | 19.26% | 3 |
| IS1009c | Array1-01 | 14.73% | 14.73% | 14.73% | 14.73% | 3 |
| IS1009c | Mix-Headset | 13.98% | 13.98% | 13.98% | 13.98% | 3 |
| IS1009d | Array1-01 | 22.80% | 22.80% | 22.80% | 22.80% | 3 |
| IS1009d | Mix-Headset | 17.51% | 17.51% | 17.51% | 17.51% | 3 |
| TS3003a | Array1-01 | 32.88% | 32.88% | 32.88% | 32.88% | 3 |
| TS3003a | Mix-Headset | 19.76% | 19.76% | 19.76% | 19.76% | 3 |
| TS3003b | Array1-01 | 16.99% | 16.99% | 16.99% | 16.99% | 3 |
| TS3003b | Mix-Headset | 16.69% | 16.69% | 16.69% | 16.69% | 3 |
| TS3003c | Array1-01 | 19.50% | 19.50% | 19.50% | 19.50% | 3 |
| TS3003c | Mix-Headset | 15.58% | 15.58% | 15.58% | 15.58% | 3 |
| TS3003d | Array1-01 | 33.35% | 33.35% | 33.35% | 33.35% | 3 |
| TS3003d | Mix-Headset | 21.38% | 21.38% | 21.38% | 21.38% | 3 |

### Cohort 5 — wer

3 runs; 3 finished.

Normalizer: hearalong-2. Scoring commit: a2fed910a6dfa941250cdfc69596b48d808f4e25; scoring dirty: true.

Condition: sessions EN2002a, EN2002b, EN2002c, EN2002d, ES2004a, ES2004b, ES2004c, ES2004d, IS1009a, IS1009b, IS1009c, IS1009d, TS3003a, TS3003b, TS3003c, TS3003d × mics Array1-01, Mix-Headset.

| Run | Kind | Date | Label | Model basename | Model SHA-256 | Model bytes | Commit | Dirty | Node | macOS | Chip | RAM | Logical cores | Failed chunks | Unfinished chunks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | wer | 2026-10-30T06:19:36.877Z | wer run 3 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 2 | wer | 2026-10-30T05:45:23.788Z | wer run 2 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |
| 3 | wer | 2026-10-30T05:15:22.716Z | wer run 1 | parakeet-unified-en-0.6b-Q8_0.gguf | 4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795 | 731357568 | c531d9161c845b49cabb796d910d97f6cd2621a3 | false | v22.22.2 | 27.0.1 | Apple M2 | 16.0 GiB | 8 | 0 | 0 |

#### Accuracy: custom-normalized WER

| Run | Custom-normalized WER | S | D | I | N | Audio | Wall |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 25.07% | 7134 | 32170 | 2485 | 166658 | 65248.2 s | 2037.7 s |
| 2 | 25.07% | 7134 | 32170 | 2485 | 166658 | 65248.2 s | 2033.9 s |
| 3 | 25.07% | 7134 | 32170 | 2485 | 166658 | 65248.2 s | 1782.3 s |

Median custom-normalized WER across 3 eligible runs: 25.07% (min 25.07%, max 25.07%).

##### Per microphone

Corpus counts across eligible finished runs. Single-speaker excludes overlap and turns of at most two words. Insertions attach to the preceding reference word (leading insertions to the first).

| Mic | Overall WER | Single-speaker WER | Share of missed words that were crosstalk |
| --- | --- | --- | --- |
| Array1-01 | 27.47% | 15.79% | 64.58% |
| Mix-Headset | 22.68% | 10.64% | 75.02% |

##### Per session

| Session | Mic | Run 1 | Run 2 | Run 3 | Median | Eligible runs |
| --- | --- | --- | --- | --- | --- | --- |
| EN2002a | Array1-01 | 38.11% | 38.11% | 38.11% | 38.11% | 3 |
| EN2002a | Mix-Headset | 34.05% | 34.05% | 34.05% | 34.05% | 3 |
| EN2002b | Array1-01 | 36.34% | 36.34% | 36.34% | 36.34% | 3 |
| EN2002b | Mix-Headset | 32.41% | 32.41% | 32.41% | 32.41% | 3 |
| EN2002c | Array1-01 | 31.50% | 31.50% | 31.50% | 31.50% | 3 |
| EN2002c | Mix-Headset | 26.14% | 26.14% | 26.14% | 26.14% | 3 |
| EN2002d | Array1-01 | 37.16% | 37.16% | 37.16% | 37.16% | 3 |
| EN2002d | Mix-Headset | 34.08% | 34.08% | 34.08% | 34.08% | 3 |
| ES2004a | Array1-01 | 27.15% | 27.15% | 27.15% | 27.15% | 3 |
| ES2004a | Mix-Headset | 17.14% | 17.14% | 17.14% | 17.14% | 3 |
| ES2004b | Array1-01 | 19.21% | 19.21% | 19.21% | 19.21% | 3 |
| ES2004b | Mix-Headset | 14.74% | 14.74% | 14.74% | 14.74% | 3 |
| ES2004c | Array1-01 | 20.81% | 20.81% | 20.81% | 20.81% | 3 |
| ES2004c | Mix-Headset | 16.06% | 16.06% | 16.06% | 16.06% | 3 |
| ES2004d | Array1-01 | 30.67% | 30.67% | 30.67% | 30.67% | 3 |
| ES2004d | Mix-Headset | 24.86% | 24.86% | 24.86% | 24.86% | 3 |
| IS1009a | Array1-01 | 26.14% | 26.14% | 26.14% | 26.14% | 3 |
| IS1009a | Mix-Headset | 23.61% | 23.61% | 23.61% | 23.61% | 3 |
| IS1009b | Array1-01 | 20.87% | 20.87% | 20.87% | 20.87% | 3 |
| IS1009b | Mix-Headset | 18.82% | 18.82% | 18.82% | 18.82% | 3 |
| IS1009c | Array1-01 | 13.90% | 13.90% | 13.90% | 13.90% | 3 |
| IS1009c | Mix-Headset | 13.28% | 13.28% | 13.28% | 13.28% | 3 |
| IS1009d | Array1-01 | 22.20% | 22.20% | 22.20% | 22.20% | 3 |
| IS1009d | Mix-Headset | 17.04% | 17.04% | 17.04% | 17.04% | 3 |
| TS3003a | Array1-01 | 32.46% | 32.46% | 32.46% | 32.46% | 3 |
| TS3003a | Mix-Headset | 19.20% | 19.20% | 19.20% | 19.20% | 3 |
| TS3003b | Array1-01 | 16.24% | 16.24% | 16.24% | 16.24% | 3 |
| TS3003b | Mix-Headset | 15.63% | 15.63% | 15.63% | 15.63% | 3 |
| TS3003c | Array1-01 | 19.01% | 19.01% | 19.01% | 19.01% | 3 |
| TS3003c | Mix-Headset | 15.05% | 15.05% | 15.05% | 15.05% | 3 |
| TS3003d | Array1-01 | 33.19% | 33.19% | 33.19% | 33.19% | 3 |
| TS3003d | Mix-Headset | 20.89% | 20.89% | 20.89% | 20.89% | 3 |
<!-- bench:end -->
