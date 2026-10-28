import Foundation

private struct CaptureCommand: Decodable {
    let app: AudioApp
    let meetingId: String
    let recordingId: String
    let source: String
    let pageId: String
    let clockStart: Double
    let stopping: Bool
}
private struct UploadFrame {
    let bytes: Data
    let sequence: Int
    let samplesBefore: Int
    let wallMs: Double
}

/** Main-queue owner of capture, framing and one ordered, bounded upload queue. */
final class AppCaptureClient {
    private let base: URL
    private let origin: String
    private let input: AppAudioInput
    private let session: URLSession
    private var command: CaptureCommand?
    private var finished: [String: [String: Any]] = [:]
    private var reportingEnd = false
    private var stoppingInput = false
    private var receiving = false
    private var stopScheduled = false
    private var pending: [UploadFrame] = []
    private var tail: [Float] = []
    private var sequence = 0
    private var sampleCount = 0
    private var timeline: AppTimeline?
    private var uploading = false
    private var ending = false
    private var endSent = false
    private var deadline: Date?
    private var failed = false
    private var message: String?
    private var noticeSent = false
    private var sound = false
    private var began = Date()
    private var lastList = Date.distantPast
    private var announced = false
    private var lastServer = Date()
    private var finishCallbacks: [() -> Void] = []

