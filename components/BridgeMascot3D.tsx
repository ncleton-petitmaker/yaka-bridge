"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type BridgeMascotMode = "assembled" | "layers" | "flow" | "head";

type BridgeMascot3DProps = {
  mode: BridgeMascotMode;
};

type FlowPulse = {
  curve: THREE.CatmullRomCurve3;
  pulse: THREE.Mesh;
  offset: number;
  speed: number;
};

type ModuleBlock = {
  group: THREE.Group;
  offset: number;
  spin: number;
};

type SceneRefs = {
  business: THREE.Group;
  bridge: THREE.Group;
  codex: THREE.Group;
  headRoot: THREE.Group;
  headPivot: THREE.Group;
  leftPupil: THREE.Mesh;
  rightPupil: THREE.Mesh;
  moduleBlocks: ModuleBlock[];
  flowPulses: FlowPulse[];
  moduleCurve: THREE.CatmullRomCurve3;
  cameraTarget: THREE.Vector3;
};

type Palette = {
  bg: string;
  surface: string;
  subtle: string;
  mutedSurface: string;
  border: string;
  borderStrong: string;
  fg: string;
  fgStrong: string;
  accent: string;
  accentTint: string;
  blue: string;
  amber: string;
  green: string;
};

const baseHeadPosition = new THREE.Vector3(0, 0.93, 0.1);
const targetBusiness = new THREE.Vector3(-3.86, -0.16, 0);
const targetBridge = new THREE.Vector3(0, -0.06, 0);
const targetCodex = new THREE.Vector3(3.66, -0.24, 0);

