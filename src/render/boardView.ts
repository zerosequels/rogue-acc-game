/**
 * boardView.ts — the network as volumetric holography.
 *
 * Public API is unchanged from the wireframe pass (`build`, `strike`, `pulse`,
 * `retire`, `revive`, `resetPass`, `update`, `flashEdge`, `setDeadLayers`,
 * `markLabelsDirty`, `clear`), so nothing outside `render/` had to move.
 *
 * What changed is everything below that line. Flat rings became dense
 * spheres; the wireframe moved from geometry into the shader; the hairline
 * edges became emissive conduits with travelling beads; and brightness is now
 * a per-instance ENERGY channel rather than a colour swap.
 *
 * Energy has three independent sources, summed per frame:
 *   rest       a low uniform floor, so a board at rest is calm and readable
 *   proximity  distance to the nearest token in flight — the hologram's
 *              answer to a carried light, costing one subtraction per node
 *   events     strike and signal flares, which decay
 */

import * as THREE from 'three'
import { BOARD, COLORS, PIN, VISUAL } from '../config/balance'
import {
  isAttentionHead,
  NODE_TRANSFORM_LABEL,
  BUCKET_TRANSFORM_LABEL,
  type Board,
  type NodeDef,
} from '../sim/board'
import { makeShellMaterial, prepareInstanced } from './shell'

const DUMMY = new THREE.Object3D()
const COL = new THREE.Color()

interface NodeVisual {
  node: NodeDef
  slot: number
  head: boolean
  /** Contact flare, decays. Marks the node spent for the pass. */
  flash: number
  /** Signal pulse, decays. Does NOT mark the node spent. */
  pulseAmt: number
  spent: boolean
  /** Proximity excitation from tokens in flight, recomputed per frame. */
  near: number
}

interface Band {
  mesh: THREE.InstancedMesh
  col: THREE.InstancedBufferAttribute
  param: THREE.InstancedBufferAttribute
}

export class BoardView {
  readonly group = new THREE.Group()

  private nodeBand: Band | null = null
  private headBand: Band | null = null
  /** Nested inner shells for levelled weights. Energy-driven with the rest. */
  private shellBand: Band | null = null
  private edgeBand: Band | null = null    // conduits
  private beadBand: Band | null = null    // travelling signal beads

  private material = makeShellMaterial()
  private beadMaterial = makeShellMaterial({ rimGain: 2.6, gridGain: 0, floor: 1.2 })

  private visuals = new Map<number, NodeVisual>()
  private retiredSlots = new Map<number, number>()
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  /** Per-edge pulse state, indexed as `board.edges`. */
  private edgeState: { flash: number; bead: number; active: boolean }[] = []
  private edgePairs: { a: NodeDef; b: NodeDef }[] = []

  private labelCanvas: HTMLCanvasElement | null = null
  private labelTexture: THREE.CanvasTexture | null = null
  private labelsDirty = true
  private deadLayers = 0
  private time = 0
  /** Shop mode: the net dims so the panel and the preview can carry focus. */
  private muted = false
  /** Weights a hovered shop item would hit. */
  private preview = new Set<number>()
  private previewBuckets = new Set<number>()

  constructor() {
    this.group.position.z = 0
    this.disposables.push(this.material, this.beadMaterial)
  }

