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
import { makeShellMaterial, prepareInstanced } from './shell'

/**
 * A single-instance mesh on the shell material. Tokens are few, but routing
 * them through the same instanced path as the board means one shader, one set
 * of per-object channels, and no second code path to keep in sync.
 */
interface Single {
  mesh: THREE.InstancedMesh
  col: THREE.InstancedBufferAttribute
  param: THREE.InstancedBufferAttribute
}

function makeSingle(geo: THREE.BufferGeometry, mat: THREE.Material): Single {
  const { col, param } = prepareInstanced(geo, 1)
  const mesh = new THREE.InstancedMesh(geo, mat, 1)
  mesh.frustumCulled = false
  const m = new THREE.Matrix4()
  mesh.setMatrixAt(0, m)
  mesh.instanceMatrix.needsUpdate = true
  return { mesh, col, param }
}

function setSingle(s: Single, colour: THREE.Color, energy: number, gridLat: number, gridLon: number): void {
  s.col.setXYZ(0, colour.r, colour.g, colour.b)
  s.param.setXYZW(0, energy, gridLat, gridLon, 0)
  s.col.needsUpdate = true
  s.param.needsUpdate = true
}

interface OrbVisual {
  core: Single
  shell: Single
  /** Comet echoes strung down the trail, newest first. */
  echoes: Single[]
  line: THREE.Line
  positions: Float32Array
  colors: Float32Array
  /** Ring buffer of recent world positions, newest last. */
  history: number[]
  inUse: boolean
  orbId: number
}

const TRAIL = VISUAL.trailLength
const COOL = new THREE.Color(COLORS.orb)
const HOT = new THREE.Color(COLORS.orbHot)
const BARREL_COL = new THREE.Color()

export class OrbView {
  readonly group = new THREE.Group()
  private pool: OrbVisual[] = []
  private byOrb = new Map<number, OrbVisual>()
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  // launcher visuals
  private barrel!: Single
  private barrelMat!: THREE.ShaderMaterial
  private aimLine: THREE.Line
  private aimPositions: Float32Array
  private predictLine: THREE.Line
  private predictPositions: Float32Array

  constructor() {
    // A token is two concentric emissive bodies: a hard plasma core and a
    // wider wireframe shell. The core is what the eye tracks; the shell is
    // what makes it read as a volume rather than a dot.
    const coreGeo = new THREE.SphereGeometry(ORB.radius * 0.45, 16, 12)
    const shellGeo = new THREE.SphereGeometry(ORB.radius * 1.15, 28, 20)
    this.disposables.push(coreGeo, shellGeo)

    for (let i = 0; i < LAUNCH.maxOrbsHardCap; i++) {
      const coreMat = makeShellMaterial({ rimGain: 2.4, gridGain: 0, floor: 1.4 })
      const shellMat = makeShellMaterial({ rimPower: 1.5, rimGain: 1.5, gridGain: 0.7 })
      this.disposables.push(coreMat, shellMat)

      // One instance each: the shell shader reads per-instance attributes, so
      // even a single token goes through the same path as the board.
      const core = makeSingle(coreGeo.clone(), coreMat)
      const shell = makeSingle(shellGeo.clone(), shellMat)
      this.disposables.push(core.mesh.geometry, shell.mesh.geometry)
      core.mesh.visible = false
      shell.mesh.visible = false
      core.mesh.position.z = 0.22
      shell.mesh.position.z = 0.2
      this.group.add(shell.mesh, core.mesh)

      const positions = new Float32Array(TRAIL * 3)
      const colors = new Float32Array(TRAIL * 3)
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      const lineMat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      })
      this.disposables.push(geo, lineMat)
      const line = new THREE.Line(geo, lineMat)
      line.visible = false
      line.position.z = 0.15
      line.frustumCulled = false
      this.group.add(line)

      // LESSON 4 (matharium): motion history IS the image. A line cannot
      // taper in width, so the trail gets a string of shrinking echo shells
      // behind the core — the comet read, for ten extra instances.
      const echoes: Single[] = []
      for (let e = 0; e < VISUAL.trailEchoes; e++) {
        const em = makeShellMaterial({ rimGain: 1.3, gridGain: 0, floor: 0.5, coreGain: 1.1 })
        this.disposables.push(em)
        const echo = makeSingle(shellGeo.clone(), em)
        this.disposables.push(echo.mesh.geometry)
        echo.mesh.visible = false
        echo.mesh.position.z = 0.18
        this.group.add(echo.mesh)
        echoes.push(echo)
      }