export function BridgeMascot3D({ mode }: BridgeMascot3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef(mode);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let frameId = 0;
    let firstFrame = true;

    const palette = readPalette();
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = { x: 0, y: 0 };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(palette.bg);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 2.05, 10.35);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.domElement.className = "bridge-mascot-canvas";
    renderer.domElement.setAttribute("aria-hidden", "true");
    container.appendChild(renderer.domElement);

    addLights(scene, palette);
    const refs = buildMascotScene(scene, palette);
    let lastFrameTime = performance.now();
    const startTime = lastFrameTime;

    const resize = () => {
      if (disposed) return;
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = THREE.MathUtils.clamp(((event.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
      pointer.y = THREE.MathUtils.clamp(((event.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
    };

    const onPointerLeave = () => {
      pointer.x = 0;
      pointer.y = 0;
    };

    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);

    const render = () => {
      const now = performance.now();
      const delta = Math.min((now - lastFrameTime) / 1000, 0.04);
      const elapsed = (now - startTime) / 1000;
      lastFrameTime = now;
      const activeMode = modeRef.current;
      const reduceMotion = reducedMotionQuery.matches;

      updateLayerTargets(refs, activeMode, delta);
      updateHead(refs, pointer, activeMode, delta, elapsed, reduceMotion);
      updateModuleBlocks(refs, activeMode, elapsed, reduceMotion);
      updateFlowPulses(refs.flowPulses, activeMode, elapsed, reduceMotion);
      updateCamera(camera, refs.cameraTarget, activeMode, delta);

      renderer.render(scene, camera);

      if (firstFrame && !disposed) {
        firstFrame = false;
        setReady(true);
      }

      frameId = window.requestAnimationFrame(render);
    };

    render();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      disposeObject(scene);
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="bridge-mascot-host"
      data-ready={ready ? "true" : "false"}
      data-testid="bridge-mascot-canvas-host"
    >
      {!ready && (
        <div className="bridge-mascot-loading" aria-hidden="true">
          <span className="spinner" />
        </div>
      )}
      <p className="bridge-mascot-a11y">
        Interactive 3D mascot: a bridge-shaped robot connects business tool blocks
        to a coding workbench while module blocks move across the bridge.
      </p>
    </div>
  );
}

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, defaultValue: string) => styles.getPropertyValue(name).trim() || defaultValue;

  return {
    bg: token("--bg", "white"),
    surface: token("--surface", "white"),
    subtle: token("--subtle", "whitesmoke"),
    mutedSurface: token("--bg-muted", "lightgray"),
    border: token("--border", "gainsboro"),
    borderStrong: token("--border-strong", "silver"),
    fg: token("--fg", "black"),
    fgStrong: token("--fg-strong", "black"),
    accent: token("--accent", "orangered"),
    accentTint: token("--accent-tint", "mistyrose"),
    blue: token("--blue", "royalblue"),
    amber: token("--amber", "darkorange"),
    green: token("--green", "seagreen"),
  };
}

function addLights(scene: THREE.Scene, palette: Palette) {
  scene.add(new THREE.HemisphereLight(new THREE.Color(palette.surface), new THREE.Color(palette.mutedSurface), 2.1));

  const key = new THREE.DirectionalLight(new THREE.Color(palette.surface), 2.8);
  key.position.set(-3.4, 5.1, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 16;
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  scene.add(key);

  const fill = new THREE.PointLight(new THREE.Color(palette.accentTint), 28, 12);
  fill.position.set(3.2, 1.4, 4.5);
  scene.add(fill);
}

function buildMascotScene(scene: THREE.Scene, palette: Palette): SceneRefs {
  const materials = createMaterials(palette);
  const root = new THREE.Group();
  root.position.set(0, 0, 0);
  scene.add(root);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6.2, 96),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.subtle),
      roughness: 0.96,
      metalness: 0,
      transparent: true,
      opacity: 0.72,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -1.17, 0.02);
  ground.receiveShadow = true;
  root.add(ground);

  const business = createBusinessCluster(materials);
  business.position.copy(targetBusiness);
  root.add(business);

  const bridge = new THREE.Group();
  bridge.position.copy(targetBridge);
  root.add(bridge);

  const bridgeBody = createBridgeBody(materials);
  bridge.add(bridgeBody);

  const moduleCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-1.42, 0.12, 0.6),
    new THREE.Vector3(-0.55, 0.18, 0.7),
    new THREE.Vector3(0.15, 0.19, 0.72),
    new THREE.Vector3(1.38, 0.12, 0.6),
  ]);

  const moduleBlocks = createModuleBlocks(materials);
  moduleBlocks.forEach((block) => bridge.add(block.group));

  const headParts = createRobotHead(materials);
  headParts.headRoot.position.copy(baseHeadPosition);
  bridge.add(headParts.headRoot);

  const codex = createCodexWorkbench(materials);
  codex.position.copy(targetCodex);
  root.add(codex);

  const flowPulses = [
    ...createBusinessFlow(root, materials),
    ...createCodexFlow(root, materials),
  ];

  return {
    business,
    bridge,
    codex,
    headRoot: headParts.headRoot,
    headPivot: headParts.headPivot,
    leftPupil: headParts.leftPupil,
    rightPupil: headParts.rightPupil,
    moduleBlocks,
    flowPulses,
    moduleCurve,
    cameraTarget: new THREE.Vector3(0, 0, 0),
  };
}

function createMaterials(palette: Palette) {
  const standard = (color: string, roughness = 0.82, metalness = 0.03) =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness,
      metalness,
    });

  const transparent = (color: string, opacity: number, roughness = 0.72) =>
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness,
      metalness: 0.02,
      transparent: true,
      opacity,
    });

  return {
    body: standard(palette.surface, 0.86),
    bodySoft: standard(palette.subtle, 0.9),
    base: standard(palette.mutedSurface, 0.88),
    border: standard(palette.borderStrong, 0.8),
    dark: standard(palette.fgStrong, 0.58, 0.06),
    darkSoft: standard(palette.fg, 0.72, 0.04),
    accent: standard(palette.accent, 0.72),
    accentSoft: standard(palette.accentTint, 0.88),
    blue: standard(palette.blue, 0.68),
    amber: standard(palette.amber, 0.68),
    green: standard(palette.green, 0.68),
    glass: transparent(palette.blue, 0.38, 0.32),
    line: new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.blue),
      emissive: new THREE.Color(palette.blue),
      emissiveIntensity: 0.32,
      roughness: 0.54,
      metalness: 0.02,
      transparent: true,
      opacity: 0.62,
    }),
    lineAccent: new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.accent),
      emissive: new THREE.Color(palette.accent),
      emissiveIntensity: 0.28,
      roughness: 0.54,
      metalness: 0.02,
      transparent: true,
      opacity: 0.58,
    }),
    glowBlue: new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.blue),
      emissive: new THREE.Color(palette.blue),
      emissiveIntensity: 1.45,
      roughness: 0.44,
      metalness: 0,
    }),
    glowAmber: new THREE.MeshStandardMaterial({
      color: new THREE.Color(palette.amber),
      emissive: new THREE.Color(palette.amber),
      emissiveIntensity: 1.15,
      roughness: 0.46,
      metalness: 0,
    }),
  };
}

