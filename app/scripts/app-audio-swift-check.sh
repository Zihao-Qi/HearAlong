#!/bin/sh
# Pure conversion/framing/grouping/timeline tests. No app launch, Core Audio discovery, process tap, or TCC calls.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swiftc -O -o "$TMP/pipeline-tests" launcher/AudioPipeline.swift launcher/PipelineTests.swift -framework AVFoundation
"$TMP/pipeline-tests" "$TMP"
swiftc -O -DAPP_AUDIO_TESTING -o "$TMP/app-audio-tests" launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppAudioTests.swift -framework Cocoa -framework CoreAudio -framework AVFoundation
"$TMP/app-audio-tests"
swiftc -O -DAPP_AUDIO_TESTING -o "$TMP/tap-regressions" launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppCaptureClient.swift launcher/TapRegressionTests.swift -framework Cocoa -framework CoreAudio -framework AVFoundation
for scenario in backlog timestamp overrun overrun-live gate banks sleep-clock callback-gaps client-clock utc-clock short-pauses; do "$TMP/tap-regressions" "$scenario"; done
# Compile the shipped, windowless entry point too. No launch/discovery/tap here; fake SIGTERM/end is exercised by app-audio-check.ts.
swiftc -O -target arm64-apple-macosx26.0 -o "$TMP/hearalong-capture" launcher/capture-main.swift launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppCaptureClient.swift -framework CoreAudio -framework AVFoundation