      this.pool.push({
        core, shell, echoes, line, positions, colors,
        history: [], inUse: false, orbId: -1,
      })
    }

    // --- launcher barrel: an emissive conduit ---
    const barrelGeo = new THREE.CylinderGeometry(0.10, 0.10, 2.0, 8, 1, true)
    this.barrelMat = makeShellMaterial({ rimGain: 1.9, gridGain: 0, floor: 0.5 })
    this.disposables.push(barrelGeo, this.barrelMat)
    this.barrel = makeSingle(barrelGeo, this.barrelMat)
    this.barrel.mesh.position.set(0, LAUNCH.originY, 0.1)
    this.group.add(this.barrel.mesh)

    // --- straight aim guide ---
    this.aimPositions = new Float32Array(2 * 3)
    const aimGeo = new THREE.BufferGeometry()
    aimGeo.setAttribute('position', new THREE.BufferAttribute(this.aimPositions, 3))
    const aimMat = new THREE.LineDashedMaterial({
      color: COLORS.pinLit, dashSize: 0.3, gapSize: 0.25,
      transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
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
      color: COLORS.critical, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
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
    slot.core.mesh.visible = true
    slot.shell.mesh.visible = true
    slot.line.visible = true
    for (const e of slot.echoes) e.mesh.visible = true
    slot.core.mesh.position.set(orb.x, orb.y, 0.22)
    slot.shell.mesh.position.set(orb.x, orb.y, 0.2)
    this.byOrb.set(orb.id, slot)
  }

  release(orbId: number): void {
    const slot = this.byOrb.get(orbId)
    if (!slot) return
    slot.inUse = false
    slot.orbId = -1
    slot.core.mesh.visible = false
    slot.shell.mesh.visible = false
    slot.line.visible = false
    for (const e of slot.echoes) e.mesh.visible = false
    slot.history = []
    this.byOrb.delete(orbId)
  }

  releaseAll(): void {
    for (const id of Array.from(this.byOrb.keys())) this.release(id)
  }

  /**
   * Sync visuals to sim state. `heat` shifts the token toward magenta as a
   * pass works harder, and speed drives both the shell's grid density and the
   * core's energy — a fast token is visibly more excited.
   */
  update(orbs: readonly OrbHandle[], heat: number): void {
    const tint = COOL.clone().lerp(HOT, heat)

    for (const orb of orbs) {
      let slot = this.byOrb.get(orb.id)
      if (!slot) {
        this.acquire(orb)
        slot = this.byOrb.get(orb.id)
        if (!slot) continue
      }

      slot.core.mesh.position.set(orb.x, orb.y, 0.22)
      slot.shell.mesh.position.set(orb.x, orb.y, 0.2)

      const speed = Math.min(1, Math.hypot(orb.vx, orb.vy) / ORB.maxSpeed)
      setSingle(slot.core, tint, VISUAL.tokenCoreEnergy + speed * 1.6, 0, 0)
      setSingle(
        slot.shell, tint,
        VISUAL.tokenShellEnergy + speed * 0.5,
        VISUAL.tokenGrid, VISUAL.tokenGrid * 1.4,
      )

      // Echoes sample back through the history at a fixed stride, shrinking
      // and dimming as they go.
      const pts = slot.history.length / 2
      for (let e = 0; e < slot.echoes.length; e++) {
        const back = (e + 1) * VISUAL.trailEchoSpacing
        const idx = pts - 1 - back
        const echo = slot.echoes[e]!
        if (idx < 1) { echo.mesh.visible = false; continue }
        echo.mesh.visible = true
        const f = 1 - e / slot.echoes.length
        echo.mesh.position.set(slot.history[idx * 2]!, slot.history[idx * 2 + 1]!, 0.18)
        echo.mesh.scale.setScalar(f * f * 0.9)
        setSingle(echo, tint, f * f * 1.4, 0, 0)
      }

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
      const a = pts <= 1 ? 1 : i / (pts - 1)
      const f = a * a * a
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
    this.barrel.mesh.visible = visible
    this.aimLine.visible = visible
    this.predictLine.visible = visible && predicted.length > 1

    if (!visible) return

    this.barrel.mesh.rotation.z = -angle
    this.barrel.mesh.position.set(
      Math.sin(angle) * 1.0, LAUNCH.originY - Math.cos(angle) * 1.0, 0.1,
    )
    // The barrel charges visibly: energy and width both climb with the pull.
    BARREL_COL.setHex(COLORS.pinLit).lerp(HOT, charge)
    setSingle(this.barrel, BARREL_COL, 0.7 + charge * 2.4, 0, 0)
    this.barrel.mesh.scale.set(1 + charge * 0.45, 1, 1 + charge * 0.45)

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

  /** Advance the shared shader clock for every token material. */
  tick(time: number): void {
    for (const p of this.pool) {
      ;(p.core.mesh.material as THREE.ShaderMaterial).uniforms.uTime!.value = time
      ;(p.shell.mesh.material as THREE.ShaderMaterial).uniforms.uTime!.value = time
      for (const e of p.echoes) {
        ;(e.mesh.material as THREE.ShaderMaterial).uniforms.uTime!.value = time
      }
    }
    this.barrelMat.uniforms.uTime!.value = time
  }
}