function createBusinessCluster(materials: ReturnType<typeof createMaterials>) {
  const group = new THREE.Group();

  const cardPositions = [
    new THREE.Vector3(-0.1, 0.72, 0),
    new THREE.Vector3(-0.36, 0.04, 0.04),
    new THREE.Vector3(-0.18, -0.64, -0.02),
  ];

  cardPositions.forEach((position, index) => {
    const card = roundedBox(0.88, 0.56, 0.16, 0.1, materials.body);
    card.position.copy(position);
    group.add(card);

    const icon = new THREE.Group();
    icon.position.set(position.x, position.y, position.z + 0.11);
    group.add(icon);

    if (index === 0) {
      [-0.18, 0, 0.18].forEach((x, barIndex) => {
        const bar = roundedBox(0.08, 0.16 + barIndex * 0.08, 0.035, 0.018, materials.blue);
        bar.position.set(x, -0.05 + barIndex * 0.04, 0);
        icon.add(bar);
      });
    } else if (index === 1) {
      const head = disk(0.11, materials.blue);
      head.position.set(0, 0.09, 0);
      icon.add(head);
      const body = roundedBox(0.34, 0.16, 0.035, 0.06, materials.blue);
      body.position.set(0, -0.11, 0);
      icon.add(body);
    } else {
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 3; col += 1) {
          const cell = roundedBox(0.105, 0.07, 0.032, 0.014, materials.blue);
          cell.position.set(-0.16 + col * 0.16, 0.12 - row * 0.12, 0);
          icon.add(cell);
        }
      }
    }
  });

  const nodeA = sphere(0.08, materials.glowBlue);
  nodeA.position.set(0.68, 0.43, 0.14);
  group.add(nodeA);

  const nodeB = sphere(0.065, materials.glowAmber);
  nodeB.position.set(0.55, -0.28, 0.14);
  group.add(nodeB);

  return group;
}

function createBridgeBody(materials: ReturnType<typeof createMaterials>) {
  const group = new THREE.Group();

  const deck = roundedBox(3.88, 0.34, 0.78, 0.16, materials.body);
  deck.position.set(0, 0.05, 0);
  group.add(deck);

  const lowerDeck = roundedBox(4.24, 0.18, 0.86, 0.12, materials.base);
  lowerDeck.position.set(0, -0.14, -0.02);
  group.add(lowerDeck);

  const leftFoot = roundedBox(0.92, 0.38, 0.86, 0.13, materials.base);
  leftFoot.position.set(-2.08, -0.89, 0);
  group.add(leftFoot);

  const rightFoot = roundedBox(0.92, 0.38, 0.86, 0.13, materials.base);
  rightFoot.position.set(2.08, -0.89, 0);
  group.add(rightFoot);

  const arch = tube(
    [
      [-2.26, -0.78, 0],
      [-1.3, -0.06, 0],
      [0, 0.2, 0],
      [1.3, -0.06, 0],
      [2.26, -0.78, 0],
    ],
    0.22,
    materials.body,
    84,
  );
  group.add(arch.mesh);

  const shadowArch = tube(
    [
      [-1.86, -0.84, -0.04],
      [-0.96, -0.28, -0.04],
      [0, -0.08, -0.04],
      [0.96, -0.28, -0.04],
      [1.86, -0.84, -0.04],
    ],
    0.12,
    materials.border,
    80,
  );
  group.add(shadowArch.mesh);

  const railBack = tube(
    [
      [-2.18, 0.3, -0.28],
      [-1.04, 0.52, -0.28],
      [0, 0.56, -0.28],
      [1.04, 0.52, -0.28],
      [2.18, 0.3, -0.28],
    ],
    0.028,
    materials.line,
    64,
  );
  group.add(railBack.mesh);

  const railFront = tube(
    [
      [-2.2, 0.16, 0.36],
      [-1.08, 0.36, 0.36],
      [0, 0.39, 0.36],
      [1.08, 0.36, 0.36],
      [2.2, 0.16, 0.36],
    ],
    0.032,
    materials.line,
    64,
  );
  group.add(railFront.mesh);

  [-1.82, -1.12, -0.42, 0.42, 1.12, 1.82].forEach((x) => {
    const post = roundedBox(0.12, 0.48, 0.14, 0.035, materials.body);
    post.position.set(x, 0.26 - Math.abs(x) * 0.045, 0.36);
    group.add(post);
  });

  const moduleBay = roundedBox(1.45, 0.42, 0.22, 0.1, materials.dark);
  moduleBay.position.set(0, 0.1, 0.5);
  group.add(moduleBay);

  const leftPort = sphere(0.06, materials.glowBlue);
  leftPort.position.set(-0.88, 0.11, 0.63);
  group.add(leftPort);

  const rightPort = sphere(0.06, materials.glowBlue);
  rightPort.position.set(0.88, 0.11, 0.63);
  group.add(rightPort);

  return group;
}

