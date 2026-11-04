/**
 * tools/shot.mjs — capture the game mid-action for visual review.
 *
 * Separate from smoke.mjs because the smoke test drives a whole run and takes
 * minutes; this boots, optionally applies debug grants, fires one pass, and
 * screenshots while the forward pass is still propagating.
 *
 *   node tools/shot.mjs                plain board
 *   node tools/shot.mjs loaded         with transforms granted
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'

const LOADED = process.argv[2] === 'loaded'
const ROOT = new URL('../dist/', import.meta.url).pathname
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }

const server = createServer(async (req, res) => {
  let p = join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]))
  const s = await stat(p).catch(() => null)
  if (!s || s.isDirectory()) p = join(ROOT, 'index.html')
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream' })
  res.end(await readFile(p))
})
await new Promise((r) => server.listen(0, r))
const port = server.address().port

const EXE = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const browser = await chromium.launch({
  executablePath: existsSync(EXE) ? EXE : undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(`http://127.0.0.1:${port}/?seed=SHOWCASE`, { waitUntil: 'networkidle' })
await page.waitForFunction(() => !document.getElementById('boot'), { timeout: 45000 })
await page.keyboard.press('Enter')
await page.waitForTimeout(400)

if (LOADED) {
  await page.evaluate(() => {
    const g = window.game
    g.debug.level(4)
    g.debug.scatter('gelu', 3)
    g.debug.scatter('residual', 3)
    g.debug.scatter('layer-norm', 2)
    g.debug.scatter('dropout', 2)
    g.debug.scatter('sparse-moe', 2)
    g.debug.bucket(0, 5, 'top-k')
    g.debug.bucket(2, 3, 'logit-boost')
  })
  await page.waitForTimeout(300)
}

// Aim into the middle of the lattice and fire.
await page.mouse.move(700, 500)
await page.keyboard.down(' ')
await page.waitForTimeout(300)
await page.keyboard.up(' ')

// Capture while the wave is still travelling: hops are staggered at 65ms and
// the ball needs time to reach the first node.
await page.waitForTimeout(4200)  // let the feed post a few headlines
const out = LOADED ? 'tools/signal.png' : 'tools/board.png'
await page.screenshot({ path: out })
console.log('wrote', out)

const state = await page.evaluate(() => ({
  score: window.game['run'].score,
  pins: window.game['run'].totals.pinsStruck,
  report: window.game.debug.report(),
}))
console.log('score', state.score, 'nodes lit', state.pins)
console.log('transforms', JSON.stringify(state.report.transforms))

await browser.close()
server.close()
if (errors.length) { console.error('ERRORS:', errors.slice(0, 5)); process.exit(1) }
