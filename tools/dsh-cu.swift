// dsh-cu —— 最小可用的 macOS computer use 命令行
//
// 为什么有这个东西：cua-driver（dsh-computer-use 插件依赖的原生驱动）在 macOS 26 上
// 有个未修的上游 bug —— 它的 daemon 走 AX 时永远返回 0 个 AXWindow
// （trycua/cua#4039，环境与我们完全一致）。但同一台机器上，**由 DSH 派生的进程**
// 走 AX 完全正常（本文件就是证明）。所以这里直接用系统 AX API 实现一份。
//
// 设计要点（**视觉优先**，因为这台机器上第三方二进制的 AX 是坏的）：
//   * 找窗口：CGWindowListCopyWindowInfo —— 不需要任何权限，拿到 pid + 精确 bounds
//   * 看：screencapture 截图（DSH 已有屏幕录制权限）
//   * 点：CGEvent 用 postToPid 投递给目标进程 —— **不移动真实鼠标、不抢前台**
//   * 打：CGEvent + keyboardSetUnicodeString，同样投递给目标进程（支持中文）
//   * AX 命令保留，但在本机不可靠（kAXWindowsAttribute 返回的元素角色是 AXApplication，
//     永远拿不到 AXWindow；同环境下 AppleScript 反而正常，说明是第三方二进制的 AX 被限制）
//
// 用法：
//   dsh-cu windows                     列出有窗口的应用
//   dsh-cu tree <pid> [--limit N]      打印 AX 树（带 [i] 索引）
//   dsh-cu click <pid> <i>             点第 i 个元素（AXPress，最稳）
//   dsh-cu clickat <pid> <x> <y> [--global] [--no-cursor]  按屏幕坐标点（默认不动真实鼠标；会联动浮层光标）
//   dsh-cu type <pid> <文字>           往目标进程打字（支持中文）
//   dsh-cu key <pid> <keycode> [flags] 按键（flags: cmd/shift/alt/ctrl，可组合）
//   dsh-cu find <文字> [--pid N]       OCR 找屏幕上的文字 → 输出可点的坐标
//   dsh-cu observe <pid> [--out 路径]   **set-of-mark**：截图上给可点元素编号
//   dsh-cu click-index <pid> <编号>      点编号对应的元素
//   dsh-cu scroll <pid> <x> <y> <dy> [dx]   滚轮
//   dsh-cu drag <pid> <x1> <y1> <x2> <y2>   拖拽
//   dsh-cu apps                             列出运行中的应用（* = 前台）
//   dsh-cu launch <bundleId|应用名>          后台启动应用（不抢前台）
//   dsh-cu shot [--out 路径]           截屏

import ApplicationServices
import AppKit
import Foundation
import Vision

// ── 工具函数 ────────────────────────────────────────────────────────────────

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success else { return nil }
    return out
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let pv = attr(el, kAXPositionAttribute as String),
          let sv = attr(el, kAXSizeAttribute as String) else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

/// 元素在树里的可读标签：优先 title / description / value
func label(_ el: AXUIElement) -> String {
    for k in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXRoleDescriptionAttribute] {
        if let v = str(el, k as String), !v.isEmpty { return v }
    }
    return ""
}

func appsWithWindows() -> [(pid_t, String, Int)] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app in
            let pid = app.processIdentifier
            let ax = AXUIElementCreateApplication(pid)
            let wins = (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
            guard !wins.isEmpty else { return nil }
            return (pid, app.localizedName ?? "?", wins.count)
        }
}

// ── 子命令 ──────────────────────────────────────────────────────────────────

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("用法见文件头注释") }

