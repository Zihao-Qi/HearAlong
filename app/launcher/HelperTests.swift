import Cocoa

struct HelperTests {
    static func main() throws {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            precondition(condition(), message)
            checks += 1
        }
        func status(_ kind: String? = "notes", title: String? = "Weekly sync", label: String? = "Writing notes for Weekly sync", page: Bool = false, working: Bool = true) -> BackgroundStatus {
            BackgroundStatus(pageOpen: page, working: working, label: label, kind: kind, title: title)
        }
        check(backgroundLabel(status()) == "Writing notes for Weekly sync", "server's chosen label")
        for label: String? in [nil, "", " \n"] {
            check(backgroundLabel(status(label: label)) == "Finishing work in the background", "neutral fallback")
        }
        for owned in [false, true] {
            for page in [false, true] {
                for working in [false, true] {
                    check(backgroundVisible(status(page: page, working: working), owned: owned) == (owned && !page && working), "background-only visibility")
                }
            }
        }
        let notes = backgroundQuitText(status())
        check(notes.title == "Quit while notes are being written?", "exact mockup title")
        check(notes.text == "The notes for Weekly sync stop now. You can write them again from the Notes tab.", "exact mockup explanation")
        let plans = backgroundQuitText(status("plans"))
        check(plans.title == "Quit while plans are being made?", "plans title")
        check(plans.text == "The plans for Weekly sync stop now. You can make them again from the Plans tab.", "plans retry")
        let titles = [
            "actions": "Quit while answers are being written?",
            "transcription": "Quit while audio is being transcribed?",
            "import": "Quit while audio is being imported?",
            "download": "Quit while the speech model is being downloaded?",
            "memory": "Quit while memory is being updated?",
            "board": "Quit while the Board is being scanned?",
            "corrections": "Quit while the transcript is being corrected?",
            "glossary": "Quit while the glossary is being built?",
            "recording": "Quit while audio is being recorded?",
            "replay": "Quit while audio is being replayed?",
            "unknown": "Quit while work is running?",
        ]
        for (kind, title) in titles {
            let alert = backgroundQuitText(status(kind))
            check(alert.title == title, "matching work noun: \(kind)")
            check(alert.text == "This work stops now.", "no unsupported retry promise: \(kind)")
        }
        check(backgroundQuitText(status(nil)).title == "Quit while work is running?", "unknown kind")
        check(backgroundQuitText(status(title: nil)).text.contains("for this meeting stop now."), "missing title")
        check(backgroundQuitText(status(title: String(repeating: "🎵", count: 60))).text.contains(String(repeating: "🎵", count: 39) + "…"), "truncate by characters")
        let decoded = try JSONDecoder().decode(BackgroundStatus.self, from: Data(#"{"pageOpen":false,"working":true,"label":"Writing notes for Weekly sync","kind":"notes","title":"Weekly sync"}"#.utf8))
        check(backgroundLabel(decoded) == backgroundLabel(status()), "endpoint decoding")
        print("PASS helper wording and visibility: \(checks) checks (no app launch)")
    }
}