function createModuleBlocks(materials: ReturnType<typeof createMaterials>): ModuleBlock[] {
  const moduleMaterials = [materials.blue, materials.body, materials.amber];

  return moduleMaterials.map((material, index) => {
    const group = new THREE.Group();
    const cube = roundedBox(0.34, 0.34, 0.34, 0.08, material);
    cube.position.set(0, 0, 0);
    group.add(cube);

    if (index === 0) {
      [-0.06, 0.08].forEach((x) => {
        [-0.06, 0.08].forEach((y) => {
          const dot = roundedBox(0.055, 0.055, 0.026, 0.012, materials.body);
          dot.position.set(x, y, 0.18);
          group.add(dot);
        });
      });
    } else if (index === 1) {
      const ring = disk(0.12, materials.border);
      ring.position.set(0, 0, 0.19);
      group.add(ring);
      const slice = roundedBox(0.12, 0.035, 0.028, 0.012, materials.blue);
      slice.position.set(0.04, 0.03, 0.205);
      slice.rotation.z = -0.65;
      group.add(slice);
    } else {
      const inner = roundedBox(0.16, 0.16, 0.08, 0.025, materials.body);
      inner.position.set(0, 0, 0.18);
      inner.rotation.set(0.3, 0.44, 0.2);
      group.add(inner);
    }

    return {
      group,
      offset: index / moduleMaterials.length,
      spin: index % 2 === 0 ? 1 : -1,
    };
  });
}

function createRobotHead(materials: ReturnType<typeof createMaterials>) {
  const headRoot = new THREE.Group();

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.23, 0.32, 28), materials.darkSoft);
  neck.position.set(0, 0.1, 0);
  neck.castShadow = true;
  headRoot.add(neck);

  const neckBase = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.08, 32), materials.dark);
  neckBase.position.set(0, -0.08, 0);
  neckBase.castShadow = true;
  headRoot.add(neckBase);

  const headPivot = new THREE.Group();
  headPivot.position.set(0, 0.47, 0);
  headRoot.add(headPivot);

  const head = roundedBox(1.36, 0.72, 0.72, 0.18, materials.body);
  headPivot.add(head);

  const face = roundedBox(1.02, 0.43, 0.055, 0.11, materials.dark);
  face.position.set(0, -0.01, 0.38);
  headPivot.add(face);

  const topPanel = roundedBox(0.5, 0.035, 0.25, 0.035, materials.glass);
  topPanel.position.set(0, 0.38, 0.02);
  headPivot.add(topPanel);

  const leftEar = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.11, 28), materials.blue);
  leftEar.rotation.z = Math.PI / 2;
  leftEar.position.set(-0.73, 0.02, 0.02);
  leftEar.castShadow = true;
  headPivot.add(leftEar);

  const rightEar = leftEar.clone();
  rightEar.position.x = 0.73;
  headPivot.add(rightEar);

  const leftEye = createEye(-0.25, materials);
  const rightEye = createEye(0.25, materials);
  headPivot.add(leftEye.group, rightEye.group);

  return {
    headRoot,
    headPivot,
    leftPupil: leftEye.pupil,
    rightPupil: rightEye.pupil,
  };
}

