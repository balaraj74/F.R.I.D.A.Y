import * as THREE from 'three';

// Visual building blocks for the arc reactor: glow textures, the plasma core, orbiting energy
// motes and the "energy flowing around the copper coils" shader patch. All additive, all cheap.

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  draw(c.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/** Soft round glow (white centre fading to transparent); tint it with the material colour. */
export function makeGlowTexture(): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  });
}

/** Thin light rays radiating from the centre ("god rays"), fading outwards. */
export function makeRaysTexture(rays = 36): THREE.CanvasTexture {
  return canvasTexture(512, (ctx, s) => {
    const c = s / 2;
    ctx.translate(c, c);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2 + rand() * 0.12;
      const w = 0.012 + rand() * 0.035;
      const len = c * (0.55 + rand() * 0.45);
      const g = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      g.addColorStop(0, 'rgba(255,255,255,0.0)');
      g.addColorStop(0.18, `rgba(255,255,255,${0.35 + rand() * 0.4})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, len, a - w, a + w);
      ctx.closePath();
      ctx.fill();
    }
  });
}

/** Horizontal anamorphic lens streak through the core. */
export function makeStreakTexture(): THREE.CanvasTexture {
  return canvasTexture(512, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.setTransform(1, 0, 0, 0.035, 0, s * 0.4825);
    ctx.fillRect(0, 0, s, s);
  });
}

export interface PlasmaUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uPower: THREE.IUniform<number>;
  uLevel: THREE.IUniform<number>;
  uSwirl: THREE.IUniform<number>;
  uColA: THREE.IUniform<THREE.Color>;
  uColCore: THREE.IUniform<THREE.Color>;
}

/** Living plasma disc for the reactor core: swirling fbm filaments around a white-hot centre. */
export function createPlasma(): { mesh: THREE.Mesh; uniforms: PlasmaUniforms } {
  const uniforms: PlasmaUniforms = {
    uTime: { value: 0 },
    uPower: { value: 0 },
    uLevel: { value: 0 },
    uSwirl: { value: 1 },
    uColA: { value: new THREE.Color(0x00e5ff) },
    uColCore: { value: new THREE.Color(0xffffff) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uPower, uLevel, uSwirl;
      uniform vec3 uColA, uColCore;
      varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
        return v;
      }
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;
        // Twist the sample space so the filaments spiral into the centre.
        float ang = atan(p.y, p.x) + uSwirl * uTime * 0.55 + (1.0 - r) * 2.8;
        vec2 q = vec2(cos(ang), sin(ang)) * r * 3.2;
        float n = fbm(q + vec2(uTime * 0.31, -uTime * 0.19));
        float filaments = pow(smoothstep(0.38, 0.95, n), 2.0) * (0.65 + uLevel * 0.9);
        float core = exp(-r * r * 8.0);
        float ring = exp(-pow((r - 0.62) * 9.0, 2.0)) * 0.35;
        float edge = smoothstep(1.0, 0.7, r);
        vec3 col = mix(uColA, uColCore, core) * (core * 1.7 + filaments + ring) * edge;
        float alpha = clamp((core + filaments * 0.8 + ring) * edge, 0.0, 1.0);
        gl_FragColor = vec4(col * uPower, alpha * uPower);
      }`,
  });
  return { mesh: new THREE.Mesh(new THREE.CircleGeometry(1, 64), material), uniforms };
}

/** Energy motes spiralling into the core on the reactor plane. CPU-updated, ~150 points. */
export function createMotes(count: number, innerR: number, outerR: number) {
  const pos = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const size = new Float32Array(count);
  const ang = new Float32Array(count);
  const rad = new Float32Array(count);
  const spd = new Float32Array(count);
  const z = new Float32Array(count);
  const respawn = (i: number, anywhere: boolean) => {
    ang[i] = Math.random() * Math.PI * 2;
    rad[i] = anywhere ? innerR + Math.random() * (outerR - innerR) : outerR * (0.9 + Math.random() * 0.15);
    spd[i] = 0.35 + Math.random() * 0.9;
    z[i] = (Math.random() - 0.5) * 0.25;
    size[i] = 1.5 + Math.random() * 3.5;
  };
  for (let i = 0; i < count; i++) respawn(i, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const uniforms = {
    uColor: { value: new THREE.Color(0xbff6ff) },
    uPixel: { value: Math.min(window.devicePixelRatio || 1, 2) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      attribute float aSize;
      uniform float uPixel;
      varying float vA;
      void main() {
        vA = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixel * (4.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(uColor * a * vA, a * vA);
      }`,
  });
  const points = new THREE.Points(geo, material);

  /** `mul` scales orbit speed, `power` fades the whole swarm. */
  const update = (dt: number, mul: number, power: number) => {
    for (let i = 0; i < count; i++) {
      ang[i] += dt * spd[i] * mul * (outerR / Math.max(rad[i], 0.05)) * 0.35;
      rad[i] -= dt * spd[i] * mul * 0.09;
      if (rad[i] < innerR) respawn(i, false);
      const t = (rad[i] - innerR) / (outerR - innerR);
      // Fade in at the outer edge, brighten as the mote falls in, vanish at the core.
      alpha[i] = power * Math.min(1, (1 - t) * 3) * Math.min(1, t * 6) * 0.9;
      pos[i * 3] = Math.cos(ang[i]) * rad[i];
      pos[i * 3 + 1] = Math.sin(ang[i]) * rad[i];
      pos[i * 3 + 2] = z[i];
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  };
  const dispose = () => {
    geo.dispose();
    material.dispose();
  };
  return { points, color: uniforms.uColor.value, update, dispose };
}

export interface FlowUniforms {
  [name: string]: THREE.IUniform;
  uFlowTime: THREE.IUniform<number>;
  uFlowStrength: THREE.IUniform<number>;
  uFlowColor: THREE.IUniform<THREE.Color>;
  uFlowCenter: THREE.IUniform<THREE.Vector3>;
}

export function createFlowUniforms(): FlowUniforms {
  return {
    uFlowTime: { value: 0 },
    uFlowStrength: { value: 0 },
    uFlowColor: { value: new THREE.Color(0x00e5ff) },
    uFlowCenter: { value: new THREE.Vector3() },
  };
}

/**
 * Patch a PBR material so bright bands of energy travel around the reactor centre, lighting the
 * copper coils from within. The band position comes from the world-space angle around the core.
 */
export function addEnergyFlow(material: THREE.MeshStandardMaterial, uniforms: FlowUniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlowPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvFlowPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFlowPos;
        uniform float uFlowTime, uFlowStrength;
        uniform vec3 uFlowColor, uFlowCenter;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec2 fp = vFlowPos.xy - uFlowCenter.xy;
          float a = atan(fp.y, fp.x);
          float band = pow(0.5 + 0.5 * sin(a * 3.0 - uFlowTime * 2.2), 8.0);
          float shimmer = 0.75 + 0.25 * sin(a * 40.0 + uFlowTime * 9.0);
          totalEmissiveRadiance += uFlowColor * band * shimmer * uFlowStrength;
        }`,
      );
  };
  material.customProgramCacheKey = () => 'friday-energy-flow';
  material.needsUpdate = true;
}

export interface GapLightUniforms {
  [name: string]: THREE.IUniform;
  uTime: THREE.IUniform<number>;
  uPower: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uCore: THREE.IUniform<THREE.Color>;
  uMask: THREE.IUniform<THREE.Texture>;
  uInner: THREE.IUniform<number>;
  uOuter: THREE.IUniform<number>;
}

/**
 * Light that shines only through the open segments of the outer ring (between the copper
 * windings). `copperAngles` are angles (radians, in the ring's own frame) of copper vertices;
 * they become a 1D occupancy mask, so the glow follows the real model and turns with it.
 */
export function createGapLight(copperAngles: number[], inner: number, outer: number) {
  const N = 512;
  const occ = new Float32Array(N);
  for (const a of copperAngles) {
    const i = Math.floor((((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * N) % N;
    occ[i] += 1;
  }
  // Close tiny holes between vertices, then normalise to 0..1 (1 = copper).
  const max = Math.max(1, ...occ);
  const raw = Array.from(occ, (v) => (v > max * 0.02 ? 1 : 0));
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let k = -3; k <= 3; k++) v = Math.max(v, raw[(i + k + N) % N]);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v * 255;
    data[i * 4 + 3] = 255;
  }
  const mask = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat);
  mask.wrapS = THREE.RepeatWrapping;
  mask.magFilter = THREE.LinearFilter;
  mask.minFilter = THREE.LinearFilter;
  mask.needsUpdate = true;

  const uniforms: GapLightUniforms = {
    uTime: { value: 0 },
    uPower: { value: 0 },
    uColor: { value: new THREE.Color(0x00e5ff) },
    uCore: { value: new THREE.Color(0xffffff) },
    uMask: { value: mask },
    uInner: { value: inner },
    uOuter: { value: outer },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vP;
      void main() {
        vP = position.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uPower, uInner, uOuter;
      uniform vec3 uColor, uCore;
      uniform sampler2D uMask;
      varying vec2 vP;
      void main() {
        float r = length(vP);
        float a = atan(vP.y, vP.x);
        float u = fract(a / 6.28318530718);
        float copper = texture2D(uMask, vec2(u, 0.5)).r;
        float gap = 1.0 - smoothstep(0.15, 0.85, copper);
        // Brightest in the middle of the ring band, soft at both edges.
        float t = (r - uInner) / (uOuter - uInner);
        float band = smoothstep(0.0, 0.3, t) * smoothstep(1.0, 0.65, t);
        // A slow wave of energy chasing around the ring, plus a gentle shimmer.
        float chase = 0.55 + 0.45 * pow(0.5 + 0.5 * sin(a * 2.0 - uTime * 1.6), 3.0);
        float shimmer = 0.9 + 0.1 * sin(a * 55.0 + uTime * 7.0);
        float k = gap * band * chase * shimmer * uPower;
        vec3 col = mix(uColor, uCore, 0.35 * band);
        gl_FragColor = vec4(col * k, k);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 360, 1), material);
  const dispose = () => {
    mask.dispose();
    mesh.geometry.dispose();
    material.dispose();
  };
  return { mesh, uniforms, dispose };
}
