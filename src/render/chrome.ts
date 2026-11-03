/**
 * chrome.ts — the instrument around the board.
 *
 * A model-benchmarking game should look like an instrument reading a system,
 * not like a bare playfield. This draws the hairline apparatus the reference
 * art uses: corner brackets, coordinate ticks with a scale, a registration
 * circle, and a scan line that sweeps the field.
 *
 * All of it is one LineSegments plus one Line — static geometry built once,
 * so the whole apparatus costs two draw calls and nothing per frame.
 */

import * as THREE from 'three'
import { BOARD, COLORS, VISUAL } from '../config/balance'
import type { Board } from '../sim/board'

export class Chrome {
  readonly group = new THREE.Group()
  private sweep: THREE.Line | null = null
  private sweepPos: Float32Array | null = null
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []
  private top = 0
  private bottom = 0

  build(board: Board): void {
    this.clear()
    this.top = BOARD.top
    this.bottom = board.floorY

    const halfW = BOARD.width / 2
    const pts: number[] = []
    const cols: number[] = []
    const c = new THREE.Color(COLORS.chrome)
    const push = (ax: number, ay: number, bx: number, by: number, mul = 1) => {
      pts.push(ax, ay, VISUAL.chromeZ, bx, by, VISUAL.chromeZ)
      for (let i = 0; i < 2; i++) cols.push(c.r * mul, c.g * mul, c.b * mul)
    }

    // --- corner brackets: the single cheapest "this is an instrument" cue ---
    const L = VISUAL.bracketLength
    const pad = VISUAL.chromePad
    const x0 = -halfW - pad, x1 = halfW + pad
    const y0 = this.bottom - pad, y1 = this.top + pad
    for (const [cx, cy, sx, sy] of [
      [x0, y1, 1, -1], [x1, y1, -1, -1], [x0, y0, 1, 1], [x1, y0, -1, 1],
    ] as const) {
      push(cx, cy, cx + L * sx, cy)
      push(cx, cy, cx, cy + L * sy)
    }

    // --- coordinate ticks, long every fifth ---
    const ticks = VISUAL.tickCount
    for (let i = 0; i <= ticks; i++) {
      const t = i / ticks
      const major = i % 5 === 0
      const len = major ? VISUAL.tickMajor : VISUAL.tickMinor
      const mul = major ? 1 : 0.5
      const y = this.bottom + (this.top - this.bottom) * t
      push(x0, y, x0 + len, y, mul)
      push(x1, y, x1 - len, y, mul)
      const x = -halfW + BOARD.width * t
      push(x, y1, x, y1 - len, mul)
      push(x, y0, x, y0 + len, mul)
    }

    // --- registration circle behind the field ---
    const r = VISUAL.registrationRadius
    const segs = 96
    for (let i = 0; i < segs; i++) {
      // Dashed: skip every third segment.
      if (i % 3 === 2) continue
      const a0 = (i / segs) * Math.PI * 2
      const a1 = ((i + 1) / segs) * Math.PI * 2
      const cy = (this.top + this.bottom) / 2
      push(Math.cos(a0) * r, cy + Math.sin(a0) * r, Math.cos(a1) * r, cy + Math.sin(a1) * r, 0.45)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: VISUAL.chromeOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
    this.disposables.push(geo, mat)
    const lines = new THREE.LineSegments(geo, mat)
    lines.frustumCulled = false
    this.group.add(lines)

    // --- sweeping scan line ---
    this.sweepPos = new Float32Array(6)
    const sGeo = new THREE.BufferGeometry()
    sGeo.setAttribute('position', new THREE.BufferAttribute(this.sweepPos, 3))
    const sMat = new THREE.LineBasicMaterial({
      color: COLORS.chrome, transparent: true, opacity: VISUAL.sweepOpacity,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
    this.disposables.push(sGeo, sMat)
    this.sweep = new THREE.Line(sGeo, sMat)
    this.sweep.frustumCulled = false
    this.group.add(this.sweep)
  }

  update(time: number): void {
    if (!this.sweep || !this.sweepPos) return
    // A slow pass up the field. Instruments scan; this is the tell.
    const t = (time * VISUAL.sweepSpeed) % 1
    const y = this.bottom + (this.top - this.bottom) * t
    const halfW = BOARD.width / 2
    this.sweepPos[0] = -halfW; this.sweepPos[1] = y; this.sweepPos[2] = VISUAL.chromeZ
    this.sweepPos[3] = halfW; this.sweepPos[4] = y; this.sweepPos[5] = VISUAL.chromeZ
    ;(this.sweep.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }

  clear(): void {
    for (const child of this.group.children.slice()) this.group.remove(child)
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.sweep = null
    this.sweepPos = null
  }
}