function createEye(x: number, materials: ReturnType<typeof createMaterials>) {
  const group = new THREE.Group();
  group.position.set(x, 0, 0.43);

  const outer = disk(0.18, materials.darkSoft);
  outer.position.z = 0;
  group.add(outer);

  const iris = disk(0.125, materials.amber);
  iris.position.z = 0.012;
  group.add(iris);

  const lens = disk(0.088, materials.body);
  lens.position.z = 0.024;
  group.add(lens);

  const pupil = disk(0.057, materials.dark);
  pupil.position.z = 0.038;
  group.add(pupil);

  const highlight = sphere(0.022, materials.body);
  highlight.position.set(0.04, 0.04, 0.06);
  group.add(highlight);

  return { group, pupil };
}

function createCodexWorkbench(materials: ReturnType<typeof createMaterials>) {
  const group = new THREE.Group();

  const base = roundedBox(1.12, 0.26, 0.78, 0.1, materials.base);
  base.position.set(0, -0.5, 0);
  group.add(base);

  const screen = roundedBox(1.22, 0.92, 0.18, 0.14, materials.body);
  screen.position.set(0, 0.08, 0);
  group.add(screen);

  const display = roundedBox(0.92, 0.62, 0.05, 0.06, materials.dark);
  display.position.set(0, 0.12, 0.12);
  group.add(display);

  const promptDot = sphere(0.04, materials.glowBlue);
  promptDot.position.set(-0.36, 0.19, 0.17);
  group.add(promptDot);

  const chevronLeftTop = rod(new THREE.Vector3(0.08, 0.22, 0.18), new THREE.Vector3(-0.05, 0.08, 0.18), 0.018, materials.glowBlue);
  const chevronLeftBottom = rod(new THREE.Vector3(-0.05, 0.08, 0.18), new THREE.Vector3(0.08, -0.06, 0.18), 0.018, materials.glowBlue);
  const chevronRightTop = rod(new THREE.Vector3(0.24, 0.22, 0.18), new THREE.Vector3(0.37, 0.08, 0.18), 0.018, materials.glowBlue);
  const chevronRightBottom = rod(new THREE.Vector3(0.37, 0.08, 0.18), new THREE.Vector3(0.24, -0.06, 0.18), 0.018, materials.glowBlue);
  group.add(chevronLeftTop, chevronLeftBottom, chevronRightTop, chevronRightBottom);

  [-0.37, -0.28, -0.19].forEach((y, index) => {
    const key = roundedBox(0.18, 0.15, 0.18, 0.04, index === 0 ? materials.blue : index === 1 ? materials.base : materials.amber);
    key.position.set(-0.24 + index * 0.24, y, 0.2);
    group.add(key);
  });

  const status = roundedBox(0.46, 0.06, 0.05, 0.03, materials.glowBlue);
  status.position.set(0, -0.55, 0.42);
  group.add(status);

  return group;
}

function createBusinessFlow(root: THREE.Group, materials: ReturnType<typeof createMaterials>): FlowPulse[] {
  const specs: Array<{
    points: Array<[number, number, number]>;
    mat: THREE.Material;
    pulse: THREE.Material;
    offset: number;
  }> = [
    {
      points: [
        [-3.42, 0.5, 0.12],
        [-2.84, 0.42, 0.22],
        [-2.2, 0.2, 0.3],
        [-1.1, 0.14, 0.56],
      ],
      mat: materials.line,
      pulse: materials.glowBlue,
      offset: 0,
    },
    {
      points: [
        [-3.54, -0.12, 0.12],
        [-2.86, -0.18, 0.26],
        [-2.12, -0.02, 0.34],
        [-1.05, 0.08, 0.58],
      ],
      mat: materials.lineAccent,
      pulse: materials.glowAmber,
      offset: 0.28,
    },
    {
      points: [
        [-3.42, -0.78, 0.12],
        [-2.72, -0.55, 0.28],
        [-2.02, -0.24, 0.36],
        [-1.02, 0.04, 0.56],
      ],
      mat: materials.line,
      pulse: materials.glowBlue,
      offset: 0.56,
    },
  ];

  return specs.map((spec) => {
    const path = tube(spec.points, 0.018, spec.mat, 58);
    root.add(path.mesh);
    const pulse = sphere(0.065, spec.pulse);
    root.add(pulse);
    return { curve: path.curve, pulse, offset: spec.offset, speed: 0.1 };
  });
}

