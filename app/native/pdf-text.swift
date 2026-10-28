// Prints the text of a PDF as JSON, page by page, with macOS's PDFKit (src/pdf-text.ts compiles and runs it).
// Usage: pdf-text <file.pdf> <max pages> <max characters>. Pages past either limit are left out; "pageCount" is the whole PDF's.
import Foundation
import PDFKit

let args = CommandLine.arguments
func fail(_ message: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}
guard args.count == 4, let maxPages = Int(args[2]), let maxChars = Int(args[3]) else { fail("usage: pdf-text <file.pdf> <max pages> <max characters>", 64) }
guard let document = PDFDocument(url: URL(fileURLWithPath: args[1])) else { fail("not a readable PDF", 65) }
if document.isLocked { fail("the PDF is password-protected", 66) }
var pages: [String] = []
var chars = 0
for index in 0..<min(document.pageCount, maxPages) {
  // A scanned page has no text layer: it comes out empty.
  let text = document.page(at: index)?.string ?? ""
  if chars + text.count > maxChars { break }
  pages.append(text)
  chars += text.count
}
let data = try! JSONSerialization.data(withJSONObject: ["pageCount": document.pageCount, "pages": pages])
FileHandle.standardOutput.write(data)
