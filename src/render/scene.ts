/**
 * scene.ts — renderer, orthographic camera, and the post-processing chain.
 *
 * Why Three.js for what is effectively a 2D game: the post-processing. The
 * whole "living neural net under pressure" read comes from bloom on the pin
 * glow and a glitch pass that intensifies with temperature. Getting that in a
 * plain 2D canvas means hand-rolling a shader pipeline anyway, so we take
 * Three's and keep physics strictly in the XY plane at z=0.
 *
 * The camera frames the board exactly and letterboxes rather than cropping —
 * a pachinko board you cannot fully see is a board you cannot aim at.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { BOARD, COLORS, LAUNCH, VISUAL } from '../config/balance'

/**
 * View box the camera guarantees to show, in world units.
 *
 * Top and bottom padding are separate and deliberately asymmetric:
 *   - the top needs enough clearance that the launcher does not end up behind
 *     the HUD bar (it did, and you could not see what you were aiming with)
 *   - the bottom needs enough that the pocket floor is never clipped by the
 *     viewport edge, since the pockets are the thing you are aiming AT
 */
const VIEW_TOP = LAUNCH.originY + VISUAL.cameraPadTop
const VIEW_BOTTOM = BOARD.bottom - VISUAL.cameraPadBottom
const VIEW_W = BOARD.width + VISUAL.cameraPadding * 2
const VIEW_H = VIEW_TOP - VIEW_BOTTOM
const VIEW_CY = (VIEW_TOP + VIEW_BOTTOM) / 2

/**
 * Glitch + chromatic aberration, driven by one `intensity` uniform.
 * At 0 it is a pure passthrough, so Greedy sampling looks clinically clean and
 * Rogue sampling looks like the tensor is coming apart. That contrast is the
 * entire visual payoff of the temperature mechanic.
 */
const GlitchShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uIntensity: { value: 0 },
    uTime: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uIntensity;
    uniform float uTime;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      float k = uIntensity;

      // Blocky horizontal displacement in coarse bands.
      float band = floor(uv.y * 34.0);
      float jump = hash(vec2(band, floor(uTime * 11.0)));
      // NB: do not name this variable 'active' -- it is a reserved word in
      // GLSL ES and the shader silently fails to compile.
      float jitterOn = step(1.0 - k * 0.17, jump);
      uv.x += (hash(vec2(band, floor(uTime * 23.0))) - 0.5) * 0.028 * k * jitterOn;

      // Chromatic aberration, scaling from the centre outward.
      vec2 fromCentre = uv - 0.5;
      float split = (0.0010 + 0.0046 * k) * length(fromCentre) * 2.0;
      float r = texture2D(tDiffuse, uv + fromCentre * split).r;
      float g = texture2D(tDiffuse, uv).g;
      float b = texture2D(tDiffuse, uv - fromCentre * split).b;
      vec3 col = vec3(r, g, b);

      // Scanlines + a faint rolling bar: CRT-adjacent, reads as "instrumented".
      float scan = 0.978 + 0.022 * sin(uv.y * 1100.0);
      float roll = 0.985 + 0.015 * sin(uv.y * 5.0 - uTime * 1.6);
      col *= scan * roll;

      // Oversaturate as temperature climbs.
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(vec3(lum), col, 1.0 + k * 0.32);

      // Sparse white noise speckle at high temperature.
      float speck = hash(uv * 820.0 + uTime * 40.0);
      col += step(0.9997 - k * 0.0022, speck) * k * 0.45;

      // Vignette keeps the eye on the board.
      float vig = 1.0 - 0.28 * dot(fromCentre, fromCentre) * 2.0;
      gl_FragColor = vec4(col * vig, 1.0);
    }
  `,
}

const PROJ = new THREE.Vector3()
const NDC = new THREE.Vector2()
const RAY = new THREE.Raycaster()
const PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const HIT = new THREE.Vector3()

export class Renderer {
  readonly scene = new THREE.Scene()
  readonly camera: THREE.OrthographicCamera
  readonly renderer: THREE.WebGLRenderer
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private glitch: ShaderPass
  private clock = new THREE.Clock()

  /** 0..1 normalised temperature heat, drives bloom + glitch. */
  heat = 0
  /** Called after every resize, so the backdrop can refit the frustum. */
  private resizeListeners: (() => void)[] = []
  /** Transient kick on big score events, decays each frame. */
  private shock = 0
  /** Positional screen shake, in world units. Decays each frame. */
  private shake = 0
  /** Deterministic-ish shake phase; cosmetic only, never gameplay. */
  private shakePhase = 0
  /** Base frustum for the current viewport, before shake is applied. */
  private frustum = { left: -1, right: 1, top: 1, bottom: -1 }

  constructor(private host: HTMLElement) {
    this.scene.background = new THREE.Color(COLORS.bg)

    // Camera sits at the origin and the frustum carries absolute world
    // coordinates. Do NOT also offset position.y to VIEW_CY: an orthographic
    // frustum is relative to the camera, so doing both double-counts the
    // offset -- the scene rendered a world unit high and worldToScreen (which
    // reads camera.top as an absolute coord) disagreed with the render, so
    // score popups appeared ~37px away from the weight that produced them.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -60, 120)
    // Orthographic with a small fixed tilt. Parallel projection keeps aim
    // truthful — a gap at the rail is exactly where it looks — while the tilt
    // reveals the tops and near sides of every shell, which is all the
    // dimensionality the read needs. Depth comes from shading, not projection.
    const tilt = (VISUAL.cameraTilt * Math.PI) / 180
    this.camera.position.set(0, Math.sin(tilt) * 20, Math.cos(tilt) * 20)
    this.camera.lookAt(0, 0, 0)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setClearColor(COLORS.bg, 1)
    host.appendChild(this.renderer.domElement)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      VISUAL.bloomStrength,
      VISUAL.bloomRadius,
      VISUAL.bloomThreshold,
    )
    this.composer.addPass(this.bloom)

    this.glitch = new ShaderPass(GlitchShader)
    this.composer.addPass(this.glitch)

    this.composer.addPass(new OutputPass())

    this.resize()
    window.addEventListener('resize', this.resize)
  }

  /** Letterbox-fit the guaranteed view box into the viewport. */
  private resize = (): void => {
    const w = this.host.clientWidth || window.innerWidth
    const h = this.host.clientHeight || window.innerHeight
    const aspect = w / h

    let viewW: number
    let viewH: number
    if (aspect > VIEW_W / VIEW_H) {
      viewH = VIEW_H
      viewW = viewH * aspect
    } else {
      viewW = VIEW_W
      viewH = viewW / aspect
    }

    this.frustum.left = -viewW / 2
    this.frustum.right = viewW / 2
    this.frustum.top = VIEW_CY + viewH / 2
    this.frustum.bottom = VIEW_CY - viewH / 2
    this.applyFrustum(0, 0)

    this.renderer.setSize(w, h)
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)

    for (const fn of this.resizeListeners) fn()
  }

  onResize(fn: () => void): void {
    this.resizeListeners.push(fn)
    fn()
  }

  /** Current frustum dimensions, for sizing the full-bleed backdrop. */
  get viewWidth(): number {
    return this.camera.right - this.camera.left
  }

  get viewHeight(): number {
    return this.camera.top - this.camera.bottom
  }

  get viewCentreY(): number {
    return VIEW_CY
  }

  /** Project a world XY on the z=0 plane to client pixel coordinates. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return this.projectExact(x, y)
  }

  /**
   * Client pointer -> world XY on the z=0 plane. Raycast rather than remap:
   * with the camera tilted, the naive inverse is wrong by the tilt, and aim
   * would not follow the cursor.
   */
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect()
    NDC.x = ((clientX - rect.left) / rect.width) * 2 - 1
    NDC.y = -(((clientY - rect.top) / rect.height) * 2 - 1)
    RAY.setFromCamera(NDC, this.camera)
    const hit = RAY.ray.intersectPlane(PLANE, HIT)
    return hit ? { x: hit.x, y: hit.y } : { x: 0, y: VIEW_CY }
  }

  /**
   * Kick the presentation. Drives BOTH the glitch shader and a positional
   * camera shake — the shader alone reads as a video artefact rather than as
   * impact, and impact is the point.
   */
  punch(amount = 1): void {
    this.shock = Math.min(1.6, this.shock + amount)
    this.shake = Math.min(VISUAL.shakeMax, this.shake + amount * VISUAL.shakePerPunch)
  }

  /**
   * Offset the FRUSTUM rather than the camera position, so that worldToScreen
   * — which reads the frustum — stays correct while shaking and DOM popups
   * track the weights they came from.
   */
  private applyFrustum(dx: number, dy: number): void {
    this.camera.left = this.frustum.left + dx
    this.camera.right = this.frustum.right + dx
    this.camera.top = this.frustum.top + dy
    this.camera.bottom = this.frustum.bottom + dy
    this.camera.updateProjectionMatrix()
  }

  /**
   * Project a world XY on the z=0 plane to client pixels.
   *
   * The camera is tilted, so the frustum rectangle is no longer the world
   * rectangle — a point's screen position must go through the real projection
   * rather than a flat remap, or every DOM score popup drifts off its weight.
   */
  private projectExact(x: number, y: number): { x: number; y: number } {
    PROJ.set(x, y, 0).project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return {
      x: rect.left + (PROJ.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-PROJ.y * 0.5 + 0.5) * rect.height,
    }
  }

  render(dt = 1 / 60): void {
    const t = this.clock.getElapsedTime()
    this.shock *= 0.9

    // Two detuned sinusoids rather than random jitter: random shake reads as
    // noise, a beat frequency reads as a physical knock settling down.
    if (this.shake > 0.0004) {
      this.shakePhase += dt
      const decay = Math.pow(VISUAL.shakeDecay, dt * 60)
      this.shake *= decay
      const a = this.shake
      const dx = Math.sin(this.shakePhase * 61.3) * a
      const dy = Math.cos(this.shakePhase * 47.9) * a * 0.75
      this.applyFrustum(dx, dy)
    } else if (this.shake !== 0) {
      this.shake = 0
      this.applyFrustum(0, 0)
    }

    const k = Math.min(1, this.heat + this.shock * 0.55)
    this.glitch.uniforms.uIntensity!.value = k * VISUAL.glitchMax + this.shock * 0.18
    this.glitch.uniforms.uTime!.value = t
    this.bloom.strength = VISUAL.bloomStrength + k * VISUAL.bloomTempBoost + this.shock * 0.3

    this.composer.render()
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
    this.renderer.dispose()
    this.composer.dispose()
  }
}
