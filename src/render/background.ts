/**
 * background.ts — the schematic sheet the network is drawn on.
 *
 * v1 had a busy procedural circuit field here with drifting glyphs and haze.
 * Against the v2 wireframe board it was actively harmful: the board is built
 * from hairlines, and a backdrop made of hairlines competes with it directly.
 *
 * So this is now almost nothing — a near-black void with a two-scale blueprint
 * grid at very low contrast, and occasional registration ticks. It exists to
 * give the board somewhere to sit and to establish the schematic language.
 * Everything bright in the scene should be the network.
 *
 * Procedural, so the bundle stays self-contained with no texture loads.
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

  void main() {
    vec2 world = (vUv - 0.5) * uExtent;

    // Near-pure void. The board is the only lit object in the scene; the
    // substrate exists to give it somewhere to sit, not to compete with it.
    float r = length(world / uExtent * 2.0);
    vec3 col = mix(vec3(0.009, 0.013, 0.024), vec3(0.002, 0.003, 0.008), r);

    // --- blueprint grid: two scales, both hairline --------------------------
    // A coarse lattice with a finer one inside it reads as a schematic sheet
    // rather than as graph paper.
    vec2 fine = abs(fract(world * 0.5) - 0.5) / fwidth(world * 0.5);
    float fineLine = 1.0 - min(min(fine.x, fine.y), 1.0);
    col += vec3(0.030, 0.058, 0.082) * fineLine * 0.085;

    vec2 coarse = abs(fract(world * 0.125) - 0.5) / fwidth(world * 0.125);
    float coarseLine = 1.0 - min(min(coarse.x, coarse.y), 1.0);
    col += vec3(0.042, 0.082, 0.115) * coarseLine * 0.16;

    // --- registration ticks at coarse intersections -------------------------
    vec2 cell = floor(world * 0.125);
    float tick = step(0.93, hash(cell)) * coarseLine;
    col += vec3(0.05, 0.10, 0.14) * tick * 0.5;

    // --- heat: the sheet warms toward magenta under load --------------------
    col += vec3(0.022, 0.002, 0.015) * uHeat * (0.4 + 0.3 * sin(uTime * 0.5));

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
