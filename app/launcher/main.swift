// HearAlong Helper.app (M7, docs/design/M7-desktop.md §5): the invisible part of the installed app. The assistant itself
// is Chrome's installed web app "HearAlong" (its own Dock icon and Cmd+Tab entry). When its window opens and the local server
// is not running, the window's "Starting…" page opens meetingassistant://start, macOS starts this helper, and the helper starts the
// server. The server stops by itself once the window has been closed for a while and nothing is running; the helper then ends too.
// Opened directly (Finder), the helper starts the server and opens the app (or, before it is installed, a Chrome tab to install it).
// While a recording runs, it also shows the mini view in a native floating window that stays over every app, on every desktop,
// including apps in full screen (docs/design/M7-native-mini.md).
// No Dock icon (accessory app). Built from source by scripts/build-app.sh; nothing is installed.
import Cocoa
import WebKit

struct Config: Decodable {
    let node: String        // absolute path, recorded at build time (an app opened from Finder has no shell PATH)
    let path: String        // the PATH of the shell that built the app, for the tools the server starts (pi, uv, ffmpeg)
    let app: String         // the repo's app/ folder: the server's working directory
    let port: Int
    let data: String?      // installer-owned data directory, independent of the replaceable code

    private enum CodingKeys: String, CodingKey { case node, path, app, prototype, port, data }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        node = try values.decode(String.self, forKey: .node)
        path = try values.decode(String.self, forKey: .path)
        // Keep reading launcher.json files written before the folder rename.
        app = try values.decodeIfPresent(String.self, forKey: .app) ?? values.decode(String.self, forKey: .prototype)
        port = try values.decode(Int.self, forKey: .port)
        data = try values.decodeIfPresent(String.self, forKey: .data)
    }
}

final class Helper: NSObject, NSApplicationDelegate {
    private var config: Config!
    private var serverPid: pid_t = 0     // also its process group: every child the server starts is in it
    private var owned = false            // false when a server was already running (npm start): never stopped by the helper
    private var serverExited = false     // set on the main queue once the server has exited and been reaped: its pid is free again
    private var starting = false
    private var quitting = false
    private var openedByURL = false
    private var signalSource: DispatchSourceSignal?
    private let env = ProcessInfo.processInfo.environment
    private var mini: MiniWindow?
    private var activity: NSObjectProtocol? // keeps App Nap from slowing the mini window's checks while the server runs