switch cmd {

case "winlist":
    // CGWindowList：不依赖 AX，拿得到 pid / 标题 / 精确 bounds / 层级
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in info {
        let layer = w[kCGWindowLayer as String] as? Int ?? -1
        guard layer == 0 else { continue }                      // 只看普通窗口
        let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
        let name = w[kCGWindowOwnerName as String] as? String ?? "?"
        let title = w[kCGWindowName as String] as? String ?? ""
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let wid = w[kCGWindowNumber as String] as? Int ?? 0
        print("\(pid)\t\(wid)\t\(name)\t\(title)\t\(Int(b["X"] ?? 0)),\(Int(b["Y"] ?? 0)) \(Int(b["Width"] ?? 0))×\(Int(b["Height"] ?? 0))")
    }

case "windows":
    for (pid, name, _) in appsWithWindows() {
        let ax = AXUIElementCreateApplication(pid)
        let wins = (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        for w in wins {
            let f = frame(w)
            let t = str(w, kAXTitleAttribute as String) ?? ""
            let box = f.map { "(\(Int($0.origin.x)),\(Int($0.origin.y)) \(Int($0.width))×\(Int($0.height)))" } ?? ""
            print("\(pid)\t\(name)\t\(t)\t\(box)")
        }
    }

case "tree":
    guard args.count >= 2, let pid = pid_t(args[1]) else { fail("用法: dsh-cu tree <pid>") }
    let limit = args.contains("--limit") ? Int(args[args.count - 1]) ?? 200 : 200
    var index = 0
    var seen = Set<CFHashCode>()
    let ax = AXUIElementCreateApplication(pid)
    func walk(_ el: AXUIElement, _ depth: Int) {
        guard index < limit, depth <= 20 else { return }
        let h = CFHash(el)
        if seen.contains(h) { return }          // 环检测：AX 树里有自引用
        seen.insert(h)
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        let lab = label(el)
        let f = frame(el)
        let pos = f.map { "@\(Int($0.midX)),\(Int($0.midY))" } ?? ""
        let pad = String(repeating: "  ", count: depth)
        print("[\(index)]\(pad) \(role) \(lab.isEmpty ? "" : "«\(lab.prefix(60))»") \(pos)")
        index += 1
        for c in children(el) { walk(c, depth + 1) }
    }
    // 从窗口开始 —— 从 application 走会先撞上菜单栏和自引用
    for w in (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] { walk(w, 0) }

case "click":
    guard args.count >= 3, let pid = pid_t(args[1]), let want = Int(args[2]) else { fail("用法: dsh-cu click <pid> <索引>") }
    let ax = AXUIElementCreateApplication(pid)
    var index = 0
    var target: AXUIElement?
    var seen2 = Set<CFHashCode>()
    func find(_ el: AXUIElement, _ depth: Int) {
        guard target == nil, depth <= 20 else { return }
        let h = CFHash(el)
        if seen2.contains(h) { return }
        seen2.insert(h)
        if index == want { target = el; return }
        index += 1
        for c in children(el) { find(c, depth + 1) }
    }
    for w in (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] { find(w, 0) }
    guard let el = target else { fail("没有第 \(want) 个元素") }
    var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success {
        // 没有 AXPress 就退回坐标点击
        guard let f = frame(el) else { fail("元素既不能按也没有坐标") }
        err = postClick(pid: pid, at: CGPoint(x: f.midX, y: f.midY)) ? .success : .failure
    }
    print(err == .success ? "已点击 [\(want)] \(label(el).prefix(40))" : "点击失败 (\(err.rawValue))")

case "clickat":
    guard args.count >= 4, let pid = pid_t(args[1]), let x = Double(args[2]), let y = Double(args[3]) else {
        fail("用法: dsh-cu clickat <pid> <x> <y> [--global]")
    }
    let global = args.contains("--global")
    cursorOverlayOff = args.contains("--no-cursor")
    if !cursorOverlayOff { ensureOverlay() }
    // 光标自己滑过去（弹簧 + 沿运动方向拉伸 + 点击回弹），这就是 Codex 光标的全部特效。
    // 压暗/旋转球是 Codex 别处的东西，不是光标，所以默认不出；要就设 DSH_CU_FX=full
    let fx = ProcessInfo.processInfo.environment["DSH_CU_FX"] ?? ""
    overlayPing("move \(Int(x)) \(Int(y))")
    if fx == "full" {
        overlayPing("fog on")
        overlayPing("lens \(Int(x)) \(Int(y))")
    }
    usleep(300_000)                                    // 等它滑到位再点
    overlayPing("click")
    let ok = postClick(pid: pid, at: CGPoint(x: x, y: y), global: global)
    print(ok ? "已点击 (\(Int(x)), \(Int(y)))\(global ? " [真实鼠标]" : " [投递给 pid，不动鼠标]")" : "点击失败")

case "type":
    guard args.count >= 3, let pid = pid_t(args[1]) else { fail("用法: dsh-cu type <pid> <文字>") }
    let text = args.dropFirst(2).joined(separator: " ")
    let ok = postText(pid: pid, text)
    print(ok ? "已输入 \(text.count) 个字符" : "输入失败")

case "key":
    guard args.count >= 3, let pid = pid_t(args[1]), let code = UInt16(args[2]) else { fail("用法: dsh-cu key <pid> <keycode> [cmd|shift|alt|ctrl]") }
    var flags: CGEventFlags = []
    for f in args.dropFirst(3) {
        switch f {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: break
        }
    }
    let src = CGEventSource(stateID: .hidSystemState)
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
        e?.flags = flags
        e?.postToPid(pid)
    }
    print("已按键 \(code)")

case "find":
    // OCR 找文字 → 返回屏幕坐标。这是视觉路线真正好用的关键：
    // agent 说「点『登录』」，而不是猜坐标。
    guard args.count >= 2 else { fail("用法: dsh-cu find <文字> [--pid N] [--all]") }
    let needle = args[1]
    let showAll = args.contains("--all")
    var region = CGRect(x: 0, y: 0, width: 0, height: 0)   // 0 = 全屏
    if let i = args.firstIndex(of: "--pid"), i + 1 < args.count, let pid = pid_t(args[i + 1]) {
        guard let w = windowsOf(pid).first else { fail("pid \(pid) 没有可见窗口") }
        region = w
    }
    var shotPath = "/tmp/dsh-cu-ocr-\(getpid()).png"
    if let i = args.firstIndex(of: "--file"), i + 1 < args.count {
        shotPath = args[i + 1]          // 直接对图片文件 OCR（不截屏）
        region = .zero
    } else {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        p.arguments = ["-x", shotPath]
        try? p.run(); p.waitUntilExit()
    }

    guard let img = NSImage(contentsOfFile: shotPath),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fail("截图读不出来") }
    // --file 模式是图片像素坐标；截屏模式换算成屏幕点
    let scale: CGFloat = args.contains("--file")
        ? 1
        : CGFloat(cg.width) / CGFloat(NSScreen.main?.frame.width ?? CGFloat(cg.width))

    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])

    let want = needle.lowercased()
    var hits: [(String, CGPoint, Float)] = []
    for obs in (req.results ?? []) {
        guard let top = obs.topCandidates(1).first else { continue }
        let matchAll = want.isEmpty || want == "*"      // Swift 的 contains("") 是 false，得单独处理
        guard matchAll || top.string.lowercased().contains(want) else { continue }
        let bb = obs.boundingBox                                  // 归一化，左下原点
        let px = bb.midX * CGFloat(cg.width)
        let py = (1 - bb.midY) * CGFloat(cg.height)               // 换成左上原点
        let sx = px / scale, sy = py / scale                      // 转成屏幕点
        if region.width > 0 {
            guard sx >= region.minX - 4, sx <= region.maxX + 4, sy >= region.minY - 4, sy <= region.maxY + 4 else { continue }
        }
        hits.append((top.string, CGPoint(x: sx, y: sy), top.confidence))
    }
    if hits.isEmpty {
        print("没找到「\(needle)」（OCR 共识别 \((req.results ?? []).count) 段文字）")
        exit(2)
    }
    hits.sort { $0.2 > $1.2 }
    for (i, h) in (showAll ? hits : [hits[0]]).enumerated() {
        print("\(i)\t\(Int(h.1.x)),\(Int(h.1.y))\t\(String(format: "%.2f", h.2))\t\(h.0)")
    }

