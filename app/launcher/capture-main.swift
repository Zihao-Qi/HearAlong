import Foundation
import Darwin

/** Capture only: no application, window or WebKit lifecycle. All capture state stays on the main queue. */
@main struct CaptureMain {
    static func main() {
        let args = CommandLine.arguments
        guard args.count == 4, let base = URL(string: args[1]), base.scheme == "http", base.host == "127.0.0.1",
              let group = Int32(args[3]), group > 0 else {
            fputs("Usage: hearalong-capture BASE_URL ORIGIN SERVER_GROUP\n", stderr)
            exit(1)
        }
        let runner = CaptureRunner(base: base, origin: args[2], serverGroup: group)
        runner.start()
        withExtendedLifetime(runner) { RunLoop.main.run() }
    }
}

private final class CaptureRunner {
    private let base: URL
    private let origin: String
    private let capture: AppCaptureClient
    private var timer: Timer?
    private var signals: [DispatchSourceSignal] = []
    private var asking = false
    private var quitting = false

    init(base: URL, origin: String, serverGroup: pid_t) {
        self.base = base; self.origin = origin
        capture = AppCaptureClient(base: base, origin: origin, input: makeAppAudioInput(serverGroup: serverGroup, log: { fputs("\($0)\n", stderr) }))
    }
    func start() {
        for number in [SIGTERM, SIGINT] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume(); signals.append(source)
        }
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common); self.timer = timer
        poll()
    }
    private func stop() {
        guard !quitting else { return }
        quitting = true; timer?.invalidate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { exit(0) }
        capture.stop(message: "HearAlong quit; the microphone keeps recording.") { exit(0) }
    }
    private func poll() {
        guard !asking, !quitting else { return }
        asking = true
        var request = URLRequest(url: base.appendingPathComponent("api/live/capture"), timeoutInterval: 2)
        request.httpShouldHandleCookies = true
        request.setValue(origin, forHTTPHeaderField: "Origin")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.asking = false
                guard error == nil, status == 200, let json else {
                    self.capture.disconnected()
                    if status == 403 { self.renewSession() }
                    return
                }
                self.capture.poll(json)
            }
        }.resume()
    }
    private func renewSession() {
        asking = true
        var request = URLRequest(url: base, timeoutInterval: 2)
        request.httpShouldHandleCookies = true
        request.setValue(origin, forHTTPHeaderField: "Origin")
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in
            DispatchQueue.main.async { self?.asking = false }
        }.resume()
    }
}
