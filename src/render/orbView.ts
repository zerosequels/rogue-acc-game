/**
 * orbView.ts — tokens, their activation trails, and the launcher.
 *
 * Trails are the single most important piece of feedback in the game: they are
 * how a cascade reads as a *path through layers* rather than a dot jittering
 * about. Each orb owns a fixed-length ring buffer of positions drawn as a
 * tapering, fading line.
 *
 * Orb count is hard-capped at LAUNCH.maxOrbsHardCap, so allocating all meshes
 * and trail buffers up front is cheap and avoids any mid-cascade GC.
 */

import * as THREE from 'three'
import { COLORS, LAUNCH, ORB, VISUAL } from '../config/balance'
import type { OrbHandle } from '../sim/physics'

interface OrbVisual {
  mesh: THREE.Mesh
  line: THREE.Line
  positions: Float32Array
  colors: Float32Array
  /** Ring buffer of recent world positions, newest last. */
  history: number[]
  inUse: boolean
  orbId: number
}

const TRAIL = VISUAL.trailLength

export class OrbView {
  readonly group = new THREE.Group()
  private pool: OrbVisual[] = []
  private byOrb = new Map<number, OrbVisual>()
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  // launcher visuals
  private barrel: THREE.Mesh
  private aimLine: THREE.Line
  private aimPositions: Float32Array
  private predictLine: THREE.Line
  private predictPositions: Float32Array

  constructor() {
    const orbGeo = new THREE.CircleGeometry(ORB.radius, 14)
    const haloGeo = new THREE.CircleGeometry(ORB.radius * 2.4, 14)
    this.disposables.push(orbGeo, haloGeo)

    for (let i = 0; i < LAUNCH.maxOrbsHardCap; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS.orb, toneMapped: false })
      const haloMat = new THREE.MeshBasicMaterial({
        color: COLORS.orb,
        transparent: true,
        opacity: 0.2,
        toneMapped: false,
      })
      this.disposables.push(mat, haloMat)

      const mesh = new THREE.Mesh(orbGeo, mat)
      const halo = new THREE.Mesh(haloGeo, haloMat)
      halo.position.z = -0.01
      mesh.add(halo)
      mesh.visible = false
      mesh.position.z = 0.2
      this.group.add(mesh)

