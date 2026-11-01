/**
 * boardView.ts — the network, drawn as a schematic.
 *
 * Four pieces of geometry, each a single draw call:
 *
 *   edges   LineSegments, one segment per connection, per-vertex colour so an
 *           edge can brighten without touching the scene graph
 *   nodes   InstancedMesh of RINGS (not discs) — the wireframe read comes from
 *           drawing weights hollow
 *   heads   a second instanced ring, larger and hexagonal, for attention heads
 *   buckets LineSegments outlining open boxes along the floor
 *
 * Glyph labels are the interesting problem. Seventy nodes each needing a level
 * readout is seventy pieces of text, and the obvious approaches are both bad:
 * DOM elements mean seventy layout-thrashing position updates per frame, and
 * one sprite per node means seventy draw calls. But the lattice is FIXED and
 * labels only change when the player buys something — so all of it is drawn
 * once into a single CanvasTexture stretched over the board, and redrawn only
 * on `markLabelsDirty()`. Seventy labels, one quad, zero per-frame cost.
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

const DUMMY = new THREE.Object3D()
const COL = new THREE.Color()
const COL_B = new THREE.Color()

interface NodeVisual {
  node: NodeDef
  slot: number
  head: boolean
  flash: number
  spent: boolean
}

/** Edge brightness state, indexed the same as `board.edges`. */
interface EdgeVisual {
  flash: number
}

export class BoardView {
  readonly group = new THREE.Group()

  private nodeMesh: THREE.InstancedMesh | null = null
  private headMesh: THREE.InstancedMesh | null = null
  private edgeLines: THREE.LineSegments | null = null
  private edgeColors: Float32Array | null = null
  private edgeState: EdgeVisual[] = []

  private visuals = new Map<number, NodeVisual>()
  private retiredSlots = new Map<number, number>()
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = []

  // --- glyph label layer ---
  private labelCanvas: HTMLCanvasElement | null = null
  private labelTexture: THREE.CanvasTexture | null = null
  private labelsDirty = true
  private deadLayers = 0

  constructor() {
    this.group.position.z = 0
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
    this.nodeMesh = this.buildNodeMesh(plain, PIN.radius, false, board)
    this.headMesh = this.buildNodeMesh(heads, PIN.criticalRadius, true, board)
    if (this.nodeMesh) this.group.add(this.nodeMesh)
    if (this.headMesh) this.group.add(this.headMesh)

    this.buildBuckets(board)
    this.buildLabelLayer(board)
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  /**
   * Nodes are RINGS. This single choice carries most of the wireframe read —
   * a filled disc is a dot, a ring is a component on a schematic.
   */
  private buildNodeMesh(
    nodes: NodeDef[],
    radius: number,
    head: boolean,
    board: Board,
  ): THREE.InstancedMesh | null {
    if (nodes.length === 0) return null

    const geo = new THREE.RingGeometry(
      radius - VISUAL.ringThickness * (head ? 2.4 : 1),
      radius,
      head ? 6 : 20,
    )
    // No vertexColors: InstancedMesh colour comes from `instanceColor`, and
    // setting vertexColors makes three look for a geometry attribute that
    // RingGeometry does not have — which renders every node black.
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    this.disposables.push(geo, mat)

    const mesh = new THREE.InstancedMesh(geo, mat, nodes.length)
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage)

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!
      DUMMY.position.set(n.x, n.y, head ? 0.03 : 0.02)
      DUMMY.rotation.z = head ? Math.PI / 6 : 0
      DUMMY.scale.setScalar(1)
      DUMMY.updateMatrix()
      mesh.setMatrixAt(i, DUMMY.matrix)
      mesh.setColorAt(i, this.restColor(n, board, COL))
      this.visuals.set(n.id, { node: n, slot: i, head, flash: 0, spent: false })
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    return mesh
  }

  /** Every connection as one hairline. Dim at rest, bright when signalling. */
  private buildEdges(board: Board): void {
    if (board.edges.length === 0) return
    const byId = new Map(board.nodes.map((n) => [n.id, n]))

    const positions = new Float32Array(board.edges.length * 6)
    const colors = new Float32Array(board.edges.length * 6)

    for (let i = 0; i < board.edges.length; i++) {
      const e = board.edges[i]!
      const a = byId.get(e.from)
      const b = byId.get(e.to)
      if (!a || !b) continue
      positions[i * 6 + 0] = a.x
      positions[i * 6 + 1] = a.y
      positions[i * 6 + 2] = -0.01
      positions[i * 6 + 3] = b.x
      positions[i * 6 + 4] = b.y
      positions[i * 6 + 5] = -0.01
      this.edgeState.push({ flash: 0 })
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      toneMapped: false,
    })
    this.disposables.push(geo, mat)

