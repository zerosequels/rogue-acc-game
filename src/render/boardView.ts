/**
 * boardView.ts — meshes for one board: weights, rails, pockets, launcher.
 *
 * Pins are drawn with two InstancedMeshes (ordinary + critical) so 140 glowing
 * weights cost two draw calls instead of 140. Per-pin colour lives in an
 * instanceColor buffer, which is what lets a strike flash cyan and fade back
 * without touching the scene graph.
 *
 * Depth tinting by layer is deliberate: it makes the board read as a stack of
 * layers rather than a flat field of dots, which is the whole metaphor.
 */

import * as THREE from 'three'
import { BOARD, COLORS, PIN, VISUAL } from '../config/balance'
import type { Board, PinDef } from '../sim/board'

const DUMMY = new THREE.Object3D()
const COL = new THREE.Color()
const COL_B = new THREE.Color()

interface PinVisual {
  pin: PinDef
  /** Instance slot in whichever mesh owns it. */
  slot: number
  critical: boolean
  /** Seconds of flash remaining. */
  flash: number
  /** True once struck this pass — drawn dimmer so the player sees the path. */
  spent: boolean
}

export class BoardView {
  readonly group = new THREE.Group()

  private normalMesh: THREE.InstancedMesh | null = null
  private criticalMesh: THREE.InstancedMesh | null = null
  private visuals = new Map<number, PinVisual>()
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = []

  constructor() {
    this.group.position.z = 0
  }

  build(board: Board): void {
    this.clear()

    const normals: PinDef[] = []
    const criticals: PinDef[] = []
    for (const pin of board.pins) {
      if (pin.removed) continue
      ;(pin.critical ? criticals : normals).push(pin)
    }

    this.normalMesh = this.makePinMesh(normals, PIN.radius, false, board)
    this.criticalMesh = this.makePinMesh(criticals, PIN.criticalRadius, true, board)
    if (this.normalMesh) this.group.add(this.normalMesh)
    if (this.criticalMesh) this.group.add(this.criticalMesh)

    this.buildFrame(board)
    this.buildPockets(board)
  }

