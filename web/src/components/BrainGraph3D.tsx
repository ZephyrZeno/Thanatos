import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { selectNode, useSwarm, type FlowPulse } from '../store';
import { tierLabel } from '../labels';
import type { AgentNode, CollaborationLink, Team } from '../types';

interface Props {
  nodes: AgentNode[];
  teams: Record<string, Team>;
  collaborations: CollaborationLink[];
  flows: FlowPulse[];
  selectedNodeId: string | null;
}

function hash(s: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const unit = (s: string, salt: number) => (hash(s, salt) % 100000) / 100000;

/** Spherical layout: central at the core, nodes fill a ball (deeper = outer). */
function brainPositions(nodes: AgentNode[]): Map<string, THREE.Vector3> {
  const pos = new Map<string, THREE.Vector3>();
  if (nodes.length === 0) return pos;
  const maxDepth = Math.max(1, ...nodes.map((n) => n.depth));
  const R = 160;
  for (const n of nodes) {
    if (n.role === 'central' || n.depth === 0) {
      pos.set(n.id, new THREE.Vector3(0, 0, 0));
      continue;
    }
    const theta = unit(n.id, 1) * Math.PI * 2;
    const phi = Math.acos(2 * unit(n.id, 2) - 1); // uniform over the sphere
    const r = R * (0.2 + 0.8 * (n.depth / maxDepth)) + (unit(n.id, 3) - 0.5) * 12;
    pos.set(
      n.id,
      new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)),
    );
  }
  return pos;
}

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 30px "Segoe UI", system-ui, sans-serif';
  ctx.fillStyle = 'rgba(8,12,20,0.72)';
  const w = ctx.measureText(text).width + 24;
  ctx.fillRect((256 - w) / 2, 8, w, 44);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(46, 11.5, 1);
  return sprite;
}

