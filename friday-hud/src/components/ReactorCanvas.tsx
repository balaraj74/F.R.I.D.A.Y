import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { startFrameLoop } from '../services/frame-loop';
import { presence, type PresenceMode } from '../services/presence';
import {
  addEnergyFlow,
  createFlowUniforms,
  createGapLight,
  createMotes,
  createPlasma,
  makeGlowTexture,
  makeRaysTexture,
  makeStreakTexture,
} from './reactor/fx';

// Real 3D Iron Man MK1 arc reactor (./models/arc_reactor.glb), lit like a live power source:
// - Studio environment reflections so gold, copper and palladium read as real metal
// - The core is the main light: a breathing, flickering point light + living plasma disc
// - Two "satellite" lights orbit the reactor so highlights sweep across the metal
// - Energy bands travel around the copper coils; motes spiral into the core; god rays + streak
// - Ignition sequence on load; flat 2D rotation facing Sir (Z axis only)
// - Every element follows FRIDAY's presence (idle, listening, thinking, acting, speaking, approval)

interface ModeLook {
  a: number;
  b: number;
  core: number;
  speed: number;
  intensity: number;
  think: number;
}

const LOOKS: Record<PresenceMode, ModeLook> = {
  idle:      { a: 0x00e5ff, b: 0x0284c7, core: 0xe0fbff, speed: 1.0, intensity: 1.0, think: 0.0 },
  listening: { a: 0x38f6ff, b: 0x00a8e8, core: 0xffffff, speed: 1.5, intensity: 1.2, think: 0.0 },
  thinking:  { a: 0xff4d2e, b: 0xc2261b, core: 0xffe6d9, speed: 2.4, intensity: 1.2, think: 1.0 },
  acting:    { a: 0xffb547, b: 0xea580c, core: 0xfff7ed, speed: 2.1, intensity: 1.25, think: 0.4 },
  speaking:  { a: 0x7dd3fc, b: 0x00e5ff, core: 0xffffff, speed: 1.7, intensity: 1.3, think: 0.0 },
  approval:  { a: 0xff9e3d, b: 0xc2410c, core: 0xffedd5, speed: 0.6, intensity: 1.1, think: 0.0 },
};

/** Glow on the copper windings themselves (off: the light belongs in the gaps between them). */
const COPPER_FLOW = false;

/** Seconds of the power-up sequence after the model loads. */
const IGNITION_S = 2.6;

/** Ignition brightness 0..1 with a few stuttering flickers, like a reactor catching. */
function ignitionCurve(t: number): number {
  if (t <= 0) return 0;
  if (t >= IGNITION_S) return 1;
  const x = t / IGNITION_S;
  const ramp = x * x * (3 - 2 * x);
  const stutter = x < 0.55 ? (Math.sin(t * 47) > 0.35 ? 1 : 0.25) : 1;
  return ramp * stutter;
}

interface Props {
  className?: string;
  boostKey?: number;
}

