// Minimal native boundary extracted from Data Grid's StpBounce.swift (5f3823488).
// No activation, AXRaise, HID input, or user-Safari targeting.
import AppKit
import ApplicationServices
import ImageIO
import UniformTypeIdentifiers
import Darwin
let bundle = "com.apple.SafariTechnologyPreview"
NSApplication.shared.setActivationPolicy(.prohibited)
func out(_ value: Any) { print(String(data: try! JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8)!); fflush(stdout) }
func front() -> [String: Any] { let app = NSWorkspace.shared.frontmostApplication; return ["pid": app?.processIdentifier ?? 0, "bundle": app?.bundleIdentifier ?? ""] }
func owned(_ pid: Int32) -> NSRunningApplication { guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == bundle else { fputs("Target is not STP\n", stderr); exit(1) }; return app }
let args = CommandLine.arguments
switch args[1] {
case "preflight":
  out(["accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess()])
case "front": out(front())
case "pids": out(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).map { $0.processIdentifier })
case "watch":
  // Subscribe before announcing readiness; notifications retain brief activations
  // that a periodic sample could miss.
  let observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { notification in
    if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication { out(["pid": app.processIdentifier, "bundle": app.bundleIdentifier ?? ""]) }
  }
  out(front()); out(["ready": true]); RunLoop.current.run()
  NSWorkspace.shared.notificationCenter.removeObserver(observer)
case "open":
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.activates = false
  configuration.createsNewApplicationInstance = true
  configuration.arguments = ["-ApplePersistenceIgnoreState", "YES"]
  let before = Set(NSRunningApplication.runningApplications(withBundleIdentifier: bundle).map { $0.processIdentifier })
  var finished = false, failed = false
  NSWorkspace.shared.open([URL(string: args[2])!], withApplicationAt: URL(fileURLWithPath: "/Applications/Safari Technology Preview.app"), configuration: configuration) { app, error in
    if let app = app, error == nil, app.bundleIdentifier == bundle, !before.contains(app.processIdentifier) { out(app.processIdentifier) }
    else { fputs("Background STP launch did not return a new owned process\n", stderr); failed = true }
    finished = true
  }
  let deadline = Date().addingTimeInterval(20)
  while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
  guard finished else { fputs("Background STP launch completion timed out; ownership unavailable\n", stderr); exit(1) }
  if failed { exit(1) }
case "place":
  let pid = Int32(args[2])!; _ = owned(pid)
  var windows: CFTypeRef?
  AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &windows)
  guard let window = (windows as? [AXUIElement])?.first else { exit(1) }
  let screen = NSScreen.screens[0]
  var size = CGSize(width: Double(args[3])!, height: Double(args[4])!)
  // Match the canonical harness: leave a 20-point band below maximized owner windows.
  let bottom = min(screen.frame.height, screen.frame.height - screen.visibleFrame.minY + 20)
  var point = CGPoint(x: 80, y: bottom - size.height)
  let moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, AXValueCreate(.cgPoint, &point)!)
  let sized = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, AXValueCreate(.cgSize, &size)!)
  guard moved == .success && sized == .success else { exit(1) }; out(true)
case "window":
  let pid = Int32(args[2])!; _ = owned(pid)
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  let ours = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
  guard let w = ours.max(by: { a, b in
    let x = a[kCGWindowBounds as String] as! [String: Double], y = b[kCGWindowBounds as String] as! [String: Double]
    return x["Width"]! * x["Height"]! < y["Width"]! * y["Height"]!
  }) else { exit(1) }
  out(["id": w[kCGWindowNumber as String]!, "bounds": w[kCGWindowBounds as String]!])
case "crop":
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[2]) as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else { exit(1) }
  let outerW = Double(args[4])!, outerH = Double(args[5])!, innerW = Double(args[6])!, innerH = Double(args[7])!
  let scale = Double(image.width) / outerW
  let rect = CGRect(x: ((outerW - innerW) / 2 * scale).rounded(), y: ((outerH - innerH) * scale).rounded(), width: (innerW * scale).rounded(), height: (innerH * scale).rounded())
  guard rect.minX >= 0, rect.minY >= 0, rect.maxX <= Double(image.width), rect.maxY <= Double(image.height), let cropped = image.cropping(to: rect), let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: args[3]) as CFURL, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
  CGImageDestinationAddImage(dest, cropped, nil); guard CGImageDestinationFinalize(dest) else { exit(1) }; out(true)
case "quit":
  let app = owned(Int32(args[2])!); _ = app.terminate()
  let end = Date().addingTimeInterval(5)
  while !app.isTerminated && Date() < end { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
  if !app.isTerminated {
    guard app.forceTerminate() else { fputs("STP force termination refused\n", stderr); exit(1) }
    let forcedEnd = Date().addingTimeInterval(5)
    while !app.isTerminated && Date() < forcedEnd { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
  }
  guard app.isTerminated else { fputs("STP did not exit after termination\n", stderr); exit(1) }
  out(true)
default: exit(1)
}