    private var port: Int { Int(env["MEETING_LAUNCHER_PORT"] ?? "") ?? config.port }
    private var base: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    private var dataURL: URL {
        (env["MEETING_DATA_DIR"] ?? config.data).map { URL(fileURLWithPath: $0).standardizedFileURL }
            ?? URL(fileURLWithPath: config.app).appendingPathComponent("data")
    }
    private var logURL: URL { dataURL.appendingPathComponent("logs/launcher.log") }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Mutable launch paths live beside the signed bundle; old bundles/config files remain readable.
        let external = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("HearAlong Helper.json")
        let installed = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/HearAlong/helper.json")
        let settings = [external, installed].first { FileManager.default.fileExists(atPath: $0.path) }
            ?? Bundle.main.url(forResource: "launcher", withExtension: "json")
        guard let url = settings,
              let data = try? Data(contentsOf: url), let config = try? JSONDecoder().decode(Config.self, from: data) else {
            fail("The helper's settings are missing. Build it again with npm run build:app.")
            return
        }
        self.config = config
        // SIGTERM (logging out, or a test) stops the server gracefully, then the helper.
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { [weak self] in self?.stopAll(then: { exit(0) }) }
        source.resume()
        signalSource = source
        // A launch by the window's "Starting…" page arrives as a URL event just after this; give it a moment before treating the
        // launch as a double-click (which also opens the window).
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.ensureServer(openWindow: !self.openedByURL) }
    }

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        openedByURL = true
        if config != nil { ensureServer(openWindow: false) }
    }

    // MARK: Server

    private func ensureServer(openWindow open: Bool) {
        if starting || quitting || alive() { return }
        starting = true
        DispatchQueue.global().async {
            if self.isAssistant() {
#if APP_AUDIO_TESTING
                if self.env["HEARALONG_FAKE_APP_AUDIO"] == "1" {
                    DispatchQueue.main.async { self.starting = false; self.startMini() }
                    return
                }
#endif
                // Already running (npm start): nothing to start; the helper is not needed.
                DispatchQueue.main.async {
                    self.starting = false
                    if open { self.openWindow() }
                    NSApp.terminate(nil)
                }
                return
            }
            if self.answers() {
                DispatchQueue.main.async { self.fail("Port \(self.port) is used by another program, so HearAlong cannot start there.") }
                return
            }
            DispatchQueue.main.async { self.startServer(openWindow: open) }
        }
    }

    private func startServer(openWindow open: Bool) {
        // Check before making logs: that would create the missing data folder and hide the server's notice.
        let root = URL(fileURLWithPath: config.app).standardizedFileURL
        let data = dataURL
        let legacy = root.deletingLastPathComponent().appendingPathComponent("prototype/data")
        if data == root.appendingPathComponent("data"),
           !FileManager.default.fileExists(atPath: data.path), FileManager.default.fileExists(atPath: legacy.path) {
            let notice = "Your meetings are still in prototype/data — move that folder to app/data, then restart"
            if env["MEETING_LAUNCHER_NO_WINDOW"] != "1" { FileHandle.standardError.write("\(notice)\n".data(using: .utf8)!) }
            fail(notice)
            return
        }
        do { try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true) } catch {}
        var actions: posix_spawn_file_actions_t? = nil
        posix_spawn_file_actions_init(&actions)
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        posix_spawn_file_actions_addopen(&actions, 1, logURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)
        posix_spawn_file_actions_addchdir(&actions, config.app)
        var attributes: posix_spawnattr_t? = nil
        posix_spawnattr_init(&attributes)
        // Its own process group, so stopping can end everything the server started, including what its children started.
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        posix_spawnattr_setpgroup(&attributes, 0)
        var environment = env
        environment["PATH"] = config.path
        environment["PORT"] = String(port)
        environment["MEETING_DATA_DIR"] = data.path
        // The server stops by itself once no window has been open for this long and nothing is running.
        environment["MEETING_IDLE_EXIT_S"] = environment["MEETING_IDLE_EXIT_S"] ?? "20"
        let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
        let argv = [config.node, "--experimental-strip-types", "src/server.ts"].map { strdup($0) } + [nil]
        let status = posix_spawn(&serverPid, config.node, &actions, &attributes, argv, envp)
        argv.forEach { free($0) }
        envp.forEach { free($0) }
        posix_spawn_file_actions_destroy(&actions)
        posix_spawnattr_destroy(&attributes)
        guard status == 0 else { fail("The server could not start (\(String(cString: strerror(status)))). Node: \(config.node)"); return }
        owned = true
        let pid = serverPid
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(60)
            while Date() < deadline {
                if self.isAssistant() { DispatchQueue.main.async { self.starting = false; self.startMini(); if open && self.alive() { self.openWindow() } }; return }
                if !self.aliveNow() { return } // its exit is reported below
                Thread.sleep(forTimeInterval: 0.5)
            }
            DispatchQueue.main.async { if self.alive() { self.fail("The server did not answer within 60 s.", details: self.logTail()) } }
        }
        // The server ending: by itself when idle (exit 0) the helper ends quietly; otherwise it says what the server last wrote.
        DispatchQueue.global().async {
            var code: Int32 = 0
            while waitpid(pid, &code, 0) == -1 && errno == EINTR {}
            DispatchQueue.main.async {
                self.serverExited = true
                if self.quitting { return }
                let normal = (code & 0x7f) == 0 && ((code >> 8) & 0xff) == 0
                if normal { self.stopAll(then: { exit(0) }) }
                else { self.fail("The server stopped unexpectedly.", details: self.logTail()) }
            }
        }
    }

    private func alive() -> Bool { serverPid > 0 && !serverExited }
    private func aliveNow() -> Bool { DispatchQueue.main.sync { alive() } }

    /** Something answers GET / on the port (which also gives the session cookie the API needs). */
    private func answers() -> Bool { request(base) != nil }

    /** The program on the port is HearAlong: its status has the app's own fields. */
    private func isAssistant() -> Bool {
        guard answers(), let data = request(base.appendingPathComponent("api/status")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return json["meetings"] is [Any] && json["config"] is [String: Any]
    }

    private func request(_ url: URL) -> Data? {
        var result: Data?
        let done = DispatchSemaphore(value: 0)
        var req = URLRequest(url: url, timeoutInterval: 2)
        req.httpShouldHandleCookies = true
        URLSession.shared.dataTask(with: req) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200 { result = data }
            done.signal()
        }.resume()
        done.wait()
        return result
    }

    // MARK: The window

    /** The app Chrome made when HearAlong was installed, including its pre-rename paths. */
    private var installedApp: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        // Keep the legacy paths so existing Chrome installations still open after a helper rebuild.
        return ["Applications/Chrome Apps.localized/HearAlong.app", "Applications/Chrome Apps/HearAlong.app",
                "Applications/Chrome Apps.localized/Meeting Assistant.app", "Applications/Chrome Apps/Meeting Assistant.app"]
            .map { home.appendingPathComponent($0) }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /** The installed app if Chrome has made it, else a Chrome tab (where Chrome offers to install it). Brings an open one forward. */
    private func openWindow() {
        if env["MEETING_LAUNCHER_NO_WINDOW"] == "1" { return }
        if let app = installedApp { NSWorkspace.shared.open(app); return }
        guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            fail("Google Chrome is needed: HearAlong runs as a Chrome app. Install Chrome, then open HearAlong Helper again.")
            return
        }
        NSWorkspace.shared.open([base], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { DispatchQueue.main.async { self.warn("Chrome could not open HearAlong.", error.localizedDescription) } }
        }
    }

    // MARK: The mini window

    private func startMini() {
        guard mini == nil else { return }
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "HearAlong is running")
        let testDir = env["MEETING_HELPER_TEST_DIR"].map { URL(fileURLWithPath: $0) }
        let captureLog = logURL
        let audio = makeAppAudioInput(serverGroup: serverPid, log: { text in try? "[\(ISO8601DateFormatter().string(from: Date()))] \(text)\n".append(to: captureLog) })
        mini = MiniWindow(base: base, origin: "http://127.0.0.1:\(port)", testDir: testDir, audioInput: audio,
                          isAssistantApp: { [weak self] app in self?.isHearAlong(app) ?? false },
                          activateApp: { [weak self] in
                              guard let self else { return }
                              if let dir = testDir { try? "activate\n".append(to: dir.appendingPathComponent("messages.log")) }
                              self.openWindow()
                          })
        mini?.start()
    }

    /** Whether an app is HearAlong: the installed app, or Chrome when it runs in a tab (no installed app). */
    private func isHearAlong(_ app: NSRunningApplication) -> Bool {
        if app.processIdentifier == ProcessInfo.processInfo.processIdentifier { return true }
        if let installed = installedApp?.resolvingSymlinksInPath().path, app.bundleURL?.resolvingSymlinksInPath().path == installed { return true }
        if let test = env["MEETING_HELPER_APP_BUNDLE_ID"], app.bundleIdentifier == test { return true } // the checks' stand-in app
        return installedApp == nil && app.bundleIdentifier == "com.google.Chrome"
    }

    private func warn(_ message: String, _ details: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = details
        alert.runModal()
    }

    // MARK: Stopping

    /**
     * The server stops gracefully (a recording page stops first, up to 20 s); if it is still there after 30 s, its group is ended.
     * Then anything left in its group gets SIGTERM, and SIGKILL 5 s later, so nothing the helper started outlives it.
     */
    private func stopAll(then finish: @escaping () -> Void) {
        if quitting { return }
        quitting = true
        if let mini { mini.stop { self.stopServer(then: finish) } }
        else { stopServer(then: finish) }
    }

    private func stopServer(then finish: @escaping () -> Void) {
        guard owned, serverPid > 0 else { finish(); return }
        let pid = serverPid
        // The leader is signalled only while it has not been reaped (its pid cannot belong to anything else until then). The group
        // is signalled only while it has members: a pid stays reserved while it is still a process group's id.
        if !serverExited { kill(pid, SIGTERM) }
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(30)
            while self.aliveNow() && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
            if killpg(pid, 0) == 0 { killpg(pid, SIGTERM) }
            let grace = Date().addingTimeInterval(5)
            while killpg(pid, 0) == 0 && Date() < grace { Thread.sleep(forTimeInterval: 0.2) }
            if killpg(pid, 0) == 0 { killpg(pid, SIGKILL) }
            DispatchQueue.main.async(execute: finish)
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if quitting || !owned { return .terminateNow }
        stopAll(then: { NSApp.reply(toApplicationShouldTerminate: true) })
        return .terminateLater
    }

    // MARK: Failures

    private func logTail() -> String {
        guard let text = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
        return text.split(separator: "\n", omittingEmptySubsequences: false).suffix(12).joined(separator: "\n")
    }

    private func fail(_ message: String, details: String = "") {
        let text = details.isEmpty || config == nil ? message : "\(message)\n\nLast lines of \(logURL.path):\n\(details)"
        if env["MEETING_LAUNCHER_NO_WINDOW"] != "1" { warn("HearAlong could not run", text) }
        else { FileHandle.standardError.write("\(text)\n".data(using: .utf8)!) }
        stopAll(then: { exit(1) })
    }
}