export const ReactorCanvas: React.FC<Props> = React.memo(({ className, boostKey = 0 }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const boostAtRef = useRef(-Infinity);

  useEffect(() => {
    if (boostKey > 0) {
      boostAtRef.current = performance.now();
      presence.pulse();
    }
  }, [boostKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    camera.position.set(0, 0, 5.6);

    // Studio reflections for the metals (not shown as a background: the window stays transparent).
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.22;

    // ---- Lights -------------------------------------------------------------------------
    // The core is the hero light; everything else is kept low so the reactor glows from within.
    const coreLight = new THREE.PointLight(LOOKS.idle.a, 0, 9, 1.6);
    coreLight.position.set(0, 0, 0.6);
    scene.add(coreLight);

    const keyLight = new THREE.DirectionalLight(0xf8fbff, 0.55);
    keyLight.position.set(1.2, 2.2, 5);
    scene.add(keyLight);

    const hemi = new THREE.HemisphereLight(0xcfefff, 0x05070d, 0.12);
    scene.add(hemi);

    // Two small lights orbiting the rim: their reflections sweep across the copper and gold.
    const satA = new THREE.PointLight(LOOKS.idle.a, 0, 6, 2);
    const satB = new THREE.PointLight(0xffffff, 0, 6, 2);
    scene.add(satA, satB);

    // Cool back rim so the silhouette separates from the HUD.
    const backRim = new THREE.DirectionalLight(LOOKS.idle.b, 0);
    backRim.position.set(0, 0, -4);
    scene.add(backRim);

    const root = new THREE.Group();
    scene.add(root);

    // ---- Additive light effects ---------------------------------------------------------
    const glowTex = makeGlowTexture();
    const raysTex = makeRaysTexture(40);
    const streakTex = makeStreakTexture();
    const additive = (map: THREE.Texture, color: number, opacity: number) =>
      new THREE.SpriteMaterial({
        map,
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
      });

    const aura = new THREE.Sprite(additive(glowTex, LOOKS.idle.b, 0));
    aura.scale.set(4.2, 4.2, 1);
    aura.position.z = -0.6;
    aura.renderOrder = -2;
    root.add(aura);

    // God rays as meshes (sprites can't rotate around their own axis independently of the camera).
    const raysMatA = new THREE.MeshBasicMaterial({
      map: raysTex,
      color: LOOKS.idle.a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const raysMatB = raysMatA.clone();
    const raysA = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), raysMatA);
    const raysB = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 3.6), raysMatB);
    raysA.position.z = -0.5;
    raysB.position.z = -0.45;
    raysB.rotation.z = 0.4;
    raysA.renderOrder = raysB.renderOrder = -1;
    root.add(raysA, raysB);

    // Effects that sit on the core; positioned once the emitter's real centre is measured.
    const coreFx = new THREE.Group();
    root.add(coreFx);

    const plasma = createPlasma();
    plasma.mesh.renderOrder = 10;
    (plasma.mesh.material as THREE.ShaderMaterial).depthTest = false;
    coreFx.add(plasma.mesh);

    const coreHalo = new THREE.Sprite(additive(glowTex, LOOKS.idle.a, 0));
    coreHalo.renderOrder = 11;
    coreFx.add(coreHalo);

    const streak = new THREE.Sprite(additive(streakTex, LOOKS.idle.core, 0));
    streak.renderOrder = 12;
    coreFx.add(streak);

    const motes = createMotes(160, 0.28, 1.55);
    motes.points.renderOrder = 9;
    root.add(motes.points);

    // Voice-reactive waveform ring
    const WAVE_PTS = 128;
    const waveGeo = new THREE.BufferGeometry();
    waveGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WAVE_PTS * 3), 3));
    const waveMat = new THREE.LineBasicMaterial({
      color: LOOKS.idle.core,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
    });
    const waveLine = new THREE.LineLoop(waveGeo, waveMat);
    waveLine.position.z = 0.5;
    waveLine.renderOrder = 13;
    root.add(waveLine);

    // Shockwave rings (tool calls, overdrive, end of ignition)
    const pulseMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: LOOKS.idle.core,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    });
    const pulseRing = new THREE.Mesh(new THREE.RingGeometry(0.96, 1.0, 96), pulseMat);
    pulseRing.position.z = 0.45;
    pulseRing.renderOrder = 14;
    root.add(pulseRing);

    // ---- Model --------------------------------------------------------------------------
    const reactorGroup = new THREE.Group();
    root.add(reactorGroup);

    const flow = createFlowUniforms();
    const emitterMats: THREE.MeshStandardMaterial[] = [];
    let loadedAt = -Infinity;
    let gapLight: ReturnType<typeof createGapLight> | null = null;
    let disposed = false;

    new GLTFLoader().load(
      './models/arc_reactor.glb',
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        const toRemove: THREE.Object3D[] = [];
        const patched = new Set<THREE.Material>();

        model.traverse((obj) => {
          const name = (obj.name || '').toLowerCase();
          // Drop the stand, the ground plane and the second reactor lying on the ground.
          if (name.includes('stand') || name.includes('ground')) {
            toRemove.push(obj);
            return;
          }
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
          for (const m of mats) {
            if (!m || patched.has(m)) continue;
            patched.add(m);
            const mn = (m.name || '').toLowerCase();
            if (mn.includes('stand') || mn.includes('ground')) {
              toRemove.push(mesh);
              continue;
            }
            if (mn.includes('emitter')) {
              m.emissive = new THREE.Color(LOOKS.idle.a);
              m.emissiveIntensity = 0;
              emitterMats.push(m);
              continue;
            }
            // Metals: polish them a little so the moving lights draw clean highlights.
            if (mn === 'gold' || mn.includes('copper') || mn === 'metal' || mn.includes('palladium')) {
              m.envMapIntensity = 1.4;
              m.roughness = Math.max(0.06, (m.roughness ?? 0.3) * 0.85);
            }
            // Outer glass: a thin tinted shell, so it catches highlights instead of washing white.
            if (mn === 'glass') {
              const g = m as THREE.MeshPhysicalMaterial;
              if ('transmission' in g) g.transmission = 0;
              g.color = new THREE.Color(0x0b2a3a);
              g.opacity = 0.22;
              g.roughness = 0.08;
              g.envMapIntensity = 2.2;
              g.depthWrite = false;
            }
            // The base texture of the body/frames: darken slightly so the core light dominates.
            if (mn === 'arcmk1mat') {
              m.envMapIntensity = 0.9;
              m.color = new THREE.Color(0x9aa4ad);
            }
            // Energy flows around the coils only when explicitly enabled (light now lives in
            // the open segments between the windings, see createGapLight).
            if (COPPER_FLOW && mn.includes('copper')) addEnergyFlow(m, flow);
          }
        });
        for (const obj of toRemove) obj.parent?.remove(obj);

        const arcNode = model.getObjectByName('ARC_MK1') ?? model;
        reactorGroup.add(arcNode);
        arcNode.rotation.set(0, 0, 0);
        arcNode.position.set(0, 0, 0);
        arcNode.scale.set(1, 1, 1);
        arcNode.updateMatrixWorld(true);

        const box = new THREE.Box3().setFromObject(arcNode);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const scale = 2.75 / (Math.max(size.x, size.y, size.z) || 1);
        arcNode.position.sub(center);
        reactorGroup.scale.setScalar(scale);
        reactorGroup.updateMatrixWorld(true);

        // Fit the core effects to the real emitter so the plasma sits exactly in the window.
        const emitters = ['light1', 'light2']
          .map((n) => arcNode.getObjectByName(n))
          .filter((o): o is THREE.Object3D => !!o);
        const eBox = new THREE.Box3();
        for (const e of emitters) eBox.expandByObject(e);
        if (!eBox.isEmpty()) {
          const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
          eBox.applyMatrix4(toRoot);
          const ec = eBox.getCenter(new THREE.Vector3());
          const es = eBox.getSize(new THREE.Vector3());
          const r = Math.max(0.12, Math.min(0.6, Math.max(es.x, es.y) / 2));
          coreFx.position.set(ec.x, ec.y, eBox.max.z + 0.02);
          plasma.mesh.scale.setScalar(r * 1.05);
          coreHalo.userData.base = r * 5.2;
          streak.userData.base = r * 14;
          coreLight.position.set(ec.x, ec.y, eBox.max.z + 0.35);
        } else {
          coreFx.position.set(0, 0, size.z * scale * 0.5);
          plasma.mesh.scale.setScalar(0.3);
          coreHalo.userData.base = 1.6;
          streak.userData.base = 4;
        }
        flow.uFlowCenter.value.set(coreFx.position.x, coreFx.position.y, 0);

        // Map the copper windings by angle (in reactorGroup's frame, so the light turns with
        // the ring) and shine light only through the open segments between them.
        const toGroup = new THREE.Matrix4().copy(reactorGroup.matrixWorld).invert();
        const angles: number[] = [];
        const radii: number[] = [];
        let frontZ = -Infinity;
        const v = new THREE.Vector3();
        arcNode.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
          const names = mats.map((m) => (m?.name || '').toLowerCase());
          const isCopper = names.some((n) => n === 'copper');
          const isGlass = names.some((n) => n === 'glass');
          if (!isCopper && !isGlass) return;
          const posAttr = mesh.geometry.getAttribute('position');
          const m = new THREE.Matrix4().multiplyMatrices(toGroup, mesh.matrixWorld);
          const step = Math.max(1, Math.floor(posAttr.count / 4000));
          for (let i = 0; i < posAttr.count; i += step) {
            v.fromBufferAttribute(posAttr, i).applyMatrix4(m);
            if (isGlass) frontZ = Math.max(frontZ, v.z);
            if (isCopper) {
              angles.push(Math.atan2(v.y, v.x));
              radii.push(Math.hypot(v.x, v.y));
            }
          }
        });
        if (angles.length > 0) {
          radii.sort((x, y) => x - y);
          const rIn = radii[Math.floor(radii.length * 0.05)];
          const rOut = radii[Math.floor(radii.length * 0.95)];
          gapLight = createGapLight(angles, rIn, rOut);
          gapLight.mesh.position.z = Number.isFinite(frontZ) ? frontZ + 0.01 : 0;
          gapLight.mesh.renderOrder = 8;
          reactorGroup.add(gapLight.mesh);
        }

        loadedAt = performance.now();
      },
      undefined,
      (err) => console.warn('[ReactorCanvas] Failed to load ./models/arc_reactor.glb:', err),
    );

    const resize = () => {
      const w = host.clientWidth || 300;
      const h = host.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // ---- Animation ----------------------------------------------------------------------
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const colA = new THREE.Color(LOOKS.idle.a);
    const colB = new THREE.Color(LOOKS.idle.b);
    const colCore = new THREE.Color(LOOKS.idle.core);
    const tA = new THREE.Color();
    const tB = new THREE.Color();
    const tC = new THREE.Color();
    let speed = LOOKS.idle.speed;
    let intensity = LOOKS.idle.intensity;
    let think = 0;
    let level = 0;
    let spin = 0;
    let swirl = 0;
    let last = performance.now();
    let ignitionPulsed = false;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now * 0.001;
      const mode = presence.get().mode;
      const look = LOOKS[mode];
      const k = 1 - Math.exp(-4 * dt);

      colA.lerp(tA.setHex(look.a), k);
      colB.lerp(tB.setHex(look.b), k);
      colCore.lerp(tC.setHex(look.core), k);
      speed += (look.speed - speed) * k;
      intensity += (look.intensity - intensity) * k;
      think += (look.think - think) * k;
      level += (presence.level - level) * (1 - Math.exp(-14 * dt));

      // Power: ignition, then a slow breath, a faint electrical flicker, and state-specific beats.
      const ignite = ignitionCurve((now - loadedAt) / 1000);
      if (!ignitionPulsed && ignite >= 1) {
        ignitionPulsed = true;
        presence.pulse();
      }
      const breath = reducedMotion ? 0 : 0.5 + 0.5 * Math.sin(t * 1.6 * speed);
      const flicker = reducedMotion ? 0 : (Math.sin(t * 37) * Math.sin(t * 23.3) > 0.92 ? 0.12 : 0);
      // Approval: a double "heartbeat" asking for attention.
      const beatT = (t * 1.1) % 1;
      const heartbeat = mode === 'approval' ? Math.exp(-beatT * 14) + 0.7 * Math.exp(-Math.max(0, beatT - 0.18) * 14) * (beatT > 0.18 ? 1 : 0) : 0;
      const boostAge = (now - boostAtRef.current) / 1000;
      const boost = boostAge >= 0 && boostAge < 1.4 ? Math.exp(-boostAge * 2.6) : 0;
      const power = ignite * intensity * (0.86 + breath * 0.14 - flicker + level * 0.55 + heartbeat * 0.35 + boost * 0.9);

      // Core light and emitter
      coreLight.color.copy(colA);
      coreLight.intensity = 9 * power;
      for (const em of emitterMats) {
        em.color.copy(colCore);
        em.emissive.copy(colA);
        em.emissiveIntensity = 3.2 * power;
      }

      // Plasma core
      swirl += dt * (0.8 + think * 2.2 + boost * 3) * speed;
      plasma.uniforms.uTime.value = swirl;
      plasma.uniforms.uSwirl.value = 1;
      plasma.uniforms.uPower.value = Math.min(1.6, power);
      plasma.uniforms.uLevel.value = level + think * 0.4;
      plasma.uniforms.uColA.value.copy(colA);
      plasma.uniforms.uColCore.value.copy(colCore);

      const haloBase = (coreHalo.userData.base as number) ?? 1.6;
      const hs = haloBase * (0.9 + power * 0.25);
      coreHalo.scale.set(hs, hs, 1);
      (coreHalo.material as THREE.SpriteMaterial).color.copy(colA);
      (coreHalo.material as THREE.SpriteMaterial).opacity = Math.min(1, 0.55 * power);

      const streakBase = (streak.userData.base as number) ?? 4;
      streak.scale.set(streakBase * (0.85 + power * 0.3), streakBase * 0.5, 1);
      (streak.material as THREE.SpriteMaterial).color.copy(colCore);
      (streak.material as THREE.SpriteMaterial).opacity = Math.min(0.9, 0.32 * power + boost * 0.4);

      (aura.material as THREE.SpriteMaterial).color.copy(colB);
      (aura.material as THREE.SpriteMaterial).opacity = Math.min(0.85, 0.38 * power + level * 0.2);

      raysMatA.color.copy(colA);
      raysMatB.color.copy(colB);
      raysMatA.opacity = Math.min(0.7, 0.34 * power + boost * 0.3);
      raysMatB.opacity = Math.min(0.6, 0.24 * power + level * 0.25);

      // Energy flowing around the copper coils
      flow.uFlowTime.value += dt * speed * (1 + boost * 2);
      flow.uFlowStrength.value = 1.6 * power;
      flow.uFlowColor.value.copy(colA);

      if (gapLight) {
        gapLight.uniforms.uTime.value = swirl;
        gapLight.uniforms.uPower.value = Math.min(1.5, 1.05 * power);
        gapLight.uniforms.uColor.value.copy(colA);
        gapLight.uniforms.uCore.value.copy(colCore);
      }

      // Orbiting satellite lights sweep highlights across the metal
      const orbit = t * 0.55 * speed;
      satA.position.set(Math.cos(orbit) * 2.1, Math.sin(orbit) * 2.1, 1.3);
      satB.position.set(Math.cos(orbit + Math.PI) * 2.3, Math.sin(orbit + Math.PI) * 2.3, 1.0);
      satA.color.copy(colA);
      satA.intensity = 5 * ignite * intensity;
      satB.intensity = 3 * ignite;
      backRim.color.copy(colB);
      backRim.intensity = 1.2 * ignite;

      // Motes spiral in faster when FRIDAY is busy
      motes.color.copy(colCore);
      if (!reducedMotion) motes.update(dt, speed * (1 + boost * 2.5), Math.min(1, power));

      if (!reducedMotion) {
        // Flat 2D rotation: the reactor always faces Sir square-on and turns only around its
        // own centre (Z axis). No tilt, no float, no separately rotating parts.
        spin += dt * 0.18 * speed * (1 + boost * 2.2);
        reactorGroup.rotation.set(0, 0, spin);
        raysA.rotation.z += dt * 0.05 * speed;
        raysB.rotation.z -= dt * 0.08 * speed;

        // Voice waveform
        const wAttr = waveGeo.getAttribute('position') as THREE.BufferAttribute;
        waveMat.opacity = level > 0.02 ? Math.min(0.95, level * 1.4) : 0;
        waveMat.color.copy(colCore);
        if (waveMat.opacity > 0.01) {
          for (let i = 0; i < WAVE_PTS; i++) {
            const a = (i / WAVE_PTS) * Math.PI * 2;
            const r = 1.02 + level * 0.16 * Math.sin(a * 10 + t * 9) * Math.cos(a * 3 - t * 4);
            wAttr.setXYZ(i, Math.cos(a) * r, Math.sin(a) * r, Math.sin(a * 6 + t * 5) * level * 0.06);
          }
          wAttr.needsUpdate = true;
        }
      }

      // Shockwave
      const pulseAge = (now - presence.lastPulseAt) / 1100;
      if (pulseAge >= 0 && pulseAge < 1) {
        const e = 1 - Math.pow(1 - pulseAge, 3);
        pulseRing.scale.setScalar(0.35 + e * 1.5);
        pulseMat.color.copy(colCore);
        pulseMat.opacity = (1 - pulseAge) * 0.9;
      } else {
        pulseMat.opacity = 0;
      }

      renderer.render(scene, camera);
    };

    // Full rate while igniting or active; a gentle rate for the idle glow.
    const stop = startFrameLoop(tick, () => {
      const igniting = (performance.now() - loadedAt) / 1000 < IGNITION_S + 1.2;
      return igniting || presence.get().mode !== 'idle' ? 60 : 30;
    });

    return () => {
      disposed = true;
      stop();
      ro.disconnect();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      motes.dispose();
      gapLight?.dispose();
      glowTex.dispose();
      raysTex.dispose();
      streakTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={hostRef} className={className} />;
});
