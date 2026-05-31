import type { AgentNode } from './types';

export interface Pos {
  x: number;
  y: number;
}

/**
 * Radial swarm layout: the central agent sits at the origin and the org
 * radiates outward. Each subtree gets an angular slice proportional to its
 * leaf count, and rings are spaced EVENLY (sized so the densest ring fits at
 * `arc` spacing) — a balanced disk, not rings with huge gaps. `arc` shrinks
 * when nodes are rendered as compact pills.
 */
export function computeLayout(nodes: AgentNode[], rootId: string | null, arc = 220): Record<string, Pos> {
  const pos: Record<string, Pos> = {};
  if (!rootId) return pos;

  const childrenOf = new Map<string, string[]>();
  const countAtDepth = new Map<number, number>();
  let maxDepth = 0;
  for (const n of nodes) {
    countAtDepth.set(n.depth, (countAtDepth.get(n.depth) ?? 0) + 1);
    maxDepth = Math.max(maxDepth, n.depth);
    if (!n.parentId) continue;
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n.id);
    childrenOf.set(n.parentId, arr);
  }

  const leaves = new Map<string, number>();
  const countLeaves = (id: string): number => {
    const ch = childrenOf.get(id) ?? [];
    if (ch.length === 0) {
      leaves.set(id, 1);
      return 1;
    }
    let sum = 0;
    for (const c of ch) sum += countLeaves(c);
    const total = Math.max(1, sum);
    leaves.set(id, total);
    return total;
  };
  countLeaves(rootId);

  // Even ring spacing, sized so the densest ring has enough circumference.
  let maxNeed = 0;
  for (const [d, c] of countAtDepth) {
    if (d === 0) continue;
    maxNeed = Math.max(maxNeed, (c * arc) / (2 * Math.PI));
  }
  const ring = Math.max(200, maxDepth > 0 ? maxNeed / maxDepth : 200);

  const place = (id: string, a0: number, a1: number, depth: number): void => {
    const mid = (a0 + a1) / 2;
    const r = depth * ring;
    pos[id] = depth === 0 ? { x: 0, y: 0 } : { x: Math.cos(mid) * r, y: Math.sin(mid) * r };
    const ch = childrenOf.get(id) ?? [];
    if (ch.length === 0) return;
    const total = ch.reduce((s, c) => s + (leaves.get(c) ?? 1), 0);
    let a = a0;
    for (const c of ch) {
      const frac = (leaves.get(c) ?? 1) / total;
      const b = a + frac * (a1 - a0);
      place(c, a, b, depth + 1);
      a = b;
    }
  };
  place(rootId, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2, 0);
  return pos;
}
