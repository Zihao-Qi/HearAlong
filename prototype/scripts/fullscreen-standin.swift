// A stand-in for a call app in native full screen (scripts/native-mini-check.ts --fullscreen): it opens a window, makes it full
// screen (its own Space), then reports whether a window of the given process (the helper's mini window) is on screen and in front
// of it, and leaves full screen again. Window owners and order need no permission (window titles would).
// Usage: swiftc -o <out> scripts/fullscreen-standin.swift && <out> <helper pid>
import Cocoa

guard CommandLine.arguments.count > 1, let pid = Int(CommandLine.arguments[1]) else { print("{\"error\":\"give the helper's pid\"}"); exit(2) }

final class StandIn: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let helperPid: Int
    init(helperPid: Int) { self.helperPid = helperPid }
    let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 800, height: 500), styleMask: [.titled, .resizable, .closable], backing: .buffered, defer: false)
    var result: [String: Any] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "Full-screen stand-in"
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.window.toggleFullScreen(nil) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { self.finish(["error": "did not enter full screen"]) } // never stays
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
            let me = Int(ProcessInfo.processInfo.processIdentifier)
            let owner = { (w: [String: Any]) in w[kCGWindowOwnerPID as String] as? Int ?? -1 }
            let helperIndex = list.firstIndex { owner($0) == self.helperPid && ($0[kCGWindowLayer as String] as? Int ?? 0) > 0 }
            let myIndex = list.firstIndex { owner($0) == me && ($0[kCGWindowLayer as String] as? Int ?? -1) == 0 }
            self.result = ["fullScreen": self.window.styleMask.contains(.fullScreen), "helperOnScreen": helperIndex != nil,
                           "helperInFront": helperIndex != nil && myIndex != nil && helperIndex! < myIndex!, "standInOnScreen": myIndex != nil]
            self.window.toggleFullScreen(nil)
        }
    }

    func windowDidExitFullScreen(_ notification: Notification) { finish(result) }

    func finish(_ out: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: out) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write("\n".data(using: .utf8)!) }
        exit(0)
    }
}

let app = NSApplication.shared
let standIn = StandIn(helperPid: pid)
app.delegate = standIn
app.setActivationPolicy(.regular)
app.run()
