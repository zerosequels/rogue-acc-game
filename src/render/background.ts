/**
 * background.ts — the circuit/glyph backdrop.
 *
 * A single full-bleed shader quad behind the board. It does three jobs:
 *   - gives the board somewhere to *be* (a substrate, not a void)
 *   - carries the glyph/circuit motif the theme asks for
 *   - scales its own agitation with temperature, so the backdrop is part of
 *     the escalation rather than a static wallpaper
 *
 * Everything is procedural — no texture loads, no external assets, which keeps
 * the whole game a single self-contained bundle.
 */

import * as THREE from 'three'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform float uHeat;
  uniform vec2  uExtent;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // Cheap value noise, enough for a drifting substrate.
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  void main() {
    vec2 world = (vUv - 0.5) * uExtent;

    // --- base gradient: cold at the edges, faintly lit in the middle ---
    float r = length(world / uExtent * 2.0);
    vec3 col = mix(vec3(0.019, 0.030, 0.052), vec3(0.006, 0.010, 0.020), r);

    // --- circuit lattice: fine grid, brighter where "traces" are active ---
    vec2 grid = world * 1.5;
    vec2 g = abs(fract(grid) - 0.5);
    float lines = smoothstep(0.47, 0.5, max(g.x, g.y));
    // Activity crawls along rows and columns over time.
    float activity = noise(vec2(floor(grid.x), floor(grid.y)) * 0.35 + uTime * 0.18);
    float trace = lines * smoothstep(0.55, 0.95, activity);
    col += vec3(0.022, 0.085, 0.125) * trace * (0.3 + uHeat * 0.8);

    // --- coarse layer bands, suggesting depth through the network ---
    float band = sin(world.y * 0.72 + uTime * 0.12);
    col += vec3(0.009, 0.022, 0.04) * smoothstep(0.86, 1.0, band);

    // --- glyph field: blocky pseudo-tokens that flicker in at temperature ---
    vec2 cell = floor(world * 2.4);
    float glyphSeed = hash(cell + floor(uTime * 2.2));
    float glyphOn = step(0.9955 - uHeat * 0.012, glyphSeed);
    vec2 inCell = fract(world * 2.4);
    // Draw a crude 3x3 block glyph inside the cell.
    vec2 q = floor(inCell * 3.0);
    float bit = step(0.5, hash(cell * 1.7 + q + floor(uTime * 2.2)));
    float glyph = glyphOn * bit * step(0.08, inCell.x) * step(inCell.x, 0.92)
                           * step(0.08, inCell.y) * step(inCell.y, 0.92);
    col += mix(vec3(0.05, 0.19, 0.26), vec3(0.34, 0.08, 0.24), uHeat) * glyph * (0.2 + uHeat * 0.55);

    // --- heat haze: large-scale drifting warmth as temperature rises ---
    float haze = noise(world * 0.22 + vec2(uTime * 0.07, -uTime * 0.05));
    col += vec3(0.055, 0.008, 0.038) * haze * uHeat * 0.7;

    gl_FragColor = vec4(col, 1.0);
  }
`

export class Background {
  readonly mesh: THREE.Mesh
  private material: THREE.ShaderMaterial
  private geometry: THREE.PlaneGeometry

  constructor(width: number, height: number) {
    this.geometry = new THREE.PlaneGeometry(width, height)
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uHeat: { value: 0 },
        uExtent: { value: new THREE.Vector2(width, height) },
      },
      depthWrite: false,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.position.z = -2
    this.mesh.renderOrder = -1
  }

  /** Resize the quad so it always covers the current ortho frustum. */
  fit(width: number, height: number, centreY: number): void {
    this.geometry.dispose()
    this.geometry = new THREE.PlaneGeometry(width, height)
    this.mesh.geometry = this.geometry
    this.mesh.position.set(0, centreY, -2)
    ;(this.material.uniforms.uExtent!.value as THREE.Vector2).set(width, height)
  }

  update(time: number, heat: number): void {
    this.material.uniforms.uTime!.value = time
    this.material.uniforms.uHeat!.value = heat
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}
