import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname } from 'node:path'
const ROOT = '/home/zero_sequels/rogue-acc-game/dist/'
const T = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.wasm':'application/wasm' }
const server = createServer(async (req,res)=>{
  let p = join(ROOT, decodeURIComponent((req.url||'/').split('?')[0]))
  const s = await stat(p).catch(()=>null); if(!s||s.isDirectory()) p=join(ROOT,'index.html')
  res.writeHead(200,{'content-type':T[extname(p)]??'application/octet-stream'}); res.end(await readFile(p))
})
await new Promise(r=>server.listen(0,r))
const port = server.address().port
const EXE='/usr/bin/chromium'
const b = await chromium.launch({ executablePath: existsSync(EXE)?EXE:undefined, args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await b.newPage({ viewport:{width:1440,height:900} })
const errs=[]; page.on('pageerror',e=>errs.push(e.message)); page.on('console',m=>{if(m.type()==='error')errs.push(m.text())})
await page.goto(`http://127.0.0.1:${port}/?seed=V2TEST`,{waitUntil:'networkidle'})
await page.waitForFunction(()=>!document.getElementById('boot'),{timeout:45000})
console.log('booted')
console.log('brief:', (await page.textContent('#sheet')).slice(0,110).replace(/\s+/g,' '))
await page.keyboard.press('Enter'); await page.waitForTimeout(400)
console.log('state:', JSON.stringify(await page.evaluate(()=>window.game.debug.report())))
console.log('deck :', (await page.evaluate(()=>window.game.debug.deck())).slice(0,4).join(' | '))
// fire until the benchmark resolves, logging each pass
for (let i=0;i<14;i++){
  const ph = await page.evaluate(()=>window.game['run'].phase)
  if (ph!=='aim') break
  const before = await page.evaluate(()=>({s:window.game['run'].score, p:window.game['run'].totals.pinsStruck, g:window.game['run'].totals.signalsFired}))
  await page.mouse.move(600 + i*30, 500)
  await page.keyboard.down(' '); await page.waitForTimeout(280); await page.keyboard.up(' ')
  await page.waitForFunction(()=>window.game['run'].phase!=='resolving',{timeout:25000}).catch(()=>{})
  await page.waitForTimeout(150)
  const after = await page.evaluate(()=>({s:window.game['run'].score, p:window.game['run'].totals.pinsStruck, g:window.game['run'].totals.signalsFired, a:window.game['run'].activations}))
  console.log(`  pass ${i+1}: +${after.s-before.s} pts, contacts +${after.p-before.p}, signal +${after.g-before.g}, act ${after.a}`)
}
const st = await page.evaluate(()=>({phase:window.game['run'].phase, score:window.game['run'].score, money:window.game['run'].money}))
console.log('after firing:', JSON.stringify(st))
if (st.phase==='cleared'){
  await page.screenshot({path:'/home/zero_sequels/rogue-acc-game/tools/cleared.png'})
  await page.keyboard.press('Enter'); await page.waitForTimeout(500)
  console.log('shop:', (await page.textContent('#sheet')).slice(0,150).replace(/\s+/g,' '))
  await page.screenshot({path:'/home/zero_sequels/rogue-acc-game/tools/shop.png'})
}
if (errs.length){ console.error('ERRORS:', errs.slice(0,6)); }
await b.close(); server.close()