case "observe":
    // set-of-mark：把可点元素在截图上编号，模型就能说「点第 7 个」而不是猜坐标
    guard args.count >= 2, let pid = pid_t(args[1]) else { fail("用法: dsh-cu observe <pid> [--out 路径] [--limit N]") }
    let outPath = args.contains("--out") ? args[args.count - 1] : "/tmp/dsh-cu-mark-\(pid).png"
    let maxMark = args.contains("--limit") ? Int(args[args.count - 1]) ?? 60 : 60

    guard let win = windowsOfAX(pid).first else { fail("pid \(pid) 没有 AX 窗口（应用可能没在跑或没有窗口）") }
    let winFrame = frame(win) ?? .zero
    guard winFrame.width > 1, winFrame.height > 1 else { fail("拿不到窗口尺寸") }

    var marks: [(role: String, label: String, rect: CGRect, el: AXUIElement)] = []
    var seenM = Set<CFHashCode>()
    let INTERACTIVE: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox",
                                    "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXTab", "AXSlider",
                                    "AXSearchField", "AXComboBox", "AXDisclosureTriangle", "AXIncrementor"]
    func collect(_ el: AXUIElement, _ depth: Int) {
        guard depth <= 20, marks.count < maxMark else { return }
        let h = CFHash(el); if seenM.contains(h) { return }; seenM.insert(h)
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        if INTERACTIVE.contains(role), let f = frame(el), f.width >= 4, f.height >= 4,
           f.midX >= winFrame.minX - 2, f.midX <= winFrame.maxX + 2,
           f.midY >= winFrame.minY - 2, f.midY <= winFrame.maxY + 2 {
            marks.append((role, label(el), f, el))
        }
        for c in children(el) { collect(c, depth + 1) }
    }
    collect(win, 0)
    if marks.isEmpty { fail("这个窗口里没找到可交互元素") }

    // 截窗口
    let shotPath = "/tmp/dsh-cu-obs-\(pid).png"
    let fullPath = "/tmp/dsh-cu-obs-full-\(pid).png"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", fullPath]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run(); p.waitUntilExit()
    _ = try? FileManager.default.removeItem(atPath: shotPath)
    let crop = Process()
    crop.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
    crop.arguments = ["-c", String(Int(winFrame.height)), String(Int(winFrame.width)),
                      "--cropOffset", String(Int(winFrame.minY)), String(Int(winFrame.minX)),
                      fullPath, "--out", shotPath]
    crop.standardOutput = FileHandle.nullDevice
    crop.standardError = FileHandle.nullDevice
    try? crop.run(); crop.waitUntilExit()

    guard let base = NSImage(contentsOfFile: shotPath), let baseCG = base.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("窗口截图读不出来（屏幕录制权限？）")
    }
    let W = baseCG.width, H = baseCG.height
    let scale = CGFloat(W) / winFrame.width
    let img = NSImage(size: NSSize(width: W, height: H))
    img.lockFocus()
    base.draw(in: NSRect(x: 0, y: 0, width: W, height: H))
    let ctx = NSGraphicsContext.current!.cgContext
    ctx.setLineWidth(2)
    for (i, m) in marks.enumerated() {
        // 屏幕坐标 → 图片坐标（AppKit 原点在左下，要翻转 y）
        let x = (m.rect.minX - winFrame.minX) * scale
        let y = CGFloat(H) - (m.rect.maxY - winFrame.minY) * scale
        let w = m.rect.width * scale, hh = m.rect.height * scale
        ctx.setStrokeColor(NSColor.systemBlue.withAlphaComponent(0.9).cgColor)
        ctx.stroke(CGRect(x: x, y: y, width: w, height: hh))
        let tag = "\(i + 1)"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 13),
            .foregroundColor: NSColor.white,
        ]
        let ts = NSAttributedString(string: tag, attributes: attrs)
        let sz = ts.size()
        let bx = x, by = y + hh - sz.height - 2
        ctx.setFillColor(NSColor.systemBlue.cgColor)
        ctx.fill(CGRect(x: bx, y: by, width: sz.width + 6, height: sz.height + 2))
        ts.draw(at: NSPoint(x: bx + 3, y: by + 1))
    }
    img.unlockFocus()
    guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { fail("标注图写不出来") }
    try? png.write(to: URL(fileURLWithPath: outPath))

    // 观察时把光标滑到窗口中心，表示"我在看这个"
    if !args.contains("--no-cursor") {
        ensureOverlay()
        overlayPing("move \(Int(winFrame.midX)) \(Int(winFrame.midY))")
        if ProcessInfo.processInfo.environment["DSH_CU_FX"] == "full" {
            overlayPing("fog on")
            overlayPing("lens \(Int(winFrame.midX)) \(Int(winFrame.midY))")
        }
    }
    print(outPath)
    print("window\t\(Int(winFrame.minX)),\(Int(winFrame.minY)) \(Int(winFrame.width))×\(Int(winFrame.height))")
    for (i, m) in marks.enumerated() {
        print("\(i + 1)\t\(m.role)\t\(m.label.prefix(50))\t\(Int(m.rect.midX)),\(Int(m.rect.midY))")
    }