    init(base: URL, origin: String, input: AppAudioInput, session: URLSession = .shared) { self.base = base; self.origin = origin; self.input = input; self.session = session }
    func poll(_ json: [String: Any]) {
        lastServer = Date()
        if !announced || (json["appList"] as? Bool == true && Date().timeIntervalSince(lastList) >= 0.8) {
            announced = true; lastList = Date()
            let apps = (json["appList"] as? Bool == true ? try? input.apps() : nil) ?? []
            post("api/live/apps", value: ["available": input.available, "apps": apps.map { ["id": $0.id, "name": $0.name] }]) { _, _ in }
        }
        if let value = json["appCapture"], !(value is NSNull), let data = try? JSONSerialization.data(withJSONObject: value), let request = try? JSONDecoder().decode(CaptureCommand.self, from: data) {
            if command?.source == request.source {
                if request.stopping { stop() }
            } else if let end = finished[request.source], !reportingEnd {
                // A lost end reply, or a server that returned after the drain deadline: reconcile, never restart the tap.
                reportingEnd = true
                post("api/meetings/\(request.meetingId)/pcm/end", value: end) { [weak self] _, _ in self?.reportingEnd = false }
            } else if finished[request.source] == nil && command == nil {
                start(request)
            }
        } else if command != nil { stop() }
        if command != nil && !ending && !noticeSent && !sound && Date().timeIntervalSince(began) >= 15 {
            noticeSent = true
            let name = command!.app.name
            post("api/live/app-capture/notice", value: ["source": command!.source, "message": "No sound from \(name) yet. If the call is playing, allow HearAlong in System Settings › Privacy & Security › Screen & System Audio Recording."]) { _, _ in }
        }
    }
    func disconnected() {
        announced = false
        if command != nil && Date().timeIntervalSince(lastServer) >= 3 { stop(message: "The server disconnected; call capture stopped.") }
    }
    private func start(_ request: CaptureCommand) {
        command = request; ending = false; endSent = false; failed = false; message = nil; deadline = nil
        pending = []; tail = []; sequence = 0; sampleCount = 0; timeline = nil; sound = false; noticeSent = false; began = Date()
        if request.stopping { stop(); return }
        do {
            try input.start(app: request.app, receive: { [weak self] samples, firstWallMs in
                guard let self, !self.ending, !self.failed else { return }
                self.receiving = true
                defer { self.receiving = false }
                self.timeline = self.timeline ?? AppTimeline(clockStart: request.clockStart, firstWallMs: firstWallMs)
                if AudioPipeline.rms(samples) >= 0.001 { self.sound = true }
                self.tail.append(contentsOf: samples)
                while self.tail.count >= 16000 {
                    let frame = Array(self.tail.prefix(16000)); self.tail.removeFirst(16000)
                    self.enqueue(frame)
                }
            }, ended: { [weak self] reason in self?.stop(message: reason) })
        } catch { stop(message: "\(request.app.name) capture could not start: \(error). The microphone keeps recording.") }
    }
    private func enqueue(_ samples: [Float]) {
        guard !samples.isEmpty, !failed else { return }
        guard pending.count < 30 else {
            failed = true; pending = []
            scheduleStop(message: "Call audio saving fell 30 s behind; this source stopped.")
            return
        }
        let data = samples.withUnsafeBytes { Data($0) }
        pending.append(UploadFrame(bytes: data, sequence: sequence, samplesBefore: sampleCount, wallMs: (timeline?.firstWallMs ?? Date().timeIntervalSince1970 * 1000) + Double(sampleCount) * 1000 / 16000))
        sequence += 1; sampleCount += samples.count
        pump()
    }
    private func scheduleStop(message: String?) {
        if let message, self.message == nil { self.message = message }
        guard !stopScheduled, let source = command?.source else { return }
        stopScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self, self.command?.source == source else { return }
            self.stopScheduled = false; self.stop()
        }
    }
    func stop(message: String? = nil, completion: (() -> Void)? = nil) {
        if let completion { finishCallbacks.append(completion) }
        if let message, self.message == nil { self.message = message }
        guard command != nil else { complete(); return }
        if receiving { scheduleStop(message: message); return }
        guard !ending, !stoppingInput else { return }
        stoppingInput = true
        // Stop first, while receive still accepts the converter's last partial buffer.
        input.stop()
        stoppingInput = false
        ending = true; deadline = Date().addingTimeInterval(30)
        let final = tail; tail = []; enqueue(final)
        pump()
    }
    private func pump() {
        guard !uploading, let command else { return }
        guard let frame = pending.first, !failed else { if ending { end() }; return }
        uploading = true
        let start = timeline?.startMs(samples: frame.samplesBefore) ?? max(0, frame.wallMs - command.clockStart - Double(frame.bytes.count / 4) * 1000 / 16000)
        let headers = ["Content-Type": "application/octet-stream", "X-Audio-Source": command.source, "X-Sequence": String(frame.sequence), "X-Sample-Rate": "16000", "X-Start-Ms": String(start), "X-Clock-Start": String(command.clockStart), "X-Recording": command.recordingId, "X-Page": command.pageId, "X-Pending": String(pending.count), "X-Capture-Wall-Ms": String(frame.wallMs), "X-Capture-Settings": String(data: try! JSONSerialization.data(withJSONObject: ["kind": "app", "app": command.app.name]), encoding: .utf8)!]
        retry(path: "api/meetings/\(command.meetingId)/pcm", bytes: frame.bytes, headers: headers) { [weak self] json, error in
            guard let self else { return }
            self.uploading = false
            if let error {
                self.failed = true; self.pending = []
                self.stop(message: "\(command.app.name) audio could not be saved (\(error)); the microphone keeps recording.")
            } else {
                if !self.pending.isEmpty { self.pending.removeFirst() }
                if json?["stop"] as? Bool == true || json?["quit"] as? Bool == true { self.stop() }
            }
            self.pump()
        }
    }
    private func end() {
        guard !endSent, let command else { return }
        endSent = true
        // Like the page, ending gets its own bounded confirmation attempt after the shared audio drain.
        deadline = Date().addingTimeInterval(10)
        var value: [String: Any] = ["source": command.source, "lastSequence": failed || sequence == 0 ? NSNull() : sequence - 1, "stopping": message == nil]
        if let message { value["message"] = message }
        let bytes = try! JSONSerialization.data(withJSONObject: value)
        let endValue = value
        retry(path: "api/meetings/\(command.meetingId)/pcm/end", bytes: bytes, headers: ["Content-Type": "application/json", "X-Page": command.pageId]) { [weak self] _, _ in
            guard let self else { return }
            self.finished[command.source] = endValue; self.command = nil; self.complete()
        }
    }
    private func complete() { let callbacks = finishCallbacks; finishCallbacks = []; callbacks.forEach { $0() } }
    private func post(_ path: String, value: [String: Any], completion: @escaping ([String: Any]?, String?) -> Void) {
        request(path: path, bytes: try! JSONSerialization.data(withJSONObject: value), headers: ["Content-Type": "application/json"], timeout: 2) { json, error, _ in completion(json, error) }
    }
    /** Same 30 s budget, 10 s attempts, first three chances, 500/1000/2000/4000 ms backoff as uploadWithRetry. */
    private func retry(path: String, bytes: Data, headers: [String: String], started: Date = Date(), failures: Int = 0, completion: @escaping ([String: Any]?, String?) -> Void) {
        let left = 30 - Date().timeIntervalSince(started), drain = deadline?.timeIntervalSinceNow ?? .infinity
        if drain <= 0 || (left <= 0 && failures >= 3) { completion(nil, "saving deadline reached"); return }
        request(path: path, bytes: bytes, headers: headers, timeout: min(drain, failures < 3 ? 10 : min(10, left))) { [weak self] json, error, status in
            guard let self else { return }
            guard let error else { completion(json, nil); return }
            if let status, !(500..<600).contains(status) { completion(nil, error); return }
            let remaining = 30 - Date().timeIntervalSince(started), drain = self.deadline?.timeIntervalSinceNow ?? .infinity
            if drain <= 0 || (remaining <= 0 && failures + 1 >= 3) { completion(nil, error); return }
            let wait = min(0.5 * pow(2, Double(min(failures, 3))), drain, remaining > 0 ? remaining : .infinity)
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { self.retry(path: path, bytes: bytes, headers: headers, started: started, failures: failures + 1, completion: completion) }
        }
    }
    private func request(path: String, bytes: Data, headers: [String: String], timeout: Double, completion: @escaping ([String: Any]?, String?, Int?) -> Void) {
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: max(0.01, timeout))
        request.httpMethod = "POST"; request.httpShouldHandleCookies = true; request.httpBody = bytes
        request.setValue(origin, forHTTPHeaderField: "Origin")
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        session.dataTask(with: request) { data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let problem = error?.localizedDescription ?? ((status ?? 0) >= 200 && (status ?? 0) < 300 ? nil : json?["error"] as? String ?? "HTTP \(status ?? 0)")
            DispatchQueue.main.async { completion(json, problem, status) }
        }.resume()
    }
}