  build(board: Board): void {
    this.clear()
    this.buildFrame(board)
    this.buildEdges(board)

    const plain: NodeDef[] = []
    const heads: NodeDef[] = []
    for (const n of board.nodes) {
      if (n.removed) continue
      ;(isAttentionHead(n) ? heads : plain).push(n)
    }

    this.nodeBand = this.buildNodes(plain, false, board)
    this.headBand = this.buildNodes(heads, true, board)
    this.buildInnerShells(plain, board)
    this.buildBuckets(board)
    this.buildLabelLayer(board)
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private band(geo: THREE.BufferGeometry, mat: THREE.Material, count: number, z: number): Band {
    const { col, param } = prepareInstanced(geo, count)
    const mesh = new THREE.InstancedMesh(geo, mat, count)
    mesh.frustumCulled = false
    mesh.position.z = z
    this.disposables.push(geo)
    this.group.add(mesh)
    return { mesh, col, param }
  }

  /**
   * Dense spheres. The previous pass used a 12-segment ring and read as
   * low-poly; at 40x26 there is no visible facet anywhere, and the wireframe
   * comes from the shader rather than from these triangles.
   */
  private buildNodes(nodes: NodeDef[], head: boolean, board: Board): Band | null {
    if (nodes.length === 0) return null
    const geo = head
      ? new THREE.OctahedronGeometry(1, 0)
      : new THREE.SphereGeometry(1, VISUAL.shellSegments, VISUAL.shellRings)
    const b = this.band(geo, this.material, nodes.length, head ? 0.03 : 0.02)

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      const r = head ? PIN.criticalRadius * VISUAL.headScale : PIN.radius * VISUAL.shellScale
      DUMMY.position.set(n.x, n.y, 0)
      DUMMY.rotation.set(0, 0, head ? Math.PI / 6 : 0)
      DUMMY.scale.setScalar(r)
      DUMMY.updateMatrix()
      b.mesh.setMatrixAt(i, DUMMY.matrix)
      this.visuals.set(n.id, {
        node: n, slot: i, head, flash: 0, pulseAmt: 0, spent: false, near: 0,
      })
    }
    b.mesh.instanceMatrix.needsUpdate = true
    this.writeBand(b, head, board)
    return b
  }

  /**
   * Nested inner shells for levelled weights. Level reads three ways at once —
   * scale, grid density and shell count — and all three are free here.
   */
  private buildInnerShells(nodes: NodeDef[], board: Board): void {
    const inner: { node: NodeDef; depth: number }[] = []
    for (const n of nodes) {
      const shells = Math.min(VISUAL.maxInnerShells, Math.floor(n.level / VISUAL.levelsPerShell))
      for (let k = 1; k <= shells; k++) inner.push({ node: n, depth: k })
    }
    if (inner.length === 0) return

    const geo = new THREE.SphereGeometry(1, VISUAL.shellSegments, VISUAL.shellRings)
    const b = this.band(geo, this.material, inner.length, 0.021)
    for (let i = 0; i < inner.length; i++) {
      const { node, depth } = inner[i]!
      DUMMY.position.set(node.x, node.y, 0)
      DUMMY.rotation.set(0, 0, 0)
      DUMMY.scale.setScalar(PIN.radius * VISUAL.shellScale * (1 - depth * 0.26))
      DUMMY.updateMatrix()
      b.mesh.setMatrixAt(i, DUMMY.matrix)
      COL.setHex(COLORS.pinLit)
      b.col.setXYZ(i, COL.r, COL.g, COL.b)
      b.param.setXYZW(i, 0.4, 5 + node.level, 7 + node.level, 0)
    }
    b.mesh.instanceMatrix.needsUpdate = true
    b.col.needsUpdate = true
    b.param.needsUpdate = true
    this.shellBand = b
    void board
  }

  /**
   * Conduits. Each edge is a thin cylinder oriented between its endpoints,
   * plus a bead instance that rides it when signal fires.
   */
  private buildEdges(board: Board): void {
    if (board.edges.length === 0) return
    const byId = new Map(board.nodes.map((n) => [n.id, n]))

    const pairs: { a: NodeDef; b: NodeDef }[] = []
    for (const e of board.edges) {
      const a = byId.get(e.from)
      const b = byId.get(e.to)
      if (a && b) pairs.push({ a, b })
      this.edgeState.push({ flash: 0, bead: 0, active: false })
    }
    this.edgePairs = pairs
    if (pairs.length === 0) return

    // A unit cylinder along +Y, so orienting it is one quaternion per edge.
    const geo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true)
    const band = this.band(geo, this.material, pairs.length, -0.01)

