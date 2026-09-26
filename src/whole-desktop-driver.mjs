/**
 * Linux desktop fallback. DOM/CDP remains the preferred browser path; this
 * adapter has a deliberately small physical action set for native windows.
 * It accepts no arbitrary shell action from the model.
 */
export class WholeDesktopDriver {
  constructor({ desktop }) { if (!desktop) throw new TypeError('desktop is required'); this.desktop = desktop }
  async observe({ includeOcr = false } = {}) {
    const focused = await this.desktop.commands.run('xdotool getactivewindow getwindowname 2>/dev/null || true')
    const windows = await this.desktop.commands.run('xdotool search --onlyvisible --name . 2>/dev/null || true')
    const observation = {
      focused_window: String(focused.stdout ?? '').trim(),
      visible_window_ids: String(windows.stdout ?? '').trim().split(/\s+/).filter(Boolean),
      screenshot: await this.desktop.screenshot(),
    }
    return includeOcr ? { ...observation, ocr: await this.readScreenText(observation.screenshot) } : observation
  }
  async click({ x, y }) { if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('finite x and y are required'); return this.desktop.leftClick(x, y) }
  async type({ text }) { if (typeof text !== 'string') throw new TypeError('text is required'); return this.desktop.write(text) }
  async key({ key }) { if (typeof key !== 'string' || !key) throw new TypeError('key is required'); return this.desktop.press(key) }
  async focusWindow({ window_id }) { if (!/^\d+$/.test(String(window_id))) throw new TypeError('window_id must be numeric'); return this.desktop.commands.run(`xdotool windowactivate --sync ${window_id}`) }
  /**
   * Read only visible screen text. The screenshot is captured by the Desktop
   * SDK, then Tesseract runs inside the same disposable computer. The model
   * receives bounded text, never arbitrary shell access or image paths.
   */
  async readScreenText(screenshot = undefined) {
    if (typeof this.desktop?.files?.write !== 'function') throw new TypeError('desktop.files.write is required for OCR')
    const bytes = screenshot ?? await this.desktop.screenshot()
    await this.desktop.files.write('/tmp/hm-computer-screen.png', bytes)
    const result = await this.desktop.commands.run('tesseract /tmp/hm-computer-screen.png stdout --psm 6 2>/dev/null', { timeoutMs: 15_000 })
    const text = String(result.stdout ?? '').replace(/\s+/g, ' ').trim().slice(0, 10_000)
    if (!text) throw new Error('whole_desktop_ocr_no_visible_text')
    return { text, engine: 'tesseract', source: 'desktop_screenshot' }
  }
}