/** A floating panel that takes clicks without activating the helper (so a full-screen call keeps the focus and its Space). */
final class MiniPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

/** Takes the first click even while another app is active: Stop and the card work with one click from the call. */
final class MiniWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/**
 * The mini view in a native window: the server's /mini.html in a web view. Twice a second it asks the server whether the window
 * should show (a recording, and the window not closed by hand); it tells the server when the user leaves HearAlong (the
 * window then opens by itself, once per recording) and when the user closes it.
 */
final class MiniWindow: NSObject, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let base: URL
    private let origin: String
    private let testDir: URL?
    private let isAssistantApp: (NSRunningApplication) -> Bool
    private let activateApp: () -> Void
    private var panel: MiniPanel?
    private var web: MiniWebView?
    private var timer: Timer?
    private var session: Int?
    private var shown = false
    private var asking = false
    private var observer: NSObjectProtocol?
    private let appCapture: AppCaptureClient

    init(base: URL, origin: String, testDir: URL?, audioInput: AppAudioInput, isAssistantApp: @escaping (NSRunningApplication) -> Bool, activateApp: @escaping () -> Void) {
        self.base = base; self.origin = origin; self.testDir = testDir; self.isAssistantApp = isAssistantApp; self.activateApp = activateApp
        self.appCapture = AppCaptureClient(base: base, origin: origin, input: audioInput)
    }

    func start() {
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.frontmostChanged(app)
        }
        let timer = Timer(timeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
        poll()
    }

    func stop(completion: @escaping () -> Void) {
        timer?.invalidate()
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        panel?.orderOut(nil)
        appCapture.stop(message: "The helper quit; the microphone keeps recording.", completion: completion)
    }

    // MARK: The server

    private func poll() {
        if asking { return }
        asking = true
        var request = URLRequest(url: base.appendingPathComponent("api/live/window"), timeoutInterval: 2)
        request.httpShouldHandleCookies = true
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let status = (response as? HTTPURLResponse)?.statusCode
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            DispatchQueue.main.async {
                guard let self else { return }
                self.asking = false
                if status == 403 { self.appCapture.disconnected(); self.renewSession(); return }
                guard status == 200, let json else { self.appCapture.disconnected(); return }
                self.appCapture.poll(json)
                let session = json["session"] as? Int
                let started = session != nil && session != self.session

                self.session = session
                self.show(json["show"] as? Bool == true)
                // A recording that began while another app was already in front: that is leaving the app too.
                if started, let front = NSWorkspace.shared.frontmostApplication, !self.isAssistantApp(front) { self.send(action: "away") }
                self.writeTestState()
            }
        }.resume()
    }

    /** The session cookie comes with the page: asked for again if the server no longer knows it. */
    private func renewSession() {
        var request = URLRequest(url: base, timeoutInterval: 2)
        request.httpShouldHandleCookies = true
        URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
    }

    private func send(action: String) {
        guard let session else { return }
        var request = URLRequest(url: base.appendingPathComponent("api/live/mini"), timeoutInterval: 2)
        request.httpMethod = "POST"
        request.httpShouldHandleCookies = true
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["session": session, "action": action])
        URLSession.shared.dataTask(with: request) { [weak self] _, _, _ in DispatchQueue.main.async { self?.poll() } }.resume()
    }

    private func frontmostChanged(_ app: NSRunningApplication) {
        if session != nil && !isAssistantApp(app) { send(action: "away") }
    }

    // MARK: The window

    private func show(_ visible: Bool) {
        if visible == shown { return }
        shown = visible
        if visible {
            let panel = self.panel ?? makePanel()
            panel.orderFrontRegardless() // in front without taking the focus from the app in use
            web?.evaluateJavaScript("window.miniRefresh && window.miniRefresh()", completionHandler: nil)
        } else { panel?.orderOut(nil) }
    }

    private func makePanel() -> MiniPanel {
        let panel = MiniPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 268),
                              styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "HearAlong"
        panel.level = .floating
        // On every desktop, and over apps in full screen.
        panel.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.isReleasedWhenClosed = false
        panel.contentMinSize = NSSize(width: 260, height: 200)
        panel.contentMaxSize = NSSize(width: 640, height: 640)
        panel.delegate = self
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "mini")
        let web = MiniWebView(frame: panel.contentLayoutRect, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = self
        panel.contentView = web
        web.load(URLRequest(url: base.appendingPathComponent("mini.html")))
        // Where the user left it; the first time, the top right of the screen.
        // Preserve the stored mini-window position across the rename.
        if !panel.setFrameUsingName("MeetingAssistantMini"), let screen = NSScreen.main?.visibleFrame {
            panel.setFrameTopLeftPoint(NSPoint(x: screen.maxX - panel.frame.width - 16, y: screen.maxY - 16))
        }
        panel.setFrameAutosaveName("MeetingAssistantMini")
        self.panel = panel
        self.web = web
        return panel
    }

    // A page that failed to load, or whose web process ended, is loaded again: the window never stays blank.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { reloadSoon() }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { reloadSoon() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reloadSoon() }
    private func reloadSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self, let web = self.web else { return }
            web.load(URLRequest(url: self.base.appendingPathComponent("mini.html")))
        }
    }

    /** Closed by hand: closed for the rest of this recording; the app's Mini view button opens it again. */
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        shown = false
        sender.orderOut(nil)
        send(action: "closed")
        return false
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["type"] as? String == "activate" else { return }
        activateApp()
    }

    // MARK: Checks (scripts/native-mini-check.ts): the window's state, a script run in its page, a click on its close button

    private func writeTestState() {
        guard let dir = testDir, let panel else { return }
        let behavior = panel.collectionBehavior
        let state: [String: Any] = [
            "visible": panel.isVisible, "onActiveSpace": panel.isOnActiveSpace, "level": panel.level.rawValue, "floatingLevel": NSWindow.Level.floating.rawValue,
            "allSpaces": behavior.contains(.canJoinAllSpaces), "fullScreenAuxiliary": behavior.contains(.fullScreenAuxiliary),
            "nonactivating": panel.styleMask.contains(.nonactivatingPanel), "hidesOnDeactivate": panel.hidesOnDeactivate,
            "allApplications": behavior.contains(.canJoinAllApplications), "width": panel.contentLayoutRect.width, "height": panel.contentLayoutRect.height, "helperActive": NSApp.isActive,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: dir.appendingPathComponent("panel.json"), options: .atomic) }
        let script = dir.appendingPathComponent("eval.js")
        if let source = try? String(contentsOf: script, encoding: .utf8) {
            try? FileManager.default.removeItem(at: script)
            web?.callAsyncJavaScript(source, arguments: [:], in: nil, in: .page) { result in
                let out: Any
                switch result { case .success(let value): out = ["ok": value]; case .failure(let error): out = ["error": error.localizedDescription] }
                if let data = try? JSONSerialization.data(withJSONObject: out, options: [.fragmentsAllowed]) { try? data.write(to: dir.appendingPathComponent("eval.out"), options: .atomic) }
            }
        }
        let close = dir.appendingPathComponent("close.request")
        if FileManager.default.fileExists(atPath: close.path) { try? FileManager.default.removeItem(at: close); panel.performClose(nil) }
        let snap = dir.appendingPathComponent("snapshot.request")
        if let name = try? String(contentsOf: snap, encoding: .utf8) {
            try? FileManager.default.removeItem(at: snap)
            web?.takeSnapshot(with: nil) { image, _ in
                guard let image, let tiff = image.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { return }
                try? png.write(to: dir.appendingPathComponent(name.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
        }
    }
}

extension String {
    func append(to url: URL) throws {
        if let handle = try? FileHandle(forWritingTo: url) { defer { try? handle.close() }; handle.seekToEndOfFile(); handle.write(Data(utf8)) }
        else { try write(to: url, atomically: true, encoding: .utf8) }
    }
}

let app = NSApplication.shared
let helper = Helper()
app.delegate = helper
app.setActivationPolicy(.accessory) // no Dock icon: the Dock shows the installed app
app.run()
