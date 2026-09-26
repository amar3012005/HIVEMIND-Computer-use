import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WholeDesktopDriver } from './whole-desktop-driver.mjs'

if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY is required in this process environment; never commit or log it.')

const { Sandbox } = await import('@e2b/desktop')
const template = process.env.E2B_TEMPLATE_NAME ?? 'hm-computer-operator-canary-v7'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'evidence', new Date().toISOString().replaceAll(':', '-'))
const fixturePath = '/home/user/hm-desktop-ocr-fixture.html'
const expectedWords = ['VISIBLE FACT 40218']
const fixture = `<!doctype html><meta charset="utf-8"><title>HIVE MIND DESKTOP CANARY</title>
<style>body{background:#fff;color:#111;font:28px/1.3 sans-serif;margin:42px}h1{font-size:42px;margin:0}</style>
<h1>VISIBLE FACT 40218</h1>`

await mkdir(outputDir, { recursive: true })
let desktop
try {
  desktop = await Sandbox.create(template, {
    allowInternetAccess: false,
    timeoutMs: 3 * 60_000,
    requestTimeoutMs: 60_000,
    metadata: { app: 'hivemind', test: 'whole-desktop-ocr-read-only-v1' },
  })
  await desktop.files.write(fixturePath, fixture)
  // The desktop SDK launches the fixture directly. Its Chrome URI launch is
  // more reliable than synthesising address-bar keystrokes during first boot.
  await desktop.launch('google-chrome', `file://${fixturePath}`)
  await desktop.wait(10_000)

  const driver = new WholeDesktopDriver({ desktop })
  const observation = await driver.observe({ includeOcr: true })
  const text = observation.ocr.text.toUpperCase()
  const screenshotPath = path.join(outputDir, 'desktop.png')
  await writeFile(screenshotPath, Buffer.from(observation.screenshot))
  const receiptPath = path.join(outputDir, 'receipt.json')
  const passed = expectedWords.every(word => text.includes(word))
  await writeFile(receiptPath, `${JSON.stringify({
    contract: 'hivemind.whole-desktop-ocr-canary.v1',
    status: passed ? 'completed' : 'failed_closed',
    result: { visible_text: observation.ocr.text, ocr_engine: observation.ocr.engine, focused_window: observation.focused_window },
    screenshot_path: screenshotPath,
  }, null, 2)}\n`)
  if (!passed) throw new Error('whole_desktop_ocr_fixture_not_verified')
  console.log(JSON.stringify({ status: 'completed', ocr_engine: observation.ocr.engine, receipt_path: receiptPath, screenshot_path: screenshotPath }))
} finally {
  await desktop?.kill().catch(() => {})
}
