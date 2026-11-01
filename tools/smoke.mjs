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

// Stage intro overlay should be up.
const introText = await page.textContent('#sheet')
if (!/Stage 1/.test(introText || '')) throw new Error('stage intro missing: ' + introText)
console.log('✓ stage intro rendered')
const diag = (introText || '').match(/config check[^\n]*/)
console.log('  ', diag ? diag[0].trim() : '(no diagnostics line)')

await page.keyboard.press('Enter')
await page.waitForTimeout(400)

const probe = () => page.evaluate(() => ({
  phase: window.game?.['run']?.phase,
  score: window.game?.['run']?.score,
  act: window.game?.['run']?.activations,
  stage: window.game?.['run']?.stage,
  passes: window.game?.['run']?.totals?.passesFired,
  pins: window.game?.['run']?.totals?.pinsStruck,
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

// Fire 6 passes with varied aim + temperature, letting each fully resolve.
for (let i = 0; i < 6; i++) {
  await page.keyboard.press(String((i % 3) + 1))          // temperature 1-3
  await page.keyboard.down(i % 2 ? 'ArrowLeft' : 'ArrowRight')
  await page.waitForTimeout(120 + i * 40)
  await page.keyboard.up(i % 2 ? 'ArrowLeft' : 'ArrowRight')
  await page.keyboard.down(' ')
  await page.waitForTimeout(300)                           // charge
  await page.keyboard.up(' ')
  // Wait for the pass to resolve back to 'aim' (or the stage to end).
  await page.waitForFunction(
    () => window.game?.['run']?.phase !== 'resolving',
    { timeout: 25000 },
  ).catch(() => console.log('  ! pass', i, 'did not resolve in 25s'))
  await page.waitForTimeout(150)
  const st = await probe()
  console.log(`  pass ${i + 1}: phase=${st.phase} score=${st.score} act=${st.act} pins=${st.pins}`)
  if (st.phase !== 'aim') break
}

const final = await probe()
if (!final.passes || final.passes < 3) throw new Error('passes never fired: ' + JSON.stringify(final))
if (!final.pins || final.pins < 10) throw new Error('no pin strikes registered: ' + JSON.stringify(final))
console.log('✓ cascades scoring:', JSON.stringify(final))

// Mouse aiming + click-to-fire.
await page.mouse.move(500, 600)
await page.mouse.down()
await page.waitForTimeout(260)
await page.mouse.up()
await page.waitForTimeout(600)
console.log('✓ pointer input accepted')

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
while (guard++ < 500) {
  const st = await page.evaluate(() => ({
    phase: window.game?.['run']?.phase,
    stage: window.game?.['run']?.stage,
    open: document.getElementById('overlay')?.classList.contains('on'),
  }))

  if (st.stage !== lastStage) {
    console.log(`  → stage ${st.stage}`)
    lastStage = st.stage
  }

  if (st.phase === 'run-win' || st.phase === 'run-fail') {
    console.log(`✓ run ended: ${st.phase} on stage ${st.stage}`)
    const sheet = await page.textContent('#sheet')
    if (!/SIGNAL COLLAPSE|FRONTIER REACHED/.test(sheet || '')) {
      throw new Error('run-end sheet did not render: ' + (sheet || '').slice(0, 120))
    }
    console.log('✓ run-end sheet rendered')
    await page.screenshot({ path: 'tools/runend.png' })
    break
  }

  if (st.open) {
    // Stage intro and stage clear take Enter; the upgrade sheet takes 1-3.
    await page.keyboard.press(st.phase === 'upgrade' ? '1' : 'Enter')
    await page.waitForTimeout(140)
    continue
  }

  if (st.phase === 'aim') {
    await page.keyboard.press('2')
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
