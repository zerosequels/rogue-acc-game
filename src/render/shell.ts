/**
 * shell.ts — the holographic shell material.
 *
 * Every solid in the chamber uses this one shader. Nothing is lit; every
 * surface emits. The volume read comes from three terms that all survive
 * additive blending:
 *
 *   FRESNEL RIM   bright at grazing angles, nearly transparent face-on. This
 *                 single term is what makes a sphere read as a volume of light
 *                 rather than as a flat disc.
 *
 *   GEODESIC GRID drawn procedurally from the surface NORMAL, not from mesh
 *                 topology. That is the whole trick, and it is why the meshes
 *                 can be dense and smooth: the wireframe is a shader effect,
 *                 so it stays razor sharp at any distance while the silhouette
 *                 has no visible facets. It also makes grid density a free
 *                 per-instance channel, which is how level is encoded.
 *
 *   SCAN SWEEP    a band travelling up object space. The projector tell.
 *
 * Per-instance data rides in two custom attributes rather than three's
 * `instanceColor`, so one material serves every object type with full control:
 *
 *   aCol    rgb emission colour
 *   aParam  (energy, gridLat, gridLon, spare)
 *
 * Scale lives in the instance matrix, not in aParam.
 */

import * as THREE from 'three'

const vertexShader = /* glsl */ `
  attribute vec3 aCol;
  attribute vec4 aParam;
  varying vec3 vN, vW, vL, vC;
  varying vec4 vP;

  void main() {
    mat4 im = instanceMatrix;
    vec4 world = modelMatrix * im * vec4(position, 1.0);
    // Instances are uniformly scaled, so the upper 3x3 needs no inverse
    // transpose — normalising is enough.
    vN = normalize(mat3(im) * normal);
    vW = world.xyz;
    vL = position;
    vC = aCol;
    vP = aParam;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec3 vN, vW, vL, vC;
  varying vec4 vP;
  uniform float uTime;
  uniform float uRimPower;
  uniform float uRimGain;
  uniform float uGridGain;
  uniform float uScanGain;
  uniform float uFloor;

  float gridLine(float x, float w) {
    float d = 0.5 - abs(fract(x) - 0.5);
    return 1.0 - smoothstep(0.0, w, d);
  }

  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(cameraPosition - vW);
    float ndv = abs(dot(n, v));

    float rim = pow(1.0 - ndv, uRimPower);

    // gridLat of 0 disables the grid entirely — used for faceted crystals
    // and for solid plasma cores, which want rim and fill only.
    float grid = 0.0;
    if (vP.y > 0.5) {
      float lat = acos(clamp(n.y, -1.0, 1.0)) * 0.3183099;
      float lon = atan(n.z, n.x) * 0.1591549 + 0.5;
      grid = max(gridLine(lat * vP.y, 0.075), gridLine(lon * vP.z, 0.075));
    }

    float scan = pow(max(0.0, sin(vL.y * 6.0 - uTime * 2.1)), 16.0);

    // Faint face-on fill, so a shell reads as enclosing a volume rather than
    // as a hollow outline.
    float fill = pow(ndv, 3.0) * 0.07;

    float a = rim * uRimGain
            + grid * (uGridGain + rim * 1.5)
            + scan * uScanGain
            + fill
            + uFloor;

    gl_FragColor = vec4(vC * a * vP.x, 1.0);
  }
`

export interface ShellOptions {
  rimPower?: number
  rimGain?: number
  gridGain?: number
  scanGain?: number
  floor?: number
}

export function makeShellMaterial(o: ShellOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uRimPower: { value: o.rimPower ?? 2.9 },
      uRimGain: { value: o.rimGain ?? 2.2 },
      uGridGain: { value: o.gridGain ?? 0.95 },
      uScanGain: { value: o.scanGain ?? 0.55 },
      uFloor: { value: o.floor ?? 0.015 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    // Additive volumes must not occlude each other — they accumulate. Depth
    // TEST stays on so the opaque backing still hides anything behind it.
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
}

/**
 * Attach the per-instance channels this material needs. Each InstancedMesh
 * requires its own geometry, since the attributes are per-mesh data.
 */
export function prepareInstanced(geo: THREE.BufferGeometry, count: number): {
  col: THREE.InstancedBufferAttribute
  param: THREE.InstancedBufferAttribute
} {
  const col = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3)
  const param = new THREE.InstancedBufferAttribute(new Float32Array(count * 4), 4)
  col.setUsage(THREE.DynamicDrawUsage)
  param.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aCol', col)
  geo.setAttribute('aParam', param)
  return { col, param }
}