case "click-index":
    guard args.count >= 3, let pid = pid_t(args[1]), let want = Int(args[2]) else { fail("用法: dsh-cu click-index <pid> <编号>") }
    guard let win = windowsOfAX(pid).first else { fail("没有 AX 窗口") }
    var marks: [AXUIElement] = []
    var seenI = Set<CFHashCode>()
    let INTER2: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox",
                               "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXTab", "AXSlider",
                               "AXSearchField", "AXComboBox", "AXDisclosureTriangle", "AXIncrementor"]
    let wf = frame(win) ?? .zero
    func collect2(_ el: AXUIElement, _ depth: Int) {
        guard depth <= 20, marks.count < 60 else { return }
        let h = CFHash(el); if seenI.contains(h) { return }; seenI.insert(h)
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        if INTER2.contains(role), let f = frame(el), f.width >= 4, f.height >= 4,
           f.midX >= wf.minX - 2, f.midX <= wf.maxX + 2, f.midY >= wf.minY - 2, f.midY <= wf.maxY + 2 {
            marks.append(el)
        }
        for c in children(el) { collect2(c, depth + 1) }
    }
    collect2(win, 0)
    guard want >= 1, want <= marks.count else { fail("编号越界（1...\(marks.count)）") }
    let el = marks[want - 1]
    var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success, let f = frame(el) {
        err = postClick(pid: pid, at: CGPoint(x: f.midX, y: f.midY)) ? .success : .failure
    }
    print(err == .success ? "已点击 [\(want)] \(label(el).prefix(40))" : "点击失败 (\(err.rawValue))")

