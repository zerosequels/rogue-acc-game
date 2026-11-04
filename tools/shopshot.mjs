/** Capture the shop sheet for visual review. */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
const ROOT = new URL('../dist/', import.meta.url).pathname
const T = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm' }
const server = createServer(async (req,res)=>{
  let p = join(ROOT, decodeURIComponent((req.url||'/').split('?')[0]))
  const s = await stat(p).catch(()=>null); if(!s||s.isDirectory()) p=join(ROOT,'index.html')
  res.writeHead(200,{'content-type':T[extname(p)]??'application/octet-stream'}); res.end(await readFile(p))
})
await new Promise(r=>server.listen(0,r))
const port = server.address().port
const EXE='/usr/bin/chromium'
const b = await chromium.launch({ executablePath: existsSync(EXE)?EXE:undefined,
  args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await b.newPage({ viewport:{width:1440,height:900} })
const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
await page.goto(`http://127.0.0.1:${port}/?seed=SHOPVIEW`,{waitUntil:'networkidle'})
await page.waitForFunction(()=>!document.getElementById('boot'),{timeout:45000})
await page.keyboard.press('Enter'); await page.waitForTimeout(400)
// Cheat to the shop quickly.
await page.evaluate(()=>{ window.game.debug.level(6); window.game.debug.money(26) })
for (let i=0;i<10;i++){
  const ph = await page.evaluate(()=>window.game['run'].phase)
  if (ph!=='aim') break
  await page.mouse.move(640+i*22, 480)
  await page.keyboard.down(' '); await page.waitForTimeout(260); await page.keyboard.up(' ')
  await page.waitForFunction(()=>window.game['run'].phase!=='resolving',{timeout:25000}).catch(()=>{})
  await page.waitForTimeout(120)
}
const ph = await page.evaluate(()=>window.game['run'].phase)
if (ph==='cleared'){ await page.keyboard.press('Enter'); await page.waitForTimeout(700) }
// Hover a blind item so the board shows which weights it would hit.
const cards = page.locator('.side-card')
const n = await cards.count()
for (let i=0;i<n;i++){
  const prec = await cards.nth(i).getAttribute('data-prec')
  if (prec === 'blind') { await cards.nth(i).hover(); break }
}
await page.waitForTimeout(900)
await page.screenshot({path:'tools/shop.png'})
console.log('side cards:', n)
console.log('phase', await page.evaluate(()=>window.game['run'].phase))
await b.close(); server.close()
if(errs.length){ console.error('ERRORS:', errs.slice(0,5)); process.exit(1) }
