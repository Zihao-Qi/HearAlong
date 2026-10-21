// Draws the HearAlong icon: a shadowed paper tile with three grey notebook lines and five blue-to-teal audio bars.
// Usage: swift scripts/make-icons.swift public/icons   (writes icon-192.png, icon-512.png and icon-1024.png)
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "public/icons"
func draw(_ size: CGFloat) -> Data {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4,
                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!.retagging(with: .sRGB)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  NSGraphicsContext.current!.cgContext.clear(CGRect(x: 0, y: 0, width: size, height: size))
  let s = size / 1024
  // SVG coordinates are top-down; AppKit coordinates are bottom-up.
  let body = NSBezierPath(roundedRect: NSRect(x: 100 * s, y: (1024 - 924) * s, width: 824 * s, height: 824 * s),
                          xRadius: 186 * s, yRadius: 186 * s)
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowOffset = NSSize(width: 0, height: -14 * s)
  // Core Graphics' blur radius is twice the SVG Gaussian standard deviation.
  shadow.shadowBlurRadius = 40 * s
  shadow.shadowColor = NSColor(srgbRed: 0x0B / 255, green: 0x1B / 255, blue: 0x3A / 255, alpha: 0.28)
  shadow.set()
  NSColor.white.setFill()
  body.fill()
  NSGraphicsContext.restoreGraphicsState()
  NSGradient(starting: NSColor(srgbRed: 0xEE / 255, green: 0xF1 / 255, blue: 0xF5 / 255, alpha: 1),
             ending: .white)!.draw(in: body, angle: 90)

  NSColor(srgbRed: 0xC9 / 255, green: 0xCE / 255, blue: 0xD8 / 255, alpha: 1).setFill()
  for (y, endX): (CGFloat, CGFloat) in [(331.5, 742), (495.5, 742), (659.5, 384)] {
    NSBezierPath(roundedRect: NSRect(x: (282 - 42) * s, y: (1024 - y - 42) * s,
                                   width: (endX - 282 + 84) * s, height: 84 * s),
                 xRadius: 42 * s, yRadius: 42 * s).fill()
  }

  // Clip one user-space gradient to the round-capped bars, including its clamped end colour.
  let bars = NSBezierPath()
  for (x, y1, y2): (CGFloat, CGFloat, CGFloat) in [
    (494, 637.5, 681.5), (559.5, 595.5, 723.5), (625, 617.5, 701.5),
    (690.5, 584.5, 734.5), (756, 626.5, 692.5)
  ] {
    bars.append(NSBezierPath(roundedRect: NSRect(x: (x - 20) * s, y: (1024 - y2 - 20) * s,
                                               width: 40 * s, height: (y2 - y1 + 40) * s),
                             xRadius: 20 * s, yRadius: 20 * s))
  }
  NSGraphicsContext.saveGraphicsState()
  bars.addClip()
  NSGradient(starting: NSColor(srgbRed: 0x4B / 255, green: 0x82 / 255, blue: 0xF7 / 255, alpha: 1),
             ending: NSColor(srgbRed: 0x17 / 255, green: 0xA3 / 255, blue: 0xA0 / 255, alpha: 1))!
    .draw(from: NSPoint(x: 282 * s, y: 0), to: NSPoint(x: 742 * s, y: 0),
          options: [.drawsBeforeStartingLocation, .drawsAfterEndingLocation])
  NSGraphicsContext.restoreGraphicsState()
  NSGraphicsContext.restoreGraphicsState()
  return rep.representation(using: .png, properties: [:])!
}
for size in [192, 512, 1024] {
  try! draw(CGFloat(size)).write(to: URL(fileURLWithPath: "\(out)/icon-\(size).png"))
}
print("Icons written to \(out)")
