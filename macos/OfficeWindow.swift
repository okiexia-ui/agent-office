import AppKit
import WebKit

final class OfficeWindow: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var browser: WKWebView!
    private let message = NSTextField(wrappingLabelWithString: "")
    private let retry = NSButton(title: "重试", target: nil, action: nil)
    private let spinner = NSProgressIndicator()
    private let status = NSStackView()
    private var helper: Process?
    private var timeout: Timer?
    private var runNumber = 0
    private var base: URL?
    private var quitting = false
    private struct Transfer {
        let download: WKDownload
        let final: URL
        let staged: URL
    }
    private var transfers: [ObjectIdentifier: Transfer] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chooseProjectFolder")
        browser = WKWebView(frame: .zero, configuration: config)
        browser.uiDelegate = self
        browser.navigationDelegate = self
        browser.allowsBackForwardNavigationGestures = true
        browser.translatesAutoresizingMaskIntoConstraints = false

        let canvas = NSView()
        canvas.addSubview(browser)
        status.orientation = .vertical
        status.spacing = 14
        status.translatesAutoresizingMaskIntoConstraints = false
        message.alignment = .center
        message.font = .systemFont(ofSize: 15)
        message.maximumNumberOfLines = 6
        spinner.style = .spinning
        spinner.controlSize = .regular
        retry.target = self
        retry.action = #selector(connect)
        for view in [spinner, message, retry] as [NSView] { status.addArrangedSubview(view) }
        canvas.addSubview(status)
        NSLayoutConstraint.activate([
            browser.leadingAnchor.constraint(equalTo: canvas.leadingAnchor), browser.topAnchor.constraint(equalTo: canvas.topAnchor),
            browser.trailingAnchor.constraint(equalTo: canvas.trailingAnchor), browser.bottomAnchor.constraint(equalTo: canvas.bottomAnchor),
            status.centerXAnchor.constraint(equalTo: canvas.centerXAnchor), status.centerYAnchor.constraint(equalTo: canvas.centerYAnchor),
            status.widthAnchor.constraint(lessThanOrEqualTo: canvas.widthAnchor, multiplier: 0.8),
            message.widthAnchor.constraint(lessThanOrEqualToConstant: 560)
        ])
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1140, height: 740),
            styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Agent Office"
        window.minSize = NSSize(width: 560, height: 420)
        window.isReleasedWhenClosed = false
        window.contentView = canvas
        window.center()
        window.setFrameAutosaveName("AgentOffice.Workspace")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        connect()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    // The office runs as a separate background service with the local model loaded.
    // Quitting stops it when nothing is running, so the model's memory is freed; with
    // work in progress the person chooses. Offices without these routes are left alone.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let base = base, !quitting else { return .terminateNow }
        quitting = true
        control(base, "api/local/activity", method: "GET") { [weak self] json in
            guard let self = self else { return }
            guard let running = json?["running"] as? Int else { NSApp.reply(toApplicationShouldTerminate: true); return }
            if running == 0 {
                self.control(base, "api/local/shutdown", method: "POST") { _ in NSApp.reply(toApplicationShouldTerminate: true) }
                return
            }
            let alert = NSAlert()
            alert.messageText = "还有 \(running) 个任务正在执行"
            alert.informativeText = "可以让办公室在后台继续完成，下次打开时查看结果；也可以现在停止，未完成的任务会中断。停止时本机模型也会关闭，释放内存。"
            alert.addButton(withTitle: "后台继续并退出")
            alert.addButton(withTitle: "停止并退出")
            alert.addButton(withTitle: "取消")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                NSApp.reply(toApplicationShouldTerminate: true)
            case .alertSecondButtonReturn:
                self.control(base, "api/local/shutdown", method: "POST") { _ in NSApp.reply(toApplicationShouldTerminate: true) }
            default:
                self.quitting = false
                self.window.makeKeyAndOrderFront(nil)
                NSApp.reply(toApplicationShouldTerminate: false)
            }
        }
        return .terminateLater
    }
    // Ask the office for its activity or to stop. The header keeps web pages out.
    private func control(_ base: URL, _ path: String, method: String, done: @escaping ([String: Any]?) -> Void) {
        var request = URLRequest(url: base.appendingPathComponent(path), timeoutInterval: 3)
        request.httpMethod = method
        request.setValue("1", forHTTPHeaderField: "X-Agent-Office-Control")
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            let json = ok ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } : nil
            DispatchQueue.main.async { done(json) }
        }.resume()
    }
    @objc private func stopOffice(_ sender: Any?) {
        guard let base = base else { NSSound.beep(); return }
        control(base, "api/local/activity", method: "GET") { [weak self] json in
            guard let self = self else { return }
            guard let running = json?["running"] as? Int else {
                self.notice("这个办公室版本不支持从 App 停止。", "请更新 Agent Office 后再试。")
                return
            }
            let alert = NSAlert()
            alert.messageText = "停止办公室服务？"
            alert.informativeText = running > 0
                ? "还有 \(running) 个任务正在执行，停止后会中断。本机模型也会关闭，释放内存。"
                : "办公室和本机模型都会关闭，释放内存。之后点「重试」即可重新启动。"
            alert.addButton(withTitle: "停止")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            self.control(base, "api/local/shutdown", method: "POST") { result in
                guard result != nil else { self.notice("没能停止办公室服务。", "请稍后再试。"); return }
                self.base = nil
                self.presentStatus("办公室服务已停止，本机模型已关闭。点「重试」可以重新启动。", failed: true)
            }
        }
    }
    private func notice(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = detail
        alert.beginSheetModal(for: window)
    }
    func applicationWillTerminate(_ notification: Notification) {
        timeout?.invalidate()
        if helper?.isRunning == true { helper?.terminate() }
        for transfer in transfers.values {
            try? FileManager.default.removeItem(at: transfer.staged.deletingLastPathComponent())
        }
    }
    private func presentStatus(_ text: String, failed: Bool) {
        status.isHidden = false
        browser.isHidden = true
        message.stringValue = text
        retry.isHidden = !failed
        spinner.isHidden = failed
        failed ? spinner.stopAnimation(nil) : spinner.startAnimation(nil)
    }
    @objc private func connect() {
        runNumber += 1
        let number = runNumber
        timeout?.invalidate()
        if helper?.isRunning == true { helper?.terminate() }
        presentStatus("正在连接本机办公室…", failed: false)
        guard let script = Bundle.main.url(forResource: "start-office", withExtension: "cjs") else {
            presentStatus("应用内缺少本机启动器。请重新下载完整的 Agent Office.app。", failed: true); return
        }
        let process = Process()
        let out = Pipe(), err = Pipe()
        let nodePaths = [
            Bundle.main.object(forInfoDictionaryKey: "OfficeNodePath") as? String,
            "/opt/homebrew/bin/node", "/usr/local/bin/node"
        ].compactMap { $0 }
        guard let node = nodePaths.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            presentStatus("找不到 Node.js。请安装 Node.js 22.19 或更新版本，然后重试。", failed: true)
            return
        }
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (env["PATH"] ?? "")
        process.environment = env
        process.standardOutput = out
        process.standardError = err
        process.standardInput = FileHandle.nullDevice
        helper = process
        process.terminationHandler = { [weak self] process in
            let line = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            let diagnostic = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            DispatchQueue.main.async {
                guard let self = self, self.runNumber == number else { return }
                self.timeout?.invalidate(); self.timeout = nil; self.helper = nil
                guard process.terminationStatus == 0, let url = URL(string: line), url.scheme == "http",
                      let host = url.host, ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
                      url.user == nil, url.password == nil else {
                    self.presentStatus(diagnostic.isEmpty ? "未能连接本机办公室。请确认项目和 Node.js 仍在此 Mac 上，然后重试。" : String(diagnostic.prefix(600)), failed: true)
                    return
                }
                self.base = url
                self.presentStatus("正在打开工作台…", failed: false)
                self.browser.load(URLRequest(url: url))
            }
        }
        do { try process.run() }
        catch {
            helper = nil
            presentStatus("Node.js 启动失败：" + error.localizedDescription, failed: true)
            return
        }
        timeout = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { [weak self] _ in
            guard let self = self, self.runNumber == number, process.isRunning else { return }
            self.runNumber += 1; process.terminate(); self.helper = nil
            self.presentStatus("连接超时。如果 macOS 弹出了文件夹访问提示，请先完成选择，再点重试。", failed: true)
        }
    }
    private func allowed(_ url: URL) -> Bool {
        guard let base = base else { return false }
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port && url.user == nil && url.password == nil
    }
    private func blobFromOffice(_ url: URL) -> Bool {
        guard url.scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst(5))) else { return false }
        return allowed(inner)
    }
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.name == "chooseProjectFolder", message.frameInfo.isMainFrame,
              let origin = message.frameInfo.request.url, allowed(origin),
              message.webView === browser, window.attachedSheet == nil else {
            replyHandler(nil, "请在本机工作台中打开项目文件夹。")
            return
        }
        let panel = NSOpenPanel()
        panel.title = "选择项目文件夹"
        panel.prompt = "选择项目"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { result in
            // Use explicit JS null on cancellation; undefined is not a project path.
            if result == .OK, let url = panel.url { replyHandler(url.path, nil) }
            else { replyHandler(NSNull(), nil) }
        }
    }
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if action.shouldPerformDownload && (allowed(url) || blobFromOffice(url)) { decisionHandler(.download); return }
        if action.targetFrame == nil {
            decisionHandler(.cancel)
            if allowed(url) { view.load(action.request) }
            else if ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            return
        }
        if action.targetFrame?.isMainFrame == false && ["about", "blob", "data"].contains(url.scheme ?? "") { decisionHandler(.allow); return }
        if allowed(url) { decisionHandler(.allow); return }
        if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }
    func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        decisionHandler(disposition.hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
    }
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        status.isHidden = true; spinner.stopAnimation(nil); browser.isHidden = false
        window.makeFirstResponder(browser)
    }
    private func navigationError(_ error: Error) {
        let ns = error as NSError
        if ns.code == NSURLErrorCancelled || (ns.domain == WKError.errorDomain && ns.code == 102) || (ns.domain == "WebKitErrorDomain" && ns.code == 102) { return }
        presentStatus("工作台未能载入。\n" + error.localizedDescription, failed: true)
    }
    func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navigationError(error) }
    func webViewWebContentProcessDidTerminate(_ view: WKWebView) { presentStatus("工作台窗口已停止响应，点击重试可重新打开。", failed: true) }

    func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
    func webView(_ view: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ view: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let save = NSSavePanel()
        save.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        save.canCreateDirectories = true
        save.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        save.beginSheetModal(for: window) { [weak self] result in
            guard result == .OK, let url = save.url, let self = self else { completionHandler(nil); return }
            do {
                let staging = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: url, create: true)
                let staged = staging.appendingPathComponent(UUID().uuidString)
                self.transfers[ObjectIdentifier(download)] = Transfer(download: download, final: url, staged: staged)
                completionHandler(staged)
            } catch {
                completionHandler(nil); self.showError(error)
            }
        }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let transfer = transfers.removeValue(forKey: ObjectIdentifier(download)) else { return }
        defer { try? FileManager.default.removeItem(at: transfer.staged.deletingLastPathComponent()) }
        do {
            if FileManager.default.fileExists(atPath: transfer.final.path) {
                _ = try FileManager.default.replaceItemAt(transfer.final, withItemAt: transfer.staged)
            } else {
                try FileManager.default.moveItem(at: transfer.staged, to: transfer.final)
            }
        } catch { showError(error) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let saved = transfers.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: saved.staged.deletingLastPathComponent())
        }
        if (error as NSError).code != NSURLErrorCancelled { showError(error) }
    }
    private func showError(_ error: Error) {
        NSAlert(error: error).beginSheetModal(for: window)
    }
    private func projectCommand(_ command: String) {
        guard !browser.isHidden, let url = browser.url, allowed(url) else { NSSound.beep(); return }
        let script = "!document.dispatchEvent(new CustomEvent('office-project-command', {detail:'\(command)', cancelable:true}))"
        browser.evaluateJavaScript(script) { value, _ in
            if (value as? Bool) != true { NSSound.beep() }
        }
    }
    @objc private func newTask(_ sender: Any?) { projectCommand("new") }
    @objc private func chooseProject(_ sender: Any?) { projectCommand("folder") }
    @objc private func refresh(_ sender: Any?) { if browser.isHidden { connect() } else { browser.reload() } }
    private func installMenu() {
        let main = NSMenu()
        func sub(_ title: String) -> NSMenu {
            let item = NSMenuItem(); main.addItem(item)
            let menu = NSMenu(title: title); item.submenu = menu; return menu
        }
        let app = sub("Agent Office")
        app.addItem(withTitle: "关于 Agent Office", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "停止办公室服务…", action: #selector(stopOffice(_:)), keyEquivalent: "").target = self
        app.addItem(.separator())
        app.addItem(withTitle: "隐藏 Agent Office", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "退出 Agent Office", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let file = sub("文件")
        file.addItem(withTitle: "新任务", action: #selector(newTask(_:)), keyEquivalent: "n").target = self
        file.addItem(withTitle: "选择项目文件夹…", action: #selector(chooseProject(_:)), keyEquivalent: "o").target = self
        file.addItem(.separator())
        file.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let edit = sub("编辑")
        for (label, action, key) in [("撤销","undo:","z"),("剪切","cut:","x"),("复制","copy:","c"),("粘贴","paste:","v"),("全选","selectAll:","a")] {
            edit.addItem(withTitle: label, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        let view = sub("显示")
        view.addItem(withTitle: "刷新工作台", action: #selector(refresh(_:)), keyEquivalent: "r").target = self
        let window = sub("窗口")
        window.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        NSApp.windowsMenu = window
        NSApp.mainMenu = main
    }
}
let app = NSApplication.shared
let delegate = OfficeWindow()
app.delegate = delegate
app.run()
