/**
 * tools/smoke.mjs — runtime smoke test against a real browser.
 *
 * Typechecking and bundling prove nothing about a WebGL app: shader compile
 * errors, missing DOM ids, and wasm init failures all happen at runtime. This
 * boots the built game in headless Chromium, drives actual input, and fails on
 * any console error or page exception.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const ROOT = new URL('../dist/', import.meta.url).pathname
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    let p = join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]))
    const s = await stat(p).catch(() => null)
    if (!s || s.isDirectory()) p = join(ROOT, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
    res.end(await readFile(p))
  } catch (e) {
    res.writeHead(404).end(String(e))
  }
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port
const url = `http://127.0.0.1:${port}/?seed=SMOKE-TEST`

// Prefer the system Chromium: avoids a Playwright browser download, and the
// bundled build revision often drifts from whatever is cached locally.
const EXE = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const browser = await chromium.launch({
  executablePath: existsSync(EXE) ? EXE : undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
const logs = []
page.on('console', (m) => {
  logs.push(`${m.type()}: ${m.text()}`)
  if (m.type() === 'error') errors.push(m.text())
})
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

console.log('→ loading', url)
await page.goto(url, { waitUntil: 'networkidle' })

// The boot screen is removed only after a successful boot().
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 45000 })
  .then(() => console.log('✓ booted (rapier wasm + shaders compiled)'))
  .catch(() => { throw new Error('boot screen never cleared — boot() threw') })

// The benchmark brief should be up, naming the funding round.
const introText = await page.textContent('#sheet')
if (!/Pre-Seed/.test(introText || '')) throw new Error('benchmark brief missing: ' + introText)
if (!/Capital/.test(introText || '')) throw new Error('brief has no capital line: ' + introText)
console.log('✓ benchmark brief rendered (Pre-Seed, capital shown)')

await page.keyboard.press('Enter')
await page.waitForTimeout(400)

const probe = () => page.evaluate(() => ({
  phase: window.game?.['run']?.phase,
  score: window.game?.['run']?.score,
  act: window.game?.['run']?.activations,
  money: window.game?.['run']?.money,
  passes: window.game?.['run']?.totals?.passesFired,
  pins: window.game?.['run']?.totals?.pinsStruck,
  signal: window.game?.['run']?.totals?.signalsFired,
}))
console.log('✓ after ENGAGE:', JSON.stringify(await probe()))

// Board shot: fire one pass and capture mid-flight, before anything can clear.
if (process.env.ACTION_SHOT) {
  await page.keyboard.press('3')
  await page.keyboard.down(' ')
  await page.waitForTimeout(380)
  await page.keyboard.up(' ')
  await page.waitForTimeout(700)
  await page.screenshot({ path: 'tools/board.png' })
  console.log('✓ board shot written to tools/board.png')
  await page.waitForFunction(() => window.game?.['run']?.phase !== 'resolving', { timeout: 20000 }).catch(() => {})
}

// Fire passes until the benchmark resolves.
for (let i = 0; i < 12; i++) {
  const st = await probe()
  if (st.phase !== 'aim') break
  await page.mouse.move(600 + i * 25, 480)
  await page.keyboard.down(' ')
  await page.waitForTimeout(280)
  await page.keyboard.up(' ')
  await page.waitForFunction(() => window.game?.['run']?.phase !== 'resolving', { timeout: 25000 })
    .catch(() => console.log('  ! pass', i, 'did not resolve in 25s'))
  await page.waitForTimeout(140)
  const after = await probe()
  console.log(`  pass ${i + 1}: phase=${after.phase} score=${after.score} act=${after.act} signal=${after.signal}`)
}

const mid = await probe()
if (!mid.passes || mid.passes < 2) throw new Error('passes never fired: ' + JSON.stringify(mid))
if (!mid.pins || mid.pins < 10) throw new Error('no contacts registered: ' + JSON.stringify(mid))
if (!mid.signal || mid.signal < 20) throw new Error('propagation did not fire: ' + JSON.stringify(mid))
console.log(`✓ contacts ${mid.pins}, signal activations ${mid.signal}`)

// The shop must open, stock items, and complete a purchase.
if (mid.phase === 'cleared') {
  await page.keyboard.press('Enter')
  await page.waitForTimeout(450)
  const shopText = await page.textContent('#sheet')
  if (!/Capital allocation/.test(shopText || '')) throw new Error('shop did not open: ' + shopText)
  const cards = await page.locator('.shop-card').count()
  if (cards < 1) throw new Error('shop had no stock')
  console.log(`✓ shop opened with ${cards} items, capital $${mid.money}`)

  const before = await page.evaluate(() => window.game['run'].money)
  await page.locator('.shop-card').first().click()
  await page.waitForTimeout(400)
  // Banded and precise items open a chooser first; resolve whichever appears.
  if (await page.locator('.target-row').count() > 0) {
    await page.locator('.target-row').first().click()
    await page.waitForTimeout(400)
  } else if (/which third/.test((await page.textContent('#sheet')) || '')) {
    await page.locator('.shop-card').first().click()
    await page.waitForTimeout(400)
  }
  const got = await page.evaluate(() => ({
    money: window.game['run'].money,
    bought: window.game['run'].totals.itemsBought,
  }))
  if (got.bought < 1) throw new Error('purchase did not apply: ' + JSON.stringify(got))
  console.log(`✓ bought an item: $${before} → $${got.money}, ${got.bought} owned`)
}


// Audio: the context must exist and be running after real user gestures.
// A silently-suspended AudioContext is the classic autoplay-policy failure.
const audio = await page.evaluate(() => {
  const a = window.game?.['audio']
  return { present: !!a, state: a?.['ctx']?.state ?? null, muted: a?.muted ?? null }
})
if (!audio.present) throw new Error('audio module missing')
if (audio.state !== 'running') throw new Error('AudioContext not running: ' + audio.state)
console.log(`✓ audio live (context ${audio.state}, muted=${audio.muted})`)

// Screen shake must actually displace the frustum, not just the shader.
const shook = await page.evaluate(() => {
  const r = window.game?.['renderer']
  const base = r.camera.top
  r.punch(1.5)
  // Shake is a sinusoid, so a single frame can legitimately sample a zero
  // crossing. Take the peak over several frames instead of one sample.
  let peak = 0
  for (let i = 0; i < 12; i++) {
    r.render(1 / 60)
    peak = Math.max(peak, Math.abs(r.camera.top - base))
  }
  return { peak }
})
if (shook.peak < 0.02) throw new Error('punch() did not move the camera: ' + JSON.stringify(shook))
console.log(`✓ screen shake displaces camera (peak ${shook.peak.toFixed(3)} world units)`)

// ---------------------------------------------------------------------------
// Full-run drive: the overlay -> upgrade -> next-stage path is the part the
// headless sim cannot cover, because it lives entirely in DOM and orchestration.
// Hammer it until the run actually ends.
// ---------------------------------------------------------------------------
console.log('\n→ driving a full run to completion')
let guard = 0
let lastStage = 0
while (guard++ < 900) {
  const st = await page.evaluate(() => ({
    phase: window.game?.['run']?.phase,
    stage: window.game?.['run']?.benchmarkIndex,
    open: document.getElementById('overlay')?.classList.contains('on'),
  }))

  if (st.stage !== lastStage) {
    console.log(`  → benchmark ${st.stage + 1}`)
    lastStage = st.stage
  }

  if (st.phase === 'ipo' || st.phase === 'collapsed') {
    console.log(`✓ run ended: ${st.phase} on stage ${st.stage}`)
    const sheet = await page.textContent('#sheet')
    if (!/THE BUBBLE POPS|IPO/.test(sheet || '')) {
      throw new Error('run-end sheet did not render: ' + (sheet || '').slice(0, 120))
    }
    console.log('✓ run-end sheet rendered')
    await page.screenshot({ path: 'tools/runend.png' })
    break
  }

  if (st.open) {
    // Brief and clear take Enter; the shop must be left explicitly.
    if (st.phase === 'shop') {
      const leave = page.locator('.btn', { hasText: 'CONTINUE' })
      if (await leave.count()) await leave.first().click()
      else await page.keyboard.press('Enter')
    } else {
      await page.keyboard.press('Enter')
    }
    await page.waitForTimeout(170)
    continue
  }

  if (st.phase === 'aim') {
    await page.keyboard.down(' ')
    await page.waitForTimeout(170)
    await page.keyboard.up(' ')
    await page.waitForFunction(
      () => window.game?.['run']?.phase !== 'resolving',
      { timeout: 25000 },
    ).catch(() => {})
    continue
  }
  await page.waitForTimeout(100)
}
if (guard >= 500) throw new Error('full run never terminated — loop is stuck')

await page.screenshot({ path: 'tools/smoke.png' })

// Second shot: mid-cascade at a hot temperature, which is where the visual
// system is under the most load.
if (process.env.ACTION_SHOT) {
  await page.waitForFunction(() => window.game?.['run']?.phase === 'aim', { timeout: 20000 }).catch(() => {})
  await page.keyboard.press('3')
  await page.keyboard.down(' ')
  await page.waitForTimeout(420)
  await page.keyboard.up(' ')
  await page.waitForTimeout(900)
  await page.screenshot({ path: 'tools/action.png' })
  console.log('✓ action shot written to tools/action.png')
}
console.log('✓ screenshot written to tools/smoke.png')

await browser.close()
server.close()

if (errors.length) {
  console.error('\n✗ CONSOLE ERRORS:')
  for (const e of errors.slice(0, 20)) console.error('  ', e)
  process.exit(1)
}
console.log('\n✓ SMOKE TEST PASSED — no console errors, no page exceptions')
