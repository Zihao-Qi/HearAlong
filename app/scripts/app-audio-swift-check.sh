#!/bin/sh
# Pure conversion/framing/grouping/timeline tests. No helper launch, Core Audio discovery, process tap, or TCC calls.
set -eu
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swiftc -O -o "$TMP/pipeline-tests" launcher/AudioPipeline.swift launcher/PipelineTests.swift -framework AVFoundation
"$TMP/pipeline-tests" "$TMP"
swiftc -O -DAPP_AUDIO_TESTING -o "$TMP/app-audio-tests" launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppAudioTests.swift -framework Cocoa -framework CoreAudio -framework AVFoundation
"$TMP/app-audio-tests"
swiftc -O -DAPP_AUDIO_TESTING -o "$TMP/tap-regressions" launcher/AudioPipeline.swift launcher/AppAudio.swift launcher/AppCaptureClient.swift launcher/TapRegressionTests.swift -framework Cocoa -framework CoreAudio -framework AVFoundation
for scenario in backlog timestamp overrun overrun-live gate banks; do "$TMP/tap-regressions" "$scenario"; done