    const up = new THREE.Vector3(0, 1, 0)
    const dir = new THREE.Vector3()
    const q = new THREE.Quaternion()
    for (let i = 0; i < pairs.length; i++) {
      const { a, b } = pairs[i]!
      dir.set(b.x - a.x, b.y - a.y, 0)
      const len = dir.length()
      dir.normalize()
      q.setFromUnitVectors(up, dir)
      DUMMY.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, 0)
      DUMMY.quaternion.copy(q)
      DUMMY.scale.set(VISUAL.conduitRadius, len, VISUAL.conduitRadius)
      DUMMY.updateMatrix()
      band.mesh.setMatrixAt(i, DUMMY.matrix)
    }
    band.mesh.instanceMatrix.needsUpdate = true
    this.edgeBand = band

    const beadGeo = new THREE.SphereGeometry(1, 10, 8)
    this.beadBand = this.band(beadGeo, this.beadMaterial, pairs.length, 0.05)
    this.writeEdges()
  }

  private buildFrame(board: Board): void {
    const t = BOARD.wallThickness
    const height = BOARD.top - board.floorY

    // Opaque backing. Rendered first and writing depth, so the substrate does
    // not show through the playfield and anything behind it is hidden.
    const backGeo = new THREE.PlaneGeometry(BOARD.width - t * 2, height)
    const backMat = new THREE.MeshBasicMaterial({
      color: 0x010206, transparent: true, opacity: 0.97, toneMapped: false,
    })
    this.disposables.push(backGeo, backMat)
    const back = new THREE.Mesh(backGeo, backMat)
    back.position.set(0, board.floorY + height / 2, -0.12)
    back.renderOrder = -2
    this.group.add(back)

    // Rails as emissive outlines.
    const halfW = BOARD.width / 2
    const pts: number[] = []
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      pts.push(x0, y0, 0, x1, y0, 0, x1, y0, 0, x1, y1, 0)
      pts.push(x1, y1, 0, x0, y1, 0, x0, y1, 0, x0, y0, 0)
    }
    rect(-halfW + t, board.floorY, halfW - t, BOARD.top)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: COLORS.wall, transparent: true, opacity: 0.85, toneMapped: false,
    })
    this.disposables.push(geo, mat)
    this.group.add(new THREE.LineSegments(geo, mat))
  }

  /** Output tokens as open holographic wells. */
  private buildBuckets(board: Board): void {
    const pts: number[] = []
    const cols: number[] = []
    const c = new THREE.Color()

    for (const p of board.pockets) {
      const colour = p.kind === 'spike' ? COLORS.spike
        : p.kind === 'drain' ? COLORS.drainLine : COLORS.pocketLine
      c.setHex(colour)
      const x0 = p.x - p.halfWidth, x1 = p.x + p.halfWidth
      const y0 = board.floorY, y1 = board.pocketTopY
      const seg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
        pts.push(ax, ay, az, bx, by, bz)
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
      // A shallow box rather than a flat outline — the well has depth now.
      const d = VISUAL.bucketDepth
      for (const z of [0, -d]) {
        seg(x0, y1, z, x0, y0, z); seg(x1, y1, z, x1, y0, z); seg(x0, y0, z, x1, y0, z)
      }
      seg(x0, y1, 0, x0, y1, -d); seg(x1, y1, 0, x1, y1, -d)
      seg(x0, y0, 0, x0, y0, -d); seg(x1, y0, 0, x1, y0, -d)
      seg(x0, y1 + 0.07, 0, x1, y1 + 0.07, 0)
    }
    if (pts.length === 0) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    })
    this.disposables.push(geo, mat)
    this.group.add(new THREE.LineSegments(geo, mat))
  }

  // -------------------------------------------------------------------------
  // Glyph labels — one CanvasTexture, redrawn only on state change
  // -------------------------------------------------------------------------

  private buildLabelLayer(board: Board): void {
    const w = BOARD.width
    const h = BOARD.top - board.floorY
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(w * VISUAL.labelPixelsPerUnit)
    canvas.height = Math.round(h * VISUAL.labelPixelsPerUnit)
    this.labelCanvas = canvas

    const tex = new THREE.CanvasTexture(canvas)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    this.labelTexture = tex
    this.disposables.push(tex)

    const geo = new THREE.PlaneGeometry(w, h)
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, toneMapped: false,
    })
    this.disposables.push(geo, mat)
    const quad = new THREE.Mesh(geo, mat)
    quad.position.set(0, board.floorY + h / 2, VISUAL.labelZ)
    quad.renderOrder = 10
    this.group.add(quad)

    this.labelsDirty = true
    this.redrawLabels(board)
  }

  markLabelsDirty(): void { this.labelsDirty = true }

  private redrawLabels(board: Board): void {
    const canvas = this.labelCanvas
    const tex = this.labelTexture
    if (!canvas || !tex) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ppu = VISUAL.labelPixelsPerUnit
    const cx = (x: number) => (x + BOARD.width / 2) * ppu
    const cy = (y: number) => (BOARD.top - y) * ppu

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (const n of board.nodes) {
      if (n.removed) continue
      const head = isAttentionHead(n)
      if (n.level > 1) {
        ctx.font = `700 ${Math.round(ppu * 0.23)}px "JetBrains Mono", monospace`
        ctx.fillStyle = head ? '#ffdca8' : '#d6f4ff'
        ctx.fillText(String(n.level), cx(n.x), cy(n.y))
      }
      if (n.transforms.length > 0) {
        ctx.font = `500 ${Math.round(ppu * 0.2)}px "JetBrains Mono", monospace`
        ctx.fillStyle = head ? 'rgba(255,179,64,.95)' : 'rgba(90,228,255,.85)'
        ctx.fillText(
          n.transforms.map((t) => NODE_TRANSFORM_LABEL[t]).join('·'),
          cx(n.x), cy(n.y - n.radius - 0.3),
        )
      }
    }

    for (const p of board.pockets) {
      const midY = board.floorY + (board.pocketTopY - board.floorY) / 2
      ctx.font = `700 ${Math.round(ppu * 0.24)}px "JetBrains Mono", monospace`
      ctx.fillStyle = p.kind === 'spike' ? 'rgba(255,60,200,.95)'
        : p.kind === 'drain' ? 'rgba(211,64,90,.85)' : 'rgba(130,180,230,.9)'
      ctx.fillText(
        p.transform ? BUCKET_TRANSFORM_LABEL[p.transform] : `L${p.level}`,
        cx(p.x), cy(midY + 0.18),
      )
      ctx.font = `400 ${Math.round(ppu * 0.17)}px "JetBrains Mono", monospace`
      ctx.fillStyle = 'rgba(93,112,143,.9)'
      ctx.fillText(`TOK_${String(p.id).padStart(2, '0')}`, cx(p.x), cy(midY - 0.3))
    }

    tex.needsUpdate = true
    this.labelsDirty = false
  }

  // -------------------------------------------------------------------------
  // Events — unchanged API
  // -------------------------------------------------------------------------

  /** A ball contact. Consumes the weight for the pass, so it dims after. */
  strike(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    v.flash = VISUAL.pinFlashSeconds
    v.spent = true
  }

  /** A signal activation. Pulses but does NOT mark the weight spent. */
  pulse(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    v.pulseAmt = Math.max(v.pulseAmt, VISUAL.signalFlashSeconds)
  }

  /** Fire a bead down one conduit. */
  flashEdge(index: number): void {
    const e = this.edgeState[index]
    if (!e) return
    e.flash = 1
    e.bead = 0
    e.active = true
  }

  /** Dim the whole net. Used while the shop panel is open. */
  setMuted(muted: boolean, board: Board): void {
    if (this.muted === muted) return
    this.muted = muted
    this.writeAll(board)
  }

  /**
   * Highlight exactly the weights a hovered purchase would hit.
   *
   * The ids come from `resolveTargets` with the real purchase rng, so this
   * is not an illustration — it is the actual outcome. The player gets full
   * information about a selection that is still random.
   */
  setPreview(nodeIds: Iterable<number>, bucketIds: Iterable<number>, board: Board): void {
    this.preview = new Set(nodeIds)
    this.previewBuckets = new Set(bucketIds)
    this.writeAll(board)
  }

  clearPreview(board: Board): void {
    if (this.preview.size === 0 && this.previewBuckets.size === 0) return
    this.preview.clear()
    this.previewBuckets.clear()
    this.writeAll(board)
  }

  /** Bucket ids currently previewed, for the bucket geometry to read. */
  get previewedBuckets(): ReadonlySet<number> {
    return this.previewBuckets
  }

  setDeadLayers(count: number, board: Board): void {
    this.deadLayers = count
    this.writeAll(board)
  }

  private isDead(node: NodeDef, board: Board): boolean {
    return this.deadLayers > 0 && node.layer >= board.layers - this.deadLayers
  }

  retire(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    const band = v.head ? this.headBand : this.nodeBand
    if (!band) return
    DUMMY.position.set(node.x, node.y, -50)
    DUMMY.rotation.set(0, 0, 0)
    DUMMY.scale.setScalar(0.0001)
    DUMMY.updateMatrix()
    band.mesh.setMatrixAt(v.slot, DUMMY.matrix)
    band.mesh.instanceMatrix.needsUpdate = true
    this.retiredSlots.set(node.id, v.slot)
    this.visuals.delete(node.id)
  }

  revive(node: NodeDef, board: Board): void {
    if (this.visuals.has(node.id)) return
    const head = isAttentionHead(node)
    const band = head ? this.headBand : this.nodeBand
    const slot = this.retiredSlots.get(node.id)
    if (!band || slot === undefined) return
    const r = head ? PIN.criticalRadius * VISUAL.headScale : PIN.radius * VISUAL.shellScale
    DUMMY.position.set(node.x, node.y, 0)
    DUMMY.rotation.set(0, 0, head ? Math.PI / 6 : 0)
    DUMMY.scale.setScalar(r)
    DUMMY.updateMatrix()
    band.mesh.setMatrixAt(slot, DUMMY.matrix)
    band.mesh.instanceMatrix.needsUpdate = true
    this.visuals.set(node.id, {
      node, slot, head, flash: 0, pulseAmt: 0, spent: false, near: 0,
    })
    this.retiredSlots.delete(node.id)
    this.writeAll(board)
  }

  resetPass(board: Board): void {
    for (const v of this.visuals.values()) {
      v.spent = false
      v.flash = 0
      v.pulseAmt = 0
    }
    for (const e of this.edgeState) { e.flash = 0; e.bead = 0; e.active = false }
    this.writeAll(board)
    this.writeEdges()
  }

  // -------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------

  /**
   * `orbs` drives proximity excitation — the hologram's answer to a carried
   * light. Optional so the call site can omit it without breaking.
   */
  update(dt: number, board: Board, orbs?: readonly { x: number; y: number }[]): void {
    this.time += dt
    this.material.uniforms.uTime!.value = this.time
    this.beadMaterial.uniforms.uTime!.value = this.time

    if (this.labelsDirty) this.redrawLabels(board)
    // A pulsing preview must keep repainting even with the sim paused.
    if (this.preview.size > 0) this.writeAll(board)

    for (const v of this.visuals.values()) {
      if (v.flash > 0) v.flash = Math.max(0, v.flash - dt)
      if (v.pulseAmt > 0) v.pulseAmt = Math.max(0, v.pulseAmt - dt)
      let near = 0
      if (orbs) {
        for (const o of orbs) {
          const d = Math.hypot(o.x - v.node.x, o.y - v.node.y)
          const k = 1 - d / VISUAL.proximityRadius
          if (k > near) near = k
        }
      }
      v.near = near
    }
    this.writeAll(board)

    let edgesDirty = false
    for (const e of this.edgeState) {
      if (!e.active) continue
      e.bead += dt * VISUAL.beadSpeed
      e.flash = Math.max(0, e.flash - dt * VISUAL.edgeFadeRate)
      if (e.bead > 1.15) { e.active = false; e.bead = 0 }
      edgesDirty = true
    }
    if (edgesDirty) this.writeEdges()
  }

  private writeAll(board: Board): void {
    if (this.nodeBand) this.writeBand(this.nodeBand, false, board)
    if (this.headBand) this.writeBand(this.headBand, true, board)
    // Inner shells breathe with the scan rather than with events — they are
    // structure, not state, and flickering them would read as noise.
    if (this.shellBand) {
      const p = this.shellBand.param
      for (let i = 0; i < p.count; i++) {
        p.setX(i, 0.34 + 0.07 * Math.sin(this.time * 1.6 + i * 0.7))
      }
      p.needsUpdate = true
    }
  }

  private writeBand(band: Band, head: boolean, board: Board): void {
    for (const v of this.visuals.values()) {
      if (v.head !== head) continue
      const dead = this.isDead(v.node, board)
      const previewed = this.preview.has(v.node.id)

      let energy = dead
        ? VISUAL.inertEnergy
        : VISUAL.restEnergy
          + v.near * VISUAL.proximityEnergy
          + (v.flash / VISUAL.pinFlashSeconds) * VISUAL.strikeEnergy
          + (v.pulseAmt / VISUAL.signalFlashSeconds) * VISUAL.signalEnergy
          + (v.spent ? VISUAL.spentEnergy : 0)

      // Muting drops everything EXCEPT previewed weights, so a hovered
      // purchase picks its targets out of a dark net.
      if (this.muted) energy *= previewed ? 1 : VISUAL.mutedEnergyScale
      if (previewed) {
        energy += VISUAL.previewEnergy * (0.75 + 0.25 * Math.sin(this.time * 7))
      }

      if (previewed) COL.setHex(COLORS.preview)
      else if (dead) COL.setHex(COLORS.inert)
      else if (head) COL.setHex(v.flash > 0 ? COLORS.criticalLit : COLORS.critical)
      else COL.setHex(v.flash > 0 || v.pulseAmt > 0 ? COLORS.pinLit : COLORS.pin)

      band.col.setXYZ(v.slot, COL.r, COL.g, COL.b)
      // Grid density rises with level — the third channel level reads on.
      const g = head ? 0 : VISUAL.gridBase + v.node.level * VISUAL.gridPerLevel
      band.param.setXYZW(v.slot, energy, g, g * 1.3, 0)
    }
    band.col.needsUpdate = true
    band.param.needsUpdate = true
  }

  private writeEdges(): void {
    const eb = this.edgeBand
    const bb = this.beadBand
    if (!eb || !bb) return
    const base = new THREE.Color(COLORS.edge)
    const hot = new THREE.Color(COLORS.pinLit)

    for (let i = 0; i < this.edgeState.length; i++) {
      const e = this.edgeState[i]!
      eb.col.setXYZ(i, base.r, base.g, base.b)
      eb.param.setXYZW(i, VISUAL.conduitRest + e.flash * VISUAL.conduitLit, 0, 0, 0)

      const pair = this.edgePairs[i]
      if (e.active && pair && e.bead <= 1) {
        const u = e.bead
        DUMMY.position.set(
          pair.a.x + (pair.b.x - pair.a.x) * u,
          pair.a.y + (pair.b.y - pair.a.y) * u,
          0,
        )
        DUMMY.rotation.set(0, 0, 0)
        DUMMY.scale.setScalar(VISUAL.beadRadius)
        DUMMY.updateMatrix()
        bb.mesh.setMatrixAt(i, DUMMY.matrix)
        bb.col.setXYZ(i, hot.r, hot.g, hot.b)
        bb.param.setXYZW(i, 1, 0, 0, 0)
      } else {
        DUMMY.position.set(0, 0, -50)
        DUMMY.scale.setScalar(0.0001)
        DUMMY.updateMatrix()
        bb.mesh.setMatrixAt(i, DUMMY.matrix)
        bb.param.setXYZW(i, 0, 0, 0, 0)
      }
    }
    eb.col.needsUpdate = true
    eb.param.needsUpdate = true
    bb.mesh.instanceMatrix.needsUpdate = true
    bb.col.needsUpdate = true
    bb.param.needsUpdate = true
  }

  clear(): void {
    for (const child of this.group.children.slice()) this.group.remove(child)
    for (const d of this.disposables) {
      if (d !== this.material && d !== this.beadMaterial) d.dispose()
    }
    this.disposables = [this.material, this.beadMaterial]
    this.nodeBand = null
    this.headBand = null
    this.shellBand = null
    this.edgeBand = null
    this.beadBand = null
    this.edgeState = []
    this.edgePairs = []
    this.visuals.clear()
    this.retiredSlots.clear()
    this.labelCanvas = null
    this.labelTexture = null
  }
}
