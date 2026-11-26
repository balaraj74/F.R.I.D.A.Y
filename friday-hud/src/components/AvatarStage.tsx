import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMHumanBoneName, VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { startFrameLoop } from '../services/frame-loop';
import { presence, type PresenceMode } from '../services/presence';

// FRIDAY's 3D body: a VRM character from ~/.friday/avatar. Everything she does is driven by real
// state: lips by her actual voice level, face by her mood, posture by what she's doing.
// Without a model or WebGL, onUnavailable() lets the app keep the reactor.

interface Props {
  onUnavailable: () => void;
  statusText?: string;
}

const LABEL: Record<PresenceMode, string> = {
  idle: 'HERE WITH YOU',
  listening: 'LISTENING',
  thinking: 'THINKING',
  acting: 'WORKING ON IT',
  speaking: 'SPEAKING',
  approval: 'NEEDS YOUR OK',
};

// One arm's pose, written for her left arm; the right arm mirrors it.
// uz: arm down from T-pose, ux: swing forward, uy: toward the body, ly: elbow bend, lz: forearm lift, hz/hx: wrist, curl: fingers.
type Arm = { uz: number; ux: number; uy: number; ly: number; lz: number; hz: number; hx: number; curl: number };
const ARM_REST: Arm = { uz: 1.32, ux: 0, uy: 0.12, ly: 0.28, lz: 0.08, hz: 0.1, hx: 0, curl: 0.35 };
const arm = (p: Partial<Arm>): Arm => ({ ...ARM_REST, ...p });
const GESTURES: Record<string, { left: Arm; right: Arm }> = {
  rest: { left: ARM_REST, right: ARM_REST },
  relaxedHip: {
    left: arm({ uz: 1.26, ux: -0.08, uy: 0.22, ly: 0.75, lz: 0.1, hz: 0.15, curl: 0.45 }),
    right: ARM_REST,
  },
  explainR: { left: ARM_REST, right: arm({ ux: 0.5, uz: 1.25, uy: 0.1, ly: 1.5, lz: 0, hz: -0.2, curl: 0.2 }) },
  explainL: { left: arm({ ux: 0.5, uz: 1.25, uy: 0.1, ly: 1.5, lz: 0, hz: -0.2, curl: 0.2 }), right: ARM_REST },
  open: {
    left: arm({ ux: 0.42, uz: 1.2, uy: -0.15, ly: 1.35, lz: 0, hz: -0.3, curl: 0.12 }),
    right: arm({ ux: 0.42, uz: 1.2, uy: -0.15, ly: 1.35, lz: 0, hz: -0.3, curl: 0.12 }),
  },
  chin: { left: ARM_REST, right: arm({ ux: 0.75, uz: 1.3, uy: 0.4, ly: 2.2, lz: 0, hz: 0.2, curl: 0.55 }) },
  thinkCross: {
    left: arm({ ux: 0.35, uz: 1.28, uy: 0.55, ly: 1.45, lz: 0.1, hz: 0.1, curl: 0.4 }),
    right: arm({ ux: 0.78, uz: 1.3, uy: 0.42, ly: 2.22, lz: 0, hz: 0.2, curl: 0.5 }),
  },
  working: {
    left: arm({ ux: 0.52, uz: 1.22, uy: 0.22, ly: 1.55, lz: 0.12, hz: -0.15, curl: 0.28 }),
    right: arm({ ux: 0.52, uz: 1.22, uy: 0.22, ly: 1.55, lz: 0.12, hz: -0.15, curl: 0.28 }),
  },
  cheer: {
    left: arm({ ux: 0.55, uz: 0.75, uy: -0.25, ly: 1.85, lz: 0.1, hz: -0.1, curl: 0.1 }),
    right: arm({ ux: 0.55, uz: 0.75, uy: -0.25, ly: 1.85, lz: 0.1, hz: -0.1, curl: 0.1 }),
  },
  salute: {
    left: arm({ uz: 1.26, ux: -0.08, uy: 0.22, ly: 0.75, lz: 0.1, hz: 0.15, curl: 0.45 }),
    right: arm({ ux: 0.72, uz: 1.05, uy: -0.1, ly: 2.25, lz: 0, hz: 0.15, curl: 0.05 }),
  },
  chest: { left: ARM_REST, right: arm({ uz: 1.25, uy: 0.65, ly: 1.95, lz: 0, hz: 0.1, curl: 0.2 }) },
  mouth: { left: ARM_REST, right: arm({ ux: 0.8, uz: 1.3, uy: 0.35, ly: 2.3, lz: 0, hz: 0.3, curl: 0.4 }) },
  attentive: {
    left: arm({ uz: 1.28, uy: 0.5, ly: 0.95, lz: 0, curl: 0.45 }),
    right: arm({ uz: 1.28, uy: 0.5, ly: 0.95, lz: 0, curl: 0.45 }),
  },
  wave: { left: ARM_REST, right: arm({ ux: 0.6, uz: 1.15, uy: -0.2, ly: 2.15, lz: 0, hz: 0, curl: 0.08 }) },
};
const TALK_GESTURES = ['explainR', 'open', 'explainL', 'chest', 'cheer', 'explainR', 'open'];
const IDLE_GESTURES = ['rest', 'relaxedHip', 'chest', 'open', 'salute'];
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
const JOINTS: Record<string, string[]> = {
  Thumb: ['Metacarpal', 'Proximal', 'Distal'],
  Index: ['Proximal', 'Intermediate', 'Distal'],
  Middle: ['Proximal', 'Intermediate', 'Distal'],
  Ring: ['Proximal', 'Intermediate', 'Distal'],
  Little: ['Proximal', 'Intermediate', 'Distal'],
};

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export const AvatarStage: React.FC<Props> = ({ onUnavailable, statusText }) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<PresenceMode>('idle');
  const [loading, setLoading] = useState(true);

  useEffect(() => presence.subscribe((s) => setMode(s.mode)), []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let vrm: VRM | null = null;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch {
      onUnavailable();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(20, 1, 0.1, 20);
    // Studio 3-point + cyan/violet rim lighting so she pops with depth and warmth.
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const key = new THREE.DirectionalLight(0xfff6ee, 1.45);
    key.position.set(0.4, 1.3, 2.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdbeafe, 0.55);
    fill.position.set(-1.2, 0.4, 1.5);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0x38bdf8, 1.15);
    rim.position.set(-0.8, 1.6, -1.8);
    scene.add(rim);
    const rimWarm = new THREE.DirectionalLight(0xc084fc, 0.65);
    rimWarm.position.set(1.1, 1.1, -1.6);
    scene.add(rimWarm);

    // Subtle holographic aura ring behind her that breathes with her state & voice.
    const auraGroup = new THREE.Group();
    const ringGeo = new THREE.RingGeometry(0.42, 0.432, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    });
    const auraRing = new THREE.Mesh(ringGeo, ringMat);
    const outerRingGeo = new THREE.RingGeometry(0.48, 0.486, 64);
    const outerRingMat = new THREE.MeshBasicMaterial({
      color: 0x818cf8,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
    });
    const outerRing = new THREE.Mesh(outerRingGeo, outerRingMat);
    auraGroup.add(auraRing, outerRing);
    auraGroup.position.set(0, 1.25, -0.45);
    scene.add(auraGroup);

    const lookTarget = new THREE.Object3D();
    scene.add(lookTarget);

    const resize = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    // --- Animation state ------------------------------------------------------------------
    let last = performance.now();
    let t = 0;
    let mouth = 0;
    let nextBlink = 2;
    let blink = 0; // 0..1 progress, 0 = idle
    let lookX = 0;
    let lookY = 0;
    let nextGlance = 3;
    let pointerX = 0;
    let pointerY = 0;
    let pointerActive = false;
    let pointerLastAt = -Infinity;
    const face = { happy: 0, sad: 0, relaxed: 0.2, surprised: 0 };
    let tiltZ = 0;
    let tiltX = 0;
    let turnY = 0;
    let laugh = 0;
    let sigh = 0;
    let cheerBoost = 0;
    let clickReactionIdx = 0;
    let dragYaw = 0;
    let dragStartX: number | null = null;
    let didDrag = false;
    // Gestures: one named pose at a time, blended smoothly; talk gestures rotate while she speaks.
    let gesture = 'rest';
    let gestureUntil = 0; // one-off gesture (wave, sigh, laugh) holds until this time
    let nextTalk = 0.6;
    let nextIdleShift = 4.5;
    let idlePose = 'rest';
    const live = { left: { ...ARM_REST }, right: { ...ARM_REST } };

    const onPointerDown = (e: PointerEvent) => {
      dragStartX = e.clientX;
      didDrag = false;
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = mount.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointerX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointerY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      pointerActive = true;
      pointerLastAt = performance.now();
      if (dragStartX !== null) {
        const dx = e.clientX - dragStartX;
        if (Math.abs(dx) > 6) didDrag = true;
        dragYaw = clamp(dx / 180, -0.55, 0.55);
      }
    };
    const onPointerUp = () => {
      dragStartX = null;
    };
    const onPointerLeave = () => {
      pointerActive = false;
      dragStartX = null;
    };
    const onPointerClick = () => {
      if (didDrag) return;
      const reactions: Array<() => void> = [
        () => { gesture = 'wave'; gestureUntil = t + 2.0; cheerBoost = 0.6; },
        () => { laugh = 1; gesture = 'mouth'; gestureUntil = t + 1.4; },
        () => { gesture = 'cheer'; gestureUntil = t + 1.8; cheerBoost = 1; },
        () => { gesture = 'salute'; gestureUntil = t + 1.7; cheerBoost = 0.5; },
        () => { gesture = 'chest'; gestureUntil = t + 1.6; },
      ];
      reactions[clickReactionIdx % reactions.length]();
      clickReactionIdx++;
    };
    const onDoubleClick = () => {
      laugh = 1;
      cheerBoost = 1;
      gesture = 'cheer';
      gestureUntil = t + 2.2;
    };
    mount.addEventListener('pointerdown', onPointerDown);
    mount.addEventListener('pointermove', onPointerMove);
    mount.addEventListener('pointerup', onPointerUp);
    mount.addEventListener('pointerleave', onPointerLeave);
    mount.addEventListener('click', onPointerClick);
    mount.addEventListener('dblclick', onDoubleClick);

    const unsubEmote = presence.onEmote((kind) => {
      if (kind === 'laugh') {
        laugh = 1;
        gesture = 'mouth';
        gestureUntil = t + 1.3;
      }
      if (kind === 'sigh') {
        sigh = 1;
        gesture = 'chest';
        gestureUntil = t + 1.8;
      }
      if (kind === 'wave') {
        gesture = 'wave';
        gestureUntil = t + 2.2;
      }
    });

    const bone = (n: string) => vrm?.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName) ?? null;

    const animate = (now: number) => {
      const m = presence.get().mode;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      if (!vrm) {
        renderer.render(scene, camera);
        return;
      }

      const em = vrm.expressionManager;
      const affect = presence.affect;
      const speaking = m === 'speaking';
      const thinking = m === 'thinking';
      const acting = m === 'acting';
      const listening = m === 'listening';
      const level = clamp(presence.level * 1.6);

      // Lips: open with her real voice, with shape changing as she talks.
      mouth = damp(mouth, speaking ? level : 0, speaking ? 22 : 12, dt);
      const shape = Math.sin(t * 9.1) * 0.5 + Math.sin(t * 5.3) * 0.5;
      em?.setValue('aa', clamp(mouth * (0.75 + 0.25 * shape)));
      em?.setValue('ih', clamp(mouth * 0.35 * Math.max(0, shape)));
      em?.setValue('ou', clamp(mouth * 0.4 * Math.max(0, -shape)));

      // Blink every few seconds, sometimes twice.
      nextBlink -= dt;
      if (nextBlink <= 0) {
        blink = 0.0001;
        nextBlink = 2 + Math.random() * 4 * (Math.random() < 0.2 ? 0.08 : 1);
      }
      if (blink > 0) {
        blink += dt / 0.16;
        if (blink >= 1) blink = 0;
      }
      const blinkAmt = blink > 0 ? Math.sin(blink * Math.PI) : 0;

      // Mood: a gentle resting smile, shaped by her real affect state.
      laugh = Math.max(0, laugh - dt / 1.4);
      sigh = Math.max(0, sigh - dt / 1.8);
      cheerBoost = Math.max(0, cheerBoost - dt / 1.8);
      if (dragStartX === null) dragYaw = damp(dragYaw, 0, 5, dt);
      const warm = clamp(affect.valence);
      const hoverBoost = pointerActive && now - pointerLastAt < 2500 ? 0.14 : 0;
      face.happy = damp(face.happy, clamp(0.18 + warm * 0.55 + (speaking ? 0.16 : 0) + hoverBoost + laugh + cheerBoost * 0.6), 5, dt);
      face.sad = damp(face.sad, clamp(-affect.valence * 0.6), 4, dt);
      face.relaxed = damp(face.relaxed, clamp((thinking ? 0.08 : 0.22) + sigh * 0.7), 4, dt);
      face.surprised = damp(face.surprised, m === 'approval' ? 0.32 : cheerBoost * 0.22, 5, dt);
      const smileCut = 1 - clamp(mouth * 0.7); // keep the mouth shapes readable while talking
      em?.setValue('happy', face.happy * smileCut);
      em?.setValue('sad', face.sad);
      em?.setValue('relaxed', face.relaxed * smileCut);
      em?.setValue('surprised', face.surprised);
      em?.setValue('blink', Math.max(blinkAmt, sigh * 0.65));

      // Eyes: track cursor when hovering, glance naturally at rest, scan while acting, look up while thinking.
      nextGlance -= dt;
      if (nextGlance <= 0) {
        nextGlance = 1.5 + Math.random() * 3.5;
        lookX = (Math.random() - 0.5) * 0.18;
        lookY = (Math.random() - 0.5) * 0.1;
      }
      const head = bone('head');
      const headY = head ? head.getWorldPosition(new THREE.Vector3()).y : 1.3;
      const cursorFresh = pointerActive && now - pointerLastAt < 3000;
      let targetLookX = lookX;
      let targetLookY = lookY;
      if (thinking) {
        targetLookX = 0.42 + Math.sin(t * 0.9) * 0.12;
        targetLookY = 0.32 + Math.cos(t * 0.7) * 0.06;
      } else if (acting) {
        targetLookX = Math.sin(t * 2.4) * 0.28;
        targetLookY = -0.12 + Math.sin(t * 1.3) * 0.05;
      } else if (cursorFresh) {
        targetLookX = pointerX * 0.38;
        targetLookY = pointerY * 0.22;
      }
      lookTarget.position.set(
        camera.position.x + targetLookX,
        headY + targetLookY,
        camera.position.z,
      );

      // Posture: expressive head tilts, listening nods, thinking ponder, acting focus, cursor follow.
      const listenNod = listening ? Math.sin(t * 2.6) * 0.035 : 0;
      const cursorTurn = cursorFresh && !thinking && !acting ? pointerX * 0.14 : 0;
      const cursorTilt = cursorFresh && !thinking && !acting ? pointerY * -0.08 : 0;
      const wantTiltZ = listening ? 0.1 : thinking ? -0.09 + Math.sin(t * 0.8) * 0.02 : acting ? 0.03 * Math.sin(t * 1.4) : Math.sin(t * 0.55) * 0.035;
      const wantTiltX = listening ? 0.06 + listenNod : speaking ? 0.03 + mouth * 0.06 : acting ? 0.08 : thinking ? -0.04 : cursorTilt;
      const wantTurnY = thinking ? 0.14 + Math.sin(t * 0.6) * 0.04 : acting ? Math.sin(t * 1.6) * 0.08 : cursorTurn + Math.sin(t * 0.35) * 0.04;

      tiltZ = damp(tiltZ, wantTiltZ, 3.5, dt);
      tiltX = damp(tiltX, wantTiltX, 5, dt);
      turnY = damp(turnY, wantTurnY, 4, dt);
      const breath = Math.sin(t * 1.6) * (1 + sigh * 2.5);
      const bounce = laugh > 0 ? Math.sin(t * 22) * 0.014 * laugh : 0;

      if (head) head.rotation.set(tiltX + Math.sin(t * 0.7) * 0.014 + bounce, turnY, tiltZ);
      const neck = bone('neck');
      if (neck) neck.rotation.set(tiltX * 0.45, turnY * 0.45, tiltZ * 0.35);
      const chest = bone('upperChest') ?? bone('chest');
      if (chest) {
        chest.rotation.x = breath * 0.014 + bounce + (acting ? 0.04 : 0);
        chest.rotation.y = acting ? Math.sin(t * 1.2) * 0.03 : Math.sin(t * 0.4) * 0.015;
      }
      const spine = bone('spine');
      if (spine) {
        spine.rotation.y = Math.sin(t * 0.42) * 0.022 + (cursorFresh ? pointerX * 0.04 : 0);
        spine.rotation.z = Math.sin(t * 0.33) * 0.018;
      }
      const hips = bone('hips');
      if (hips) {
        const cheerHop = cheerBoost > 0 ? Math.abs(Math.sin(t * 8)) * 0.012 * cheerBoost : 0;
        hips.position.y = hipsY + Math.sin(t * 1.6) * 0.002 + cheerHop;
        hips.rotation.z = Math.sin(t * 0.33) * 0.015;
        hips.rotation.y = dragYaw;
      }

      // Holographic aura ring reacts to mode, voice level, and enthusiasm.
      const auraColor = listening ? 0x34d399 : thinking || acting ? 0xfbbf24 : speaking ? 0x38bdf8 : 0x67e8f9;
      ringMat.color.lerp(new THREE.Color(auraColor), 0.08);
      const auraScale = 1 + level * 0.12 + cheerBoost * 0.08 + Math.sin(t * 2.2) * 0.02;
      auraGroup.scale.setScalar(auraScale);
      auraGroup.rotation.z = t * (acting ? 0.6 : 0.15);
      ringMat.opacity = 0.16 + level * 0.25 + cheerBoost * 0.18;
      outerRingMat.opacity = 0.1 + (acting ? 0.18 : 0.04) + level * 0.12;

      // Hands and arms: distinct poses for thinking, acting, listening, speaking, and lively idle shifts.
      if (t >= gestureUntil) {
        if (thinking) {
          gesture = Math.sin(t * 0.4) > 0 ? 'thinkCross' : 'chin';
        } else if (acting) {
          gesture = 'working';
        } else if (listening) {
          gesture = 'attentive';
        } else if (m === 'approval') {
          gesture = 'open';
        } else if (speaking) {
          nextTalk -= dt;
          if (nextTalk <= 0) {
            gesture = gesture === 'rest' ? TALK_GESTURES[Math.floor(Math.random() * TALK_GESTURES.length)] : 'rest';
            nextTalk = gesture === 'rest' ? 0.4 + Math.random() * 0.9 : 1.0 + Math.random() * 1.1;
          }
        } else {
          nextIdleShift -= dt;
          if (nextIdleShift <= 0) {
            idlePose = IDLE_GESTURES[Math.floor(Math.random() * IDLE_GESTURES.length)];
            nextIdleShift = idlePose === 'rest' ? 3.5 + Math.random() * 3.5 : 2.2 + Math.random() * 2.0;
          }
          gesture = idlePose;
        }
      }
      // Old-format (VRM 0) models are turned around on load, which mirrors the arm direction.
      const armDir = vrm.meta?.metaVersion === '0' ? 1 : -1;
      const pose = GESTURES[gesture] ?? GESTURES.rest;
      const waving = gesture === 'wave' ? Math.sin(t * 9) * 0.32 : gesture === 'cheer' ? Math.sin(t * 10) * 0.18 : 0;
      for (const [side, sign] of [['left', armDir], ['right', -armDir]] as const) {
        const cur = live[side];
        const want = pose[side];
        for (const k of Object.keys(cur) as (keyof Arm)[]) cur[k] = damp(cur[k], want[k], 6.5, dt);
        const sway = Math.sin(t * 1.5 + (side === 'left' ? 0 : 0.8)) * 0.016;
        const beat = speaking && gesture !== 'rest' ? Math.sin(t * 7) * mouth * 0.07 : 0;
        const workMotion = acting ? Math.sin(t * 5.5 + (side === 'left' ? 0 : Math.PI)) * 0.09 : 0;
        const workWrist = acting ? Math.cos(t * 6.5 + (side === 'left' ? 0 : 1.2)) * 0.12 : 0;
        const upper = bone(`${side}UpperArm`);
        if (upper) upper.rotation.set(armDir * (cur.ux + workMotion * 0.4), -sign * cur.uy, sign * (cur.uz + sway + sigh * 0.03));
        const lower = bone(`${side}LowerArm`);
        if (lower) lower.rotation.set(0, -sign * (cur.ly + beat + workMotion), sign * cur.lz);
        const hand = bone(`${side}Hand`);
        if (hand) hand.rotation.set(cur.hx + workWrist, 0, sign * (cur.hz + (side === 'right' || gesture === 'cheer' ? waving : 0)));
        for (const f of FINGERS) {
          JOINTS[f].forEach((j, n) => {
            const node = bone(`${side}${f}${j}`);
            if (!node) return;
            const fingerTap = acting ? Math.sin(t * 9 + n + (side === 'left' ? 0 : 1.5)) * 0.12 : 0;
            if (f === 'Thumb') node.rotation.set(0, sign * (cur.curl + fingerTap) * 0.5, 0);
            else node.rotation.set(0, 0, sign * (cur.curl + fingerTap) * (n === 0 ? 0.8 : 1.2));
          });
        }
      }

      vrm.update(dt);
      renderer.render(scene, camera);
    };
    let hipsY = 0;
    // Full frame rate while she's active or moving; 30 fps at rest. Stops while hidden.
    const stopLoop = startFrameLoop(animate, () => (presence.get().mode === 'idle' && t >= gestureUntil ? 30 : 60));

    // --- Load the character ------------------------------------------------------------------
    (async () => {
      try {
        const data = await window.electronAPI?.loadAvatar?.();
        if (!data || disposed) {
          if (!disposed) onUnavailable();
          return;
        }
        const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = await loader.parseAsync(buffer as ArrayBuffer, '');
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        VRMUtils.rotateVRM0(loaded); // old-format models face the other way
        scene.add(loaded.scene);
        loaded.scene.traverse((o) => {
          o.frustumCulled = false;
        });
        vrm = loaded;
        hipsY = loaded.humanoid.getNormalizedBoneNode('hips' as VRMHumanBoneName)?.position.y ?? 0;
        if (loaded.lookAt) loaded.lookAt.target = lookTarget;

        // Frame her from the waist up, eyes in the upper third.
        loaded.update(0);
        const headPos = loaded.humanoid.getNormalizedBoneNode('head' as VRMHumanBoneName)!.getWorldPosition(new THREE.Vector3());
        const focusY = headPos.y - 0.13;
        camera.position.set(0, focusY + 0.03, 1.95);
        camera.lookAt(0, focusY, 0);
        setLoading(false);
        setTimeout(() => presence.emote('wave'), 900);
      } catch (e) {
        console.warn('[avatar] could not load model:', e);
        if (!disposed) onUnavailable();
      }
    })();

    return () => {
      disposed = true;
      stopLoop();
      unsubEmote();
      mount.removeEventListener('pointerdown', onPointerDown);
      mount.removeEventListener('pointermove', onPointerMove);
      mount.removeEventListener('pointerup', onPointerUp);
      mount.removeEventListener('pointerleave', onPointerLeave);
      mount.removeEventListener('click', onPointerClick);
      mount.removeEventListener('dblclick', onDoubleClick);
      observer.disconnect();
      ringGeo.dispose();
      ringMat.dispose();
      outerRingGeo.dispose();
      outerRingMat.dispose();
      if (vrm) VRMUtils.deepDispose(vrm.scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative w-full h-full min-h-0 flex items-center justify-center">
      <div ref={mountRef} className="absolute inset-0 cursor-pointer" title="Click to interact with FRIDAY" />
      {loading && <div className="relative text-xs font-mono text-cyan-300/70">FRIDAY is arriving…</div>}
      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-slate-950/70 border border-cyan-500/30 text-[10px] font-mono tracking-widest text-cyan-200 flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full ${mode === 'idle' ? 'bg-emerald-400' : 'bg-cyan-300 animate-pulse'}`} />
        {statusText && mode === 'idle' ? statusText : LABEL[mode]}
      </div>
    </div>
  );
};