case "scroll":
    guard args.count >= 5, let pid = pid_t(args[1]), let x = Double(args[2]), let y = Double(args[3]), let dy = Int32(args[4]) else {
        fail("用法: dsh-cu scroll <pid> <x> <y> <dy> [dx]")
    }
    let dx = args.count >= 6 ? Int32(args[5]) ?? 0 : 0
    guard let e = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState),
                          units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else { fail("造不出滚动事件") }
    e.location = CGPoint(x: x, y: y)
    e.postToPid(pid)
    print("已滚动 dy=\(dy) dx=\(dx) @(\(Int(x)),\(Int(y)))")

case "drag":
    guard args.count >= 6, let pid = pid_t(args[1]),
          let x1 = Double(args[2]), let y1 = Double(args[3]),
          let x2 = Double(args[4]), let y2 = Double(args[5]) else {
        fail("用法: dsh-cu drag <pid> <x1> <y1> <x2> <y2>")
    }
    let src = CGEventSource(stateID: .hidSystemState)
    let from = CGPoint(x: x1, y: y1), to = CGPoint(x: x2, y: y2)
    CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.postToPid(pid)
    let steps = 12
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: pt, mouseButton: .left)?.postToPid(pid)
        usleep(15_000)
    }
    CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.postToPid(pid)
    print("已拖拽 (\(Int(x1)),\(Int(y1))) → (\(Int(x2)),\(Int(y2)))")

case "apps":
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        let front = app.isActive ? "*" : " "
        print("\(front)\(app.processIdentifier)\t\(app.localizedName ?? "?")\t\(app.bundleIdentifier ?? "")")
    }

case "launch":
    guard args.count >= 2 else { fail("用法: dsh-cu launch <bundleId 或 应用名>") }
    let target = args[1]
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false                       // 不抢前台
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    if target.contains(".") {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) else { fail("找不到 \(target)") }
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, _ in launched = app; sem.signal() }
    } else {
        let dirs = ["/System/Applications", "/Applications", "/System/Applications/Utilities"]
        var found: URL?
        for d in dirs {
            let u = URL(fileURLWithPath: d).appendingPathComponent("\(target).app")
            if FileManager.default.fileExists(atPath: u.path) { found = u; break }
        }
        guard let url = found else { fail("找不到应用 \(target)") }
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, _ in launched = app; sem.signal() }
    }
    _ = sem.wait(timeout: .now() + 10)
    if let a = launched { print("已后台启动 \(a.localizedName ?? target) pid=\(a.processIdentifier)") }
    else { fail("启动超时") }