export function BrainGraph3D({ nodes, teams, collaborations, flows, selectedNodeId }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const graphRef = useRef<THREE.Group | null>(null);
  const meshesRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const collabRef = useRef<Map<string, THREE.Line>>(new Map());
  const hoverLabelRef = useRef<THREE.Sprite | null>(null);
  const raycaster = useRef(new THREE.Raycaster());

  const highlightedTeamId = useSwarm((s) => s.highlightedTeamId);

  // Live data the animation loop reads without triggering a rebuild.
  const data = useRef({ byId: new Map<string, AgentNode>(), flows, selectedNodeId, highlightedTeamId });
  data.current = { byId: new Map(nodes.map((n) => [n.id, n] as const)), flows, selectedNodeId, highlightedTeamId };

  const structSig = useMemo(() => nodes.map((n) => `${n.id}:${n.parentId ?? ''}`).join('|'), [nodes]);
  const positions = useMemo(() => brainPositions(nodes), [structSig]);
  const colorOf = (n: AgentNode): string =>
    n.role === 'central' ? '#e7e9f3' : (n.teamId && teams[n.teamId]?.color) || '#7c8aa0';

  // --- one-time scene setup + render loop ---
  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#070b12');
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
    camera.position.set(0, 30, 360);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = 0.7;
    controls.autoRotate = false; // no constant loop — user rotates manually
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight('#ffffff', 0.85));
    const key = new THREE.PointLight('#9fd0ff', 1.1, 1600);
    key.position.set(160, 240, 320);
    scene.add(key);
    const rim = new THREE.PointLight('#7c5cff', 0.6, 1600);
    rim.position.set(-220, -120, -200);
    scene.add(rim);

    // No hull mesh — the brain shape emerges from the node points + edges only.
    const graph = new THREE.Group();
    scene.add(graph);
    graphRef.current = graph;

    const hoverLabel = makeLabelSprite('', '#ffffff');
    hoverLabel.visible = false;
    scene.add(hoverLabel);
    hoverLabelRef.current = hoverLabel;

    const resize = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    const ndc = new THREE.Vector2();
    const pickAt = (clientX: number, clientY: number): { id: string; mesh: THREE.Mesh } | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.current.setFromCamera(ndc, camera);
      const hits = raycaster.current.intersectObjects([...meshesRef.current.values()], false);
      const hit = hits[0]?.object as THREE.Mesh | undefined;
      if (!hit) return null;
      const id = (hit.userData as { id?: string }).id;
      return id ? { id, mesh: hit } : null;
    };

    let downX = 0;
    let downY = 0;
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // was a drag
      const hit = pickAt(e.clientX, e.clientY);
      selectNode(hit ? hit.id : null);
    };
    const onMove = (e: PointerEvent) => {
      const hit = pickAt(e.clientX, e.clientY);
      const label = hoverLabelRef.current;
      const node = hit ? data.current.byId.get(hit.id) : undefined;
      if (hit && node && label) {
        label.visible = true;
        const sp = makeLabelSprite(`${node.name} · ${tierLabel(node.depth, node.role)}`, '#e7e9f3');
        label.material.map?.dispose();
        label.material.map = sp.material.map;
        label.material.needsUpdate = true;
        sp.material.dispose();
        label.position.copy(hit.mesh.position).add(new THREE.Vector3(0, 10, 0));
        renderer.domElement.style.cursor = 'pointer';
      } else if (label) {
        label.visible = false;
        renderer.domElement.style.cursor = 'grab';
      }
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);

    let raf = 0;
    const animate = () => {
      const now = Date.now();
      // live status glow + selection highlight
      for (const [id, mesh] of meshesRef.current) {
        const node = data.current.byId.get(id);
        if (!node) continue;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const busy = node.status === 'working';
        const sel = id === data.current.selectedNodeId;
        const dim = data.current.highlightedTeamId != null && node.teamId !== data.current.highlightedTeamId;
        const pulse = busy ? 0.45 + 0.3 * Math.sin(now / 240 + (mesh.position.x + mesh.position.y)) : node.status === 'done' ? 0.3 : 0.16;
        mat.emissiveIntensity = dim ? 0.04 : sel ? 0.95 : pulse;
        mat.opacity = dim ? 0.12 : 1;
        const targetScale = (mesh.userData as { base: number }).base * (sel ? 1.6 : 1);
        mesh.scale.setScalar(targetScale);
        if (node.status === 'failed') mat.emissive.set('#ef4444');
      }
      // collab pulse
      for (const [key2, line] of collabRef.current) {
        const m = line.material as THREE.LineBasicMaterial;
        const active = data.current.flows.some(
          (f) => f.kind === 'collaboration' && now - f.ts < 3000 && (`${f.from}->${f.to}` === key2 || `${f.to}->${f.from}` === key2),
        );
        m.opacity = active ? 0.85 : (line.userData as { past?: boolean }).past ? 0.16 : 0.4;
      }
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      controls.dispose();
      renderer.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
        else (m.material as THREE.Material | undefined)?.dispose?.();
        m.geometry?.dispose?.();
      });
      el.replaceChildren();
      sceneRef.current = null;
    };
  }, []);

  // --- rebuild the graph (nodes + edges + labels) when structure/teams change ---
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    // clear
    for (const child of [...graph.children]) {
      graph.remove(child);
      const m = child as THREE.Mesh;
      if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
      else (m.material as THREE.Material | undefined)?.dispose?.();
      m.geometry?.dispose?.();
    }
    meshesRef.current.clear();
    collabRef.current.clear();

    const sphere = new THREE.SphereGeometry(1, 16, 16);
    const lineMatStruct = (color: string, opacity: number) =>
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });

    // edges: parent→child (team color), deps (amber)
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      if (n.parentId) {
        const pp = positions.get(n.parentId);
        if (pp) {
          const g = new THREE.BufferGeometry().setFromPoints([pp, p]);
          graph.add(new THREE.Line(g, lineMatStruct(colorOf(n), 0.22)));
        }
      }
      for (const dep of n.dependsOn) {
        const dp = positions.get(dep);
        if (dp) {
          const g = new THREE.BufferGeometry().setFromPoints([dp, p]);
          graph.add(new THREE.Line(g, lineMatStruct('#f59e0b', 0.3)));
        }
      }
    }

    // collaboration edges (kept in a ref so the loop can pulse them)
    for (const link of collaborations) {
      const a = positions.get(link.from);
      const b = positions.get(link.to);
      if (!a || !b) continue;
      const g = new THREE.BufferGeometry().setFromPoints([a, b]);
      const line = new THREE.Line(g, lineMatStruct('#22c3a6', link.endedAt ? 0.16 : 0.5));
      line.userData = { past: Boolean(link.endedAt) };
      collabRef.current.set(`${link.from}->${link.to}`, line);
      graph.add(line);
    }

    // node spheres + labels for central/departments
    for (const n of nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const color = colorOf(n);
      const base = n.role === 'central' ? 6.5 : n.role === 'lead' ? 3.8 : 2.6;
      const mat = new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.2,
        roughness: 0.4,
        metalness: 0.1,
        transparent: true,
      });
      const mesh = new THREE.Mesh(sphere, mat);
      mesh.position.copy(p);
      mesh.scale.setScalar(base);
      mesh.userData = { id: n.id, base };
      graph.add(mesh);
      meshesRef.current.set(n.id, mesh);

      if (n.depth <= 1) {
        const label = makeLabelSprite(n.name, color);
        label.position.copy(p).add(new THREE.Vector3(0, n.role === 'central' ? 14 : 9, 0));
        label.scale.multiplyScalar(n.role === 'central' ? 1.15 : 0.85);
        graph.add(label);
      }
    }
  }, [structSig, positions, teams, collaborations, nodes]);

  return (
    <div className="brain3d" ref={host}>
      {nodes.length === 0 && <div className="brain3d__empty">暂无智能体。运行一次任务后在此查看 3D 球形视图。</div>}
    </div>
  );
}