function createCodexFlow(root: THREE.Group, materials: ReturnType<typeof createMaterials>): FlowPulse[] {
  const specs: Array<{
    points: Array<[number, number, number]>;
    mat: THREE.Material;
    pulse: THREE.Material;
    offset: number;
  }> = [
    {
      points: [
        [1.1, 0.14, 0.56],
        [2, 0.12, 0.36],
        [2.76, 0.08, 0.3],
        [3.28, 0.08, 0.18],
      ],
      mat: materials.line,
      pulse: materials.glowBlue,
      offset: 0.18,
    },
    {
      points: [
        [1.08, 0.02, 0.5],
        [2, -0.12, 0.34],
        [2.72, -0.16, 0.26],
        [3.28, -0.2, 0.18],
      ],
      mat: materials.lineAccent,
      pulse: materials.glowAmber,
      offset: 0.44,
    },
    {
      points: [
        [1.12, -0.08, 0.47],
        [2.08, -0.34, 0.28],
        [2.7, -0.36, 0.26],
        [3.3, -0.34, 0.18],
      ],
      mat: materials.line,
      pulse: materials.glowBlue,
      offset: 0.72,
    },
  ];

  return specs.map((spec) => {
    const path = tube(spec.points, 0.018, spec.mat, 58);
    root.add(path.mesh);
    const pulse = sphere(0.058, spec.pulse);
    root.add(pulse);
    return { curve: path.curve, pulse, offset: spec.offset, speed: 0.11 };
  });
}

function updateLayerTargets(refs: SceneRefs, mode: BridgeMascotMode, delta: number) {
  const ease = 1 - Math.exp(-7 * delta);
  const layers = mode === "layers";

  lerpVector(refs.business.position, targetBusiness.clone().add(new THREE.Vector3(layers ? -0.18 : 0, layers ? 0.04 : 0, layers ? -0.42 : 0)), ease);
  lerpVector(refs.bridge.position, targetBridge.clone().add(new THREE.Vector3(0, 0, layers ? 0.16 : 0)), ease);
  lerpVector(refs.codex.position, targetCodex.clone().add(new THREE.Vector3(layers ? 0.2 : 0, layers ? 0.04 : 0, layers ? 0.46 : 0)), ease);
  lerpVector(refs.headRoot.position, baseHeadPosition.clone().add(new THREE.Vector3(0, layers ? 0.38 : 0, layers ? 0.32 : 0)), ease);
}

function updateHead(
  refs: SceneRefs,
  pointer: { x: number; y: number },
  mode: BridgeMascotMode,
  delta: number,
  elapsed: number,
  reduceMotion: boolean,
) {
  const headFocus = mode === "head" ? 1.16 : 1;
  const idle = reduceMotion ? 0 : Math.sin(elapsed * 1.5) * 0.035;
  const yaw = THREE.MathUtils.clamp(pointer.x * 0.43 * headFocus, -0.48, 0.48);
  const pitch = THREE.MathUtils.clamp(-pointer.y * 0.26 * headFocus + idle, -0.24, 0.24);
  const roll = THREE.MathUtils.clamp(-pointer.x * 0.05, -0.05, 0.05);

  refs.headPivot.rotation.y = THREE.MathUtils.damp(refs.headPivot.rotation.y, yaw, 6.5, delta);
  refs.headPivot.rotation.x = THREE.MathUtils.damp(refs.headPivot.rotation.x, pitch, 6.5, delta);
  refs.headPivot.rotation.z = THREE.MathUtils.damp(refs.headPivot.rotation.z, roll, 5.2, delta);

  const pupilX = THREE.MathUtils.clamp(pointer.x * 0.036, -0.04, 0.04);
  const pupilY = THREE.MathUtils.clamp(-pointer.y * 0.026, -0.03, 0.03);
  refs.leftPupil.position.x = THREE.MathUtils.damp(refs.leftPupil.position.x, pupilX, 9, delta);
  refs.rightPupil.position.x = THREE.MathUtils.damp(refs.rightPupil.position.x, pupilX, 9, delta);
  refs.leftPupil.position.y = THREE.MathUtils.damp(refs.leftPupil.position.y, pupilY, 9, delta);
  refs.rightPupil.position.y = THREE.MathUtils.damp(refs.rightPupil.position.y, pupilY, 9, delta);
}