case "shot":
    let out = args.contains("--out") ? args[args.count - 1] : "/tmp/dsh-cu-shot.png"
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x", out]
    try? p.run(); p.waitUntilExit()
    print(out)

default:
    fail("不认识的命令: \(cmd)")
}

/// 某个 pid 的 AX 窗口（解锁后可用；锁屏时拿不到）
func windowsOfAX(_ pid: pid_t) -> [AXUIElement] {
    let ax = AXUIElementCreateApplication(pid)
    return (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

/// 某个 pid 最前面那个普通窗口的屏幕矩形（CGWindowList，不需要 AX）
func windowsOf(_ pid: pid_t) -> [CGRect] {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.compactMap { w in
        guard (w[kCGWindowLayer as String] as? Int ?? -1) == 0,
              (w[kCGWindowOwnerPID as String] as? Int) == Int(pid),
              let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
    }
}

// ── 系统级光标浮层联动 ──────────────────────────────────────────────────────
// 用 ~/.dsh/bin/dsh-cursor 那个常驻 NSPanel 浮层：操作时把光标飘过去，
// 用户想看就看得见；它不抢前台、点击穿透，所以不影响任何东西。
// 浮层没在跑就静默跳过。

var cursorOverlayOff = false

/// 浮层没在跑就拉起来（跟插件里的 ensureCursor 一个意思，让命令行单独用也有特效）
func ensureOverlay() {
    let fifo = "/tmp/dsh-cursor.fifo"
    // 有 FIFO 文件 ≠ 浮层活着：进程被 kill 后文件会残留，于是写入超时、特效全哑。
    // 必须真探一下进程。
    if FileManager.default.fileExists(atPath: fifo) {
        let probe = Process()
        probe.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        probe.arguments = ["-f", "dsh-cursor-overlay"]
        probe.standardOutput = FileHandle.nullDevice
        probe.standardError = FileHandle.nullDevice
        try? probe.run(); probe.waitUntilExit()
        if probe.terminationStatus == 0 { return }              // 真活着
        try? FileManager.default.removeItem(atPath: fifo)        // 残留，清掉重来
    }
    let bin = NSString(string: "~/.dsh/bin/dsh-cursor-overlay").expandingTildeInPath
    guard FileManager.default.isExecutableFile(atPath: bin) else { return }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: bin)
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
    for _ in 0..<20 {
        if FileManager.default.fileExists(atPath: fifo) { break }
        usleep(50_000)
    }
}

func overlayPing(_ cmd: String) {
    guard !cursorOverlayOff else { return }
    let fifo = "/tmp/dsh-cursor.fifo"
    // 关键：O_NONBLOCK。FIFO 没读者时普通 open 会**永久阻塞**，
    // 之前就是这样把整个点击卡超时的。没读者就直接跳过，绝不能拖慢操作。
    let fd = open(fifo, O_WRONLY | O_NONBLOCK)
    guard fd >= 0 else { return }
    var bytes = Array((cmd + "\n").utf8)
    _ = write(fd, &bytes, bytes.count)
    close(fd)
}

// ── CGEvent 投递（不移动真实鼠标）────────────────────────────────────────────

/// global=false：投递给目标进程（不移动真实鼠标）；true：走系统事件（会移动真实鼠标，兼容性最好）
func postClick(pid: pid_t, at point: CGPoint, global: Bool = false) -> Bool {
    let src = CGEventSource(stateID: .hidSystemState)
    for (type, button) in [(CGEventType.leftMouseDown, CGMouseButton.left), (CGEventType.leftMouseUp, CGMouseButton.left)] {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return false }
        if global {
            if type == .leftMouseDown { CGWarpMouseCursorPosition(point) }   // 让光标也过去
            e.post(tap: .cghidEventTap)
        } else {
            e.postToPid(pid)
        }
        usleep(30_000)
    }
    return true
}

func postText(pid: pid_t, _ text: String) -> Bool {
    let src = CGEventSource(stateID: .hidSystemState)
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return false }
    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    down.postToPid(pid)
    usleep(20_000)
    up.postToPid(pid)
    return true
}
