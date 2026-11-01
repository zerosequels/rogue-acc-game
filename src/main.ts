/**
 * main.ts — entry point.
 *
 * Resolves the run seed (URL first, then a fresh mint), boots the game, and
 * tears down the loading screen. Kept intentionally thin: everything
 * interesting lives in `core/game.ts`.
 */

import { Game } from './core/game'
import { mintSeed, normaliseSeed } from './core/rng'

function resolveSeed(): string {
  const param = new URLSearchParams(window.location.search).get('seed')
  return param ? normaliseSeed(param) : mintSeed()
}

async function start(): Promise<void> {
  const host = document.getElementById('app')
  if (!host) throw new Error('#app host element missing')

  const game = new Game(host)

  try {
    await game.boot(resolveSeed())
  } catch (err) {
    showFatal(err)
    return
  }

  const boot = document.getElementById('boot')
  if (boot) {
    boot.style.transition = 'opacity .35s'
    boot.style.opacity = '0'
    window.setTimeout(() => boot.remove(), 380)
  }

  // Surface the instance for console tinkering during balance work.
  ;(window as unknown as { game: Game }).game = game
}

function showFatal(err: unknown): void {
  const boot = document.getElementById('boot')
  const message = err instanceof Error ? err.message : String(err)
  console.error('[rogue/acc] boot failed', err)
  if (!boot) return
  boot.innerHTML = `
    <div class="big">boot failure</div>
    <div class="sub" style="color:var(--red);max-width:60ch;text-align:center;line-height:1.7">
      ${escapeHtml(message)}
    </div>
    <div class="sub">the forward pass did not complete. check the console.</div>
  `
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )
}

void start()