function updateModuleBlocks(refs: SceneRefs, mode: BridgeMascotMode, elapsed: number, reduceMotion: boolean) {
  const speed = mode === "flow" ? 0.19 : 0.11;
  refs.moduleBlocks.forEach((block, index) => {
    const t = reduceMotion ? block.offset : (elapsed * speed + block.offset) % 1;
    const point = refs.moduleCurve.getPoint(t);
    block.group.position.copy(point);
    const scale = mode === "flow" ? 1.06 + Math.sin(elapsed * 3.2 + index) * 0.03 : 1;
    block.group.scale.setScalar(scale);
    if (!reduceMotion) {
      block.group.rotation.y = elapsed * 0.65 * block.spin + index;
      block.group.rotation.x = Math.sin(elapsed * 1.4 + index) * 0.08;
    }
  });
}

function updateFlowPulses(pulses: FlowPulse[], mode: BridgeMascotMode, elapsed: number, reduceMotion: boolean) {
  const flowBoost = mode === "flow" ? 1.65 : 1;
  pulses.forEach((item, index) => {
    const t = reduceMotion ? item.offset : (elapsed * item.speed * flowBoost + item.offset) % 1;
    const point = item.curve.getPoint(t);
    item.pulse.position.copy(point);
    const scale = mode === "flow" ? 1.22 + Math.sin(elapsed * 4 + index) * 0.12 : 1;
    item.pulse.scale.setScalar(scale);
  });
}

function updateCamera(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  mode: BridgeMascotMode,
  delta: number,
) {
  const ease = 1 - Math.exp(-4.8 * delta);
  const narrow = camera.aspect < 1;
  const targetPosition =
    mode === "head"
      ? new THREE.Vector3(0.05, 1.52, narrow ? 4.75 : 4.02)
      : mode === "layers"
        ? new THREE.Vector3(0.18, 2.28, narrow ? 12.85 : 10.75)
        : new THREE.Vector3(0, 2.05, narrow ? 12.15 : 10.35);
  const lookAt =
    mode === "head"
      ? new THREE.Vector3(0, 1.18, 0.18)
      : mode === "layers"
        ? new THREE.Vector3(0, 0.28, 0.14)
        : new THREE.Vector3(0, 0, 0);

  camera.position.lerp(targetPosition, ease);
  target.lerp(lookAt, ease);
  camera.lookAt(target);
}

function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 7, radius), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function disk(radius: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 40), material);
  mesh.castShadow = true;
  return mesh;
}

function sphere(radius: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 18), material);
  mesh.castShadow = true;
  return mesh;
}

function tube(
  points: Array<[number, number, number]>,
  radius: number,
  material: THREE.Material,
  segments = 64,
) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, segments, radius, 12, false), material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { curve, mesh };
}

function rod(from: THREE.Vector3, to: THREE.Vector3, radius: number, material: THREE.Material) {
  const direction = new THREE.Vector3().subVectors(to, from);
  const length = direction.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 12), material);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  mesh.castShadow = true;
  return mesh;
}

function lerpVector(vector: THREE.Vector3, target: THREE.Vector3, alpha: number) {
  vector.x += (target.x - vector.x) * alpha;
  vector.y += (target.y - vector.y) * alpha;
  vector.z += (target.z - vector.z) * alpha;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose());
    } else {
      material?.dispose();
    }
  });
}