    this.edgeColors = colors
    this.edgeLines = new THREE.LineSegments(geo, mat)
    this.edgeLines.frustumCulled = false
    this.group.add(this.edgeLines)
    this.writeAllEdgeColors()
  }

  private writeAllEdgeColors(): void {
    if (!this.edgeColors || !this.edgeLines) return
    const base = new THREE.Color(COLORS.edge)
    for (let i = 0; i < this.edgeState.length; i++) {
      const f = this.edgeState[i]!.flash
      const k = VISUAL.edgeRestBrightness + f * (1 - VISUAL.edgeRestBrightness)
      for (let v = 0; v < 2; v++) {
        this.edgeColors[i * 6 + v * 3 + 0] = base.r * k
        this.edgeColors[i * 6 + v * 3 + 1] = base.g * k
        this.edgeColors[i * 6 + v * 3 + 2] = base.b * k
      }
    }
    ;(this.edgeLines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }

  /** Rails and floor, drawn as outlines rather than filled bars. */
  private buildFrame(board: Board): void {
    const t = BOARD.wallThickness
    const halfW = BOARD.width / 2
    const height = BOARD.top - board.floorY

    const mat = new THREE.LineBasicMaterial({ color: COLORS.wall, toneMapped: false })
    this.disposables.push(mat)

    const pts: number[] = []
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      pts.push(x0, y0, 0, x1, y0, 0)
      pts.push(x1, y0, 0, x1, y1, 0)
      pts.push(x1, y1, 0, x0, y1, 0)
      pts.push(x0, y1, 0, x0, y0, 0)
    }
    rect(-halfW + t, board.floorY, halfW - t, BOARD.top)

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    this.disposables.push(geo)
    this.group.add(new THREE.LineSegments(geo, mat))

    // A near-opaque backing so the substrate grid does not read through the
    // playfield. Without it the board stops being an object.
    const backGeo = new THREE.PlaneGeometry(BOARD.width - t * 2, height)
    const backMat = new THREE.MeshBasicMaterial({
      color: 0x03060c,
      transparent: true,
      opacity: 0.88,
      toneMapped: false,
    })
    this.disposables.push(backGeo, backMat)
    const back = new THREE.Mesh(backGeo, backMat)
    back.position.set(0, board.floorY + height / 2, -0.08)
    this.group.add(back)
  }

  /** Output tokens as open wireframe boxes. */
  private buildBuckets(board: Board): void {
    const pts: number[] = []
    const cols: number[] = []
    const c = new THREE.Color()

    for (const p of board.pockets) {
      const colour =
        p.kind === 'spike' ? COLORS.spike : p.kind === 'drain' ? COLORS.drainLine : COLORS.pocketLine
      c.setHex(colour)
      const x0 = p.x - p.halfWidth
      const x1 = p.x + p.halfWidth
      const y0 = board.floorY
      const y1 = board.pocketTopY

      // Open-topped box: sides and floor drawn, mouth left open, plus a bright
      // lip just above so the kind is readable from across the board.
      const seg = (ax: number, ay: number, bx: number, by: number) => {
        pts.push(ax, ay, 0.01, bx, by, 0.01)
        cols.push(c.r, c.g, c.b, c.r, c.g, c.b)
      }
      seg(x0, y1, x0, y0)
      seg(x1, y1, x1, y0)
      seg(x0, y0, x1, y0)
      seg(x0, y1 + 0.07, x1, y1 + 0.07)
    }

    if (pts.length === 0) return
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3))
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false })
    this.disposables.push(geo, mat)
    this.group.add(new THREE.LineSegments(geo, mat))
  }

  // -------------------------------------------------------------------------
  // Glyph labels — one canvas, one quad, redrawn only when state changes
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
      map: tex,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
    this.disposables.push(geo, mat)
    const quad = new THREE.Mesh(geo, mat)
    quad.position.set(0, board.floorY + h / 2, 0.06)
    this.group.add(quad)

    this.labelsDirty = true
    this.redrawLabels(board)
  }

  /** Call after any level or transform change. Cheap; the redraw is deferred. */
  markLabelsDirty(): void {
    this.labelsDirty = true
  }

  private redrawLabels(board: Board): void {
    const canvas = this.labelCanvas
    const tex = this.labelTexture
    if (!canvas || !tex) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ppu = VISUAL.labelPixelsPerUnit
    // World -> canvas. Canvas y is inverted relative to world y.
    const cx = (x: number) => (x + BOARD.width / 2) * ppu
    const cy = (y: number) => (BOARD.top - y) * ppu

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    for (const n of board.nodes) {
      if (n.removed) continue
      const head = isAttentionHead(n)

      // Level glyph sits inside the ring. Only drawn above L1 — printing "L1"
      // on seventy identical nodes is noise, and the absence of a glyph is
      // itself the signal that a node is untouched.
      if (n.level > 1) {
        ctx.font = `700 ${Math.round(ppu * 0.23)}px "JetBrains Mono", monospace`
        ctx.fillStyle = head ? '#ffdca8' : '#a8e9ff'
        ctx.fillText(String(n.level), cx(n.x), cy(n.y))
      }

      // Transform tags sit just beneath the node.
      if (n.transforms.length > 0) {
        ctx.font = `500 ${Math.round(ppu * 0.2)}px "JetBrains Mono", monospace`
        ctx.fillStyle = head ? 'rgba(255,179,64,.95)' : 'rgba(53,228,255,.8)'
        const tags = n.transforms.map((t) => NODE_TRANSFORM_LABEL[t]).join('·')
        ctx.fillText(tags, cx(n.x), cy(n.y - n.radius - 0.26))
      }
    }

    for (const p of board.pockets) {
      const midY = board.floorY + (board.pocketTopY - board.floorY) / 2
      ctx.font = `700 ${Math.round(ppu * 0.24)}px "JetBrains Mono", monospace`
      ctx.fillStyle =
        p.kind === 'spike' ? 'rgba(255,60,200,.95)'
        : p.kind === 'drain' ? 'rgba(211,64,90,.8)'
        : 'rgba(120,170,220,.85)'
      const label = p.transform ? BUCKET_TRANSFORM_LABEL[p.transform] : `L${p.level}`
      ctx.fillText(label, cx(p.x), cy(midY + 0.18))

      ctx.font = `400 ${Math.round(ppu * 0.17)}px "JetBrains Mono", monospace`
      ctx.fillStyle = 'rgba(93,112,143,.9)'
      ctx.fillText(`TOK_${String(p.id).padStart(2, '0')}`, cx(p.x), cy(midY - 0.3))
    }

    tex.needsUpdate = true
    this.labelsDirty = false
  }

  // -------------------------------------------------------------------------
  // Per-frame state
  // -------------------------------------------------------------------------

  private restColor(node: NodeDef, board: Board, target: THREE.Color): THREE.Color {
    if (isAttentionHead(node)) return target.setHex(COLORS.critical)
    const depth = board.layers <= 1 ? 0 : node.layer / (board.layers - 1)
    target.setHex(COLORS.pin)
    const hsl = { h: 0, s: 0, l: 0 }
    target.getHSL(hsl)
    target.setHSL(hsl.h + depth * 0.03, hsl.s * (1 - depth * 0.12), hsl.l * (1 - depth * 0.16))
    return target
  }

  /** A ball contact. Consumes the weight for the pass, so it dims afterwards. */
  strike(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    v.flash = VISUAL.pinFlashSeconds
    v.spent = true
  }

  /**
   * A signal activation. Flashes but does NOT mark the weight spent, because
   * signal is a bonus and leaves the node available for the ball. The visual
   * has to say that: a dimmed node reads as "already used", and dimming on
   * signal would tell the player the opposite of the rule.
   */
  pulse(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    v.flash = Math.max(v.flash, VISUAL.signalFlashSeconds)
  }

  /** Light an edge. Pass 2 calls this as signal travels; harmless until then. */
  flashEdge(index: number): void {
    const e = this.edgeState[index]
    if (e) e.flash = 1
  }

  retire(node: NodeDef): void {
    const v = this.visuals.get(node.id)
    if (!v) return
    const mesh = v.head ? this.headMesh : this.nodeMesh
    if (!mesh) return
    DUMMY.position.set(node.x, node.y, -5)
    DUMMY.scale.setScalar(0.001)
    DUMMY.rotation.z = 0
    DUMMY.updateMatrix()
    mesh.setMatrixAt(v.slot, DUMMY.matrix)
    mesh.instanceMatrix.needsUpdate = true
    this.retiredSlots.set(node.id, v.slot)
    this.visuals.delete(node.id)
  }

  revive(node: NodeDef, board: Board): void {
    if (this.visuals.has(node.id)) return
    const head = isAttentionHead(node)
    const mesh = head ? this.headMesh : this.nodeMesh
    if (!mesh) return
    const slot = this.retiredSlots.get(node.id)
    if (slot === undefined) return
    DUMMY.position.set(node.x, node.y, head ? 0.03 : 0.02)
    DUMMY.rotation.z = head ? Math.PI / 6 : 0
    DUMMY.scale.setScalar(1)
    DUMMY.updateMatrix()
    mesh.setMatrixAt(slot, DUMMY.matrix)
    mesh.instanceMatrix.needsUpdate = true
    const v: NodeVisual = { node, slot, head, flash: 0, spent: false }
    this.visuals.set(node.id, v)
    this.writeColor(v, board)
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    this.retiredSlots.delete(node.id)
  }

  resetPass(board: Board): void {
    for (const v of this.visuals.values()) {
      v.spent = false
      v.flash = 0
      this.writeColor(v, board)
    }
    for (const e of this.edgeState) e.flash = 0
    this.writeAllEdgeColors()
    if (this.nodeMesh?.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true
    if (this.headMesh?.instanceColor) this.headMesh.instanceColor.needsUpdate = true
  }

  update(dt: number, board: Board): void {
    if (this.labelsDirty) this.redrawLabels(board)

    let dirtyNode = false
    let dirtyHead = false
    for (const v of this.visuals.values()) {
      if (v.flash <= 0) continue
      v.flash = Math.max(0, v.flash - dt)
      if (v.head) dirtyHead = true
      else dirtyNode = true
      this.writeColor(v, board)
    }
    if (dirtyNode && this.nodeMesh?.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true
    if (dirtyHead && this.headMesh?.instanceColor) this.headMesh.instanceColor.needsUpdate = true

    let edgeDirty = false
    for (const e of this.edgeState) {
      if (e.flash <= 0) continue
      e.flash = Math.max(0, e.flash - dt * VISUAL.edgeFadeRate)
      edgeDirty = true
    }
    if (edgeDirty) this.writeAllEdgeColors()
  }

  /**
   * Grey out the lowest `count` layers for a boss modifier. Inert weights
   * must LOOK inert — a player aiming at a layer that cannot score is a
   * player the interface has lied to.
   */
  setDeadLayers(count: number, board: Board): void {
    this.deadLayers = count
    for (const v of this.visuals.values()) this.writeColor(v, board)
    if (this.nodeMesh?.instanceColor) this.nodeMesh.instanceColor.needsUpdate = true
    if (this.headMesh?.instanceColor) this.headMesh.instanceColor.needsUpdate = true
  }

  private isDead(node: NodeDef, board: Board): boolean {
    return this.deadLayers > 0 && node.layer >= board.layers - this.deadLayers
  }

  private writeColor(v: NodeVisual, board: Board): void {
    const mesh = v.head ? this.headMesh : this.nodeMesh
    if (!mesh) return

    if (this.isDead(v.node, board)) COL.setHex(COLORS.inert)
    else if (v.spent) COL.setHex(v.head ? COLORS.critical : COLORS.pinSpent)
    else this.restColor(v.node, board, COL)

    if (v.flash > 0) {
      const k = Math.min(1, v.flash / VISUAL.pinFlashSeconds)
      COL_B.setHex(v.head ? COLORS.criticalLit : COLORS.pinLit)
      COL_B.lerp(COL, 1 - k * k)
      mesh.setColorAt(v.slot, COL_B)
    } else {
      mesh.setColorAt(v.slot, COL)
    }
  }

  clear(): void {
    for (const child of this.group.children.slice()) this.group.remove(child)
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.nodeMesh = null
    this.headMesh = null
    this.edgeLines = null
    this.edgeColors = null
    this.edgeState = []
    this.visuals.clear()
    this.retiredSlots.clear()
    this.labelCanvas = null
    this.labelTexture = null
  }
}