      const positions = new Float32Array(TRAIL * 3)
      const colors = new Float32Array(TRAIL * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      })
      this.disposables.push(geo, lineMat)
      const line = new THREE.Line(geo, lineMat)
      line.visible = false
      line.position.z = 0.15
      line.frustumCulled = false
      this.group.add(line)

      this.pool.push({ mesh, line, positions, colors, history: [], inUse: false, orbId: -1 })
    }

    // --- launcher barrel ---
    const barrelGeo = new THREE.PlaneGeometry(0.22, 2.2)
    const barrelMat = new THREE.MeshBasicMaterial({ color: COLORS.pinLit, toneMapped: false })
    this.disposables.push(barrelGeo, barrelMat)
    this.barrel = new THREE.Mesh(barrelGeo, barrelMat)
    this.barrel.position.set(0, LAUNCH.originY, 0.1)
    this.group.add(this.barrel)

    // --- straight aim guide ---
    this.aimPositions = new Float32Array(2 * 3)
    const aimGeo = new THREE.BufferGeometry()
    aimGeo.setAttribute('position', new THREE.BufferAttribute(this.aimPositions, 3))
    const aimMat = new THREE.LineDashedMaterial({
      color: COLORS.pinLit,
      dashSize: 0.3,
      gapSize: 0.25,
      transparent: true,
      opacity: 0.45,
      toneMapped: false,
    })
    this.disposables.push(aimGeo, aimMat)
    this.aimLine = new THREE.Line(aimGeo, aimMat)
    this.aimLine.position.z = 0.05
    this.aimLine.frustumCulled = false
    this.group.add(this.aimLine)

    // --- predicted ballistic arc (Attention Mask) ---
    const maxPredict = 256
    this.predictPositions = new Float32Array(maxPredict * 3)
    const pGeo = new THREE.BufferGeometry()
    pGeo.setAttribute('position', new THREE.BufferAttribute(this.predictPositions, 3))
    pGeo.setDrawRange(0, 0)
    const pMat = new THREE.LineBasicMaterial({
      color: COLORS.critical,
      transparent: true,
      opacity: 0.5,
      toneMapped: false,
    })
    this.disposables.push(pGeo, pMat)
    this.predictLine = new THREE.Line(pGeo, pMat)
    this.predictLine.position.z = 0.06
    this.predictLine.frustumCulled = false
    this.group.add(this.predictLine)
  }

  /** Bind a sim orb to a free visual slot. */
  acquire(orb: OrbHandle): void {
    const slot = this.pool.find((p) => !p.inUse)
    if (!slot) return
    slot.inUse = true
    slot.orbId = orb.id
    slot.history = [orb.x, orb.y]
    slot.mesh.visible = true
    slot.line.visible = true
    slot.mesh.position.set(orb.x, orb.y, 0.2)
    this.byOrb.set(orb.id, slot)
  }

  release(orbId: number): void {
    const slot = this.byOrb.get(orbId)
    if (!slot) return
    slot.inUse = false
    slot.orbId = -1
    slot.mesh.visible = false
    slot.line.visible = false
    slot.history = []
    this.byOrb.delete(orbId)
  }

  releaseAll(): void {
    for (const id of Array.from(this.byOrb.keys())) this.release(id)
  }

  /**
   * Sync visuals to sim state. `heat` (0..1) shifts orb colour from lime toward
   * magenta so a Rogue-temperature token is visually unmistakable.
   */
  update(orbs: readonly OrbHandle[], heat: number): void {
    const hot = new THREE.Color(COLORS.orbHot)
    const cool = new THREE.Color(COLORS.orb)
    const tint = cool.clone().lerp(hot, heat)

    for (const orb of orbs) {
      let slot = this.byOrb.get(orb.id)
      if (!slot) {
        this.acquire(orb)
        slot = this.byOrb.get(orb.id)
        if (!slot) continue
      }

      slot.mesh.position.set(orb.x, orb.y, 0.2)
      const mat = slot.mesh.material as THREE.MeshBasicMaterial
      mat.color.copy(tint)
      const halo = slot.mesh.children[0] as THREE.Mesh | undefined
      if (halo) {
        const hm = halo.material as THREE.MeshBasicMaterial
        hm.color.copy(tint)
        // Halo swells with speed: fast tokens look energetic.
        const speed = Math.hypot(orb.vx, orb.vy) / ORB.maxSpeed
        halo.scale.setScalar(0.7 + speed * 0.8)
        hm.opacity = 0.12 + speed * 0.22
      }

      // --- trail ---
      slot.history.push(orb.x, orb.y)
      const maxLen = TRAIL * 2
      if (slot.history.length > maxLen) {
        slot.history.splice(0, slot.history.length - maxLen)
      }
      this.writeTrail(slot, tint)
    }
  }

  private writeTrail(slot: OrbVisual, tint: THREE.Color): void {
    const pts = slot.history.length / 2
    const geo = slot.line.geometry
    for (let i = 0; i < pts; i++) {
      const x = slot.history[i * 2]!
      const y = slot.history[i * 2 + 1]!
      slot.positions[i * 3] = x
      slot.positions[i * 3 + 1] = y
      slot.positions[i * 3 + 2] = 0
      // Fade toward the tail; newest sample is full brightness.
      const a = pts <= 1 ? 1 : i / (pts - 1)
      const f = a * a
      slot.colors[i * 3] = tint.r * f
      slot.colors[i * 3 + 1] = tint.g * f
      slot.colors[i * 3 + 2] = tint.b * f
    }
    geo.setDrawRange(0, Math.max(0, pts))
    ;(geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }

  /** Update the launcher barrel, aim guide and optional predicted arc. */
  updateLauncher(
    angle: number,
    charge: number,
    predicted: readonly { x: number; y: number }[],
    visible: boolean,
  ): void {
    this.barrel.visible = visible
    this.aimLine.visible = visible
    this.predictLine.visible = visible && predicted.length > 1

    if (!visible) return

    this.barrel.rotation.z = -angle
    this.barrel.position.set(Math.sin(angle) * 0.9, LAUNCH.originY - Math.cos(angle) * 0.9, 0.1)
    const bm = this.barrel.material as THREE.MeshBasicMaterial
    bm.color.setHex(COLORS.pinLit).lerp(new THREE.Color(COLORS.orbHot), charge)
    this.barrel.scale.set(1 + charge * 0.5, 1, 1)

    // Aim guide: short dashed ray from the muzzle.
    const len = 2.6 + charge * 2.4
    const mx = Math.sin(angle) * 1.9
    const my = LAUNCH.originY - Math.cos(angle) * 1.9
    this.aimPositions[0] = mx
    this.aimPositions[1] = my
    this.aimPositions[2] = 0
    this.aimPositions[3] = mx + Math.sin(angle) * len
    this.aimPositions[4] = my - Math.cos(angle) * len
    this.aimPositions[5] = 0
    const ap = this.aimLine.geometry.getAttribute('position') as THREE.BufferAttribute
    ap.needsUpdate = true
    this.aimLine.computeLineDistances()

    if (predicted.length > 1) {
      const n = Math.min(predicted.length, this.predictPositions.length / 3)
      for (let i = 0; i < n; i++) {
        const p = predicted[i]!
        this.predictPositions[i * 3] = p.x
        this.predictPositions[i * 3 + 1] = p.y
        this.predictPositions[i * 3 + 2] = 0
      }
      this.predictLine.geometry.setDrawRange(0, n)
      ;(this.predictLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }
}