  private makePinMesh(
    pins: PinDef[],
    radius: number,
    critical: boolean,
    board: Board,
  ): THREE.InstancedMesh | null {
    if (pins.length === 0) return null

    // Low-poly circles: at this scale nobody counts the segments, and the
    // bloom pass softens the silhouette anyway.
    const geo = new THREE.CircleGeometry(radius, critical ? 6 : 12)
    // NOTE: do NOT set vertexColors here. InstancedMesh per-instance colour
    // comes from the `instanceColor` attribute, which three wires up on the
    // first setColorAt(). Setting vertexColors makes the shader look for a
    // per-vertex `color` attribute on the geometry instead — CircleGeometry
    // has none, so every pin renders black.
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false })
    this.disposables.push(geo, mat)

    const mesh = new THREE.InstancedMesh(geo, mat, pins.length)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    for (let i = 0; i < pins.length; i++) {
      const pin = pins[i]!
      DUMMY.position.set(pin.x, pin.y, critical ? 0.02 : 0)
      DUMMY.rotation.z = critical ? Math.PI / 6 : 0
      DUMMY.scale.setScalar(1)
      DUMMY.updateMatrix()
      mesh.setMatrixAt(i, DUMMY.matrix)

      mesh.setColorAt(i, this.restColor(pin, board, COL))
      this.visuals.set(pin.id, { pin, slot: i, critical, flash: 0, spent: false })
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return mesh
  }

  /** Resting colour: deeper layers sit cooler, so depth reads at a glance. */
  private restColor(pin: PinDef, board: Board, target: THREE.Color): THREE.Color {
    if (pin.critical) return target.setHex(COLORS.critical)
    const depth = board.layers <= 1 ? 0 : pin.layer / (board.layers - 1)
    target.setHex(COLORS.pin)
    const hsl = { h: 0, s: 0, l: 0 }
    target.getHSL(hsl)
    // Cooler and a little dimmer with depth, but never so dark that a weight
    // stops reading as a lit node against the substrate.
    target.setHSL(hsl.h + depth * 0.03, hsl.s * (1 - depth * 0.15), hsl.l * (1 - depth * 0.18))
    return target
  }

  private buildFrame(board: Board): void {
    const t = BOARD.wallThickness
    const halfW = BOARD.width / 2
    const topY = BOARD.top
    const mat = new THREE.MeshBasicMaterial({ color: COLORS.wall, toneMapped: false })
    this.disposables.push(mat)

    const addBox = (w: number, h: number, x: number, y: number) => {
      const geo = new THREE.PlaneGeometry(w, h)
      this.disposables.push(geo)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, y, -0.05)
      this.group.add(mesh)
    }

    const height = topY - board.floorY
    addBox(t, height, -halfW + t / 2, board.floorY + height / 2)
    addBox(t, height, halfW - t / 2, board.floorY + height / 2)
    addBox(BOARD.width, t, 0, board.floorY - t / 2)

    // Opaque backing. Without this the animated substrate shows straight
    // through the playfield and the board stops reading as a solid object.
    const backGeo = new THREE.PlaneGeometry(BOARD.width - t * 2, height)
    const backMat = new THREE.MeshBasicMaterial({
      color: 0x05090f,
      transparent: true,
      opacity: 0.96,
      toneMapped: false,
    })
    this.disposables.push(backGeo, backMat)
    const back = new THREE.Mesh(backGeo, backMat)
    back.position.set(0, board.floorY + height / 2, -0.07)
    this.group.add(back)

    // Faint layer bands behind the pins — the "depth" of the network.
    const bandMat = new THREE.MeshBasicMaterial({
      color: 0x0a1322,
      transparent: true,
      opacity: 0.5,
      toneMapped: false,
    })
    this.disposables.push(bandMat)
    const fieldTop = BOARD.top - 1.6
    const fieldBottom = board.pocketTopY + 0.9
    for (let i = 0; i < board.layers; i += 2) {
      const y0 = fieldTop - (i / board.layers) * (fieldTop - fieldBottom)
      const h = (fieldTop - fieldBottom) / board.layers
      const geo = new THREE.PlaneGeometry(BOARD.width - t * 2, h)
      this.disposables.push(geo)
      const mesh = new THREE.Mesh(geo, bandMat)
      mesh.position.set(0, y0 - h / 2, -0.06)
      this.group.add(mesh)
    }
  }

  private buildPockets(board: Board): void {
    const h = board.pocketTopY - board.floorY

    for (const pocket of board.pockets) {
      const color =
        pocket.kind === 'spike' ? COLORS.spike : pocket.kind === 'drain' ? COLORS.drain : COLORS.pocket
      const geo = new THREE.PlaneGeometry(pocket.halfWidth * 2, h)
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: pocket.kind === 'spike' ? 0.8 : pocket.kind === 'drain' ? 0.5 : 0.42,
        toneMapped: false,
      })
      this.disposables.push(geo, mat)
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(pocket.x, board.floorY + h / 2, -0.03)
      this.group.add(mesh)

      // Every pocket gets a bright mouth line. Reading the floor at a glance
      // is the whole point of aiming, so none of them may be ambiguous.
      const lipGeo = new THREE.PlaneGeometry(pocket.halfWidth * 2, pocket.kind === 'spike' ? 0.18 : 0.1)
      const lipMat = new THREE.MeshBasicMaterial({
        color: pocket.kind === 'spike' ? COLORS.spike : pocket.kind === 'drain' ? 0xd3405a : 0x4d8fc4,
        transparent: true,
        opacity: pocket.kind === 'spike' ? 1 : 0.75,
        toneMapped: false,
      })
      this.disposables.push(lipGeo, lipMat)
      const lip = new THREE.Mesh(lipGeo, lipMat)
      lip.position.set(pocket.x, board.pocketTopY, 0.02)
      this.group.add(lip)

      // Divider posts.
      for (const side of [-1, 1] as const) {
        const x = pocket.x + side * pocket.halfWidth
        if (Math.abs(x) >= BOARD.width / 2 - BOARD.wallThickness) continue
        const dGeo = new THREE.PlaneGeometry(0.14, h)
        const dMat = new THREE.MeshBasicMaterial({ color: 0x24405f, toneMapped: false })
        this.disposables.push(dGeo, dMat)
        const d = new THREE.Mesh(dGeo, dMat)
        d.position.set(x, board.floorY + h / 2, 0)
        this.group.add(d)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Per-frame state
  // -------------------------------------------------------------------------

  /** Flash a pin on strike. */
  strike(pin: PinDef): void {
    const v = this.visuals.get(pin.id)
    if (!v) return
    v.flash = VISUAL.pinFlashSeconds
    v.spent = true
  }

  /** Hide a pin removed mid-stage (pruning, detonation). */
  retire(pin: PinDef): void {
    const v = this.visuals.get(pin.id)
    if (!v) return
    const mesh = v.critical ? this.criticalMesh : this.normalMesh
    if (!mesh) return
    DUMMY.position.set(pin.x, pin.y, -5)
    DUMMY.scale.setScalar(0.001)
    DUMMY.rotation.z = 0
    DUMMY.updateMatrix()
    mesh.setMatrixAt(v.slot, DUMMY.matrix)
    mesh.instanceMatrix.needsUpdate = true
    this.visuals.delete(pin.id)
  }

  /** Clear the struck/spent marking at the start of a new pass. */
  resetPass(board: Board): void {
    for (const v of this.visuals.values()) {
      v.spent = false
      v.flash = 0
      this.writeColor(v, board)
    }
    // Both buffers must be flagged or the reset never reaches the GPU and the
    // previous pass's struck trail stays burned into the board.
    if (this.normalMesh?.instanceColor) this.normalMesh.instanceColor.needsUpdate = true
    if (this.criticalMesh?.instanceColor) this.criticalMesh.instanceColor.needsUpdate = true
  }

  update(dt: number, board: Board): void {
    let dirtyNormal = false
    let dirtyCritical = false
    for (const v of this.visuals.values()) {
      if (v.flash <= 0 && !v.spent) continue
      if (v.flash > 0) {
        v.flash = Math.max(0, v.flash - dt)
        if (v.critical) dirtyCritical = true
        else dirtyNormal = true
        this.writeColor(v, board)
      }
    }
    if (dirtyNormal && this.normalMesh?.instanceColor) this.normalMesh.instanceColor.needsUpdate = true
    if (dirtyCritical && this.criticalMesh?.instanceColor) {
      this.criticalMesh.instanceColor.needsUpdate = true
    }
  }

  private writeColor(v: PinVisual, board: Board): void {
    const mesh = v.critical ? this.criticalMesh : this.normalMesh
    if (!mesh) return

    // COL holds the baseline, COL_B the result. Both are module-level scratch
    // colours — this runs for every flashing pin every frame, so it must not
    // allocate.
    if (v.spent) COL.setHex(v.critical ? COLORS.critical : COLORS.pinSpent)
    else this.restColor(v.pin, board, COL)

    if (v.flash > 0) {
      const k = Math.min(1, v.flash / VISUAL.pinFlashSeconds)
      // Ease the flash out so the trail of struck weights stays readable.
      const eased = k * k
      COL_B.setHex(v.critical ? COLORS.criticalLit : COLORS.pinLit)
      COL_B.lerp(COL, 1 - eased)
      mesh.setColorAt(v.slot, COL_B)
    } else {
      mesh.setColorAt(v.slot, COL)
    }
  }

  clear(): void {
    for (const child of this.group.children.slice()) this.group.remove(child)
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.normalMesh = null
    this.criticalMesh = null
    this.visuals.clear()
  }
}
