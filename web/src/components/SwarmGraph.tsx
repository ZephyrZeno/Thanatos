import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge,
  MarkerType,
  type Node,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { computeLayout } from '../layout';
import { selectNode, useSwarm } from '../store';
import type { AgentNode } from '../types';
import { AgentNodeCard, type AgentNodeData } from './AgentNodeCard';
import { BrainGraph3D } from './BrainGraph3D';
import { DepartmentLegend } from './DepartmentLegend';
import { FlowEdge, type FlowEdgeData } from './FlowEdge';
import { NodeDetailPanel } from './NodeDetailPanel';

const nodeTypes = { agent: AgentNodeCard };
const edgeTypes = { flow: FlowEdge };
function GraphInner() {
  const nodes = useSwarm((s) => s.nodes);
  const order = useSwarm((s) => s.order);
  const teams = useSwarm((s) => s.teams);
  const flows = useSwarm((s) => s.flows);
  const collaborations = useSwarm((s) => s.collaborations);
  const selectedNodeId = useSwarm((s) => s.selectedNodeId);
  const highlightedTeamId = useSwarm((s) => s.highlightedTeamId);
  const rootId = useSwarm((s) => s.order.find((id) => s.nodes[id]?.role === 'central') ?? null);
  const rf = useReactFlow();
  const [viewMode, setViewMode] = useState<'2d' | '3d'>('2d');

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const nodeList = useMemo(
    () => order.map((id) => nodes[id]).filter((n): n is AgentNode => Boolean(n)),
    [order, nodes],
  );

  const compact = false;
  const structSig = useMemo(() => nodeList.map((n) => `${n.id}:${n.parentId ?? ''}`).join('|'), [nodeList]);
  const positions = useMemo(() => computeLayout(nodeList, rootId, 240), [structSig, rootId]);

  useEffect(() => {
    if (viewMode !== '2d') return;
    const t = setTimeout(() => rf.fitView({ padding: 0.25, duration: 450 }), 140);
    return () => clearTimeout(t);
  }, [structSig, rf, viewMode]);

  const activeEdges = useMemo(() => {
    const set = new Set<string>();
    for (const f of flows) if (now - f.ts < 1800) set.add(`${f.from}->${f.to}`);
    return set;
  }, [flows, now]);

  const activeCollabIds = useMemo(() => {
    const set = new Set<string>();
    for (const f of flows) if (f.kind === 'collaboration' && now - f.ts < 3000) set.add(`${f.from}->${f.to}`);
    return set;
  }, [flows, now]);

  const rfNodes: Node[] = useMemo(
    () =>
      nodeList.map((n) => {
        const team = n.teamId ? teams[n.teamId] : undefined;
        const color = n.role === 'central' ? '#e7e9f3' : team?.color ?? '#64748b';
        const pos = positions[n.id] ?? { x: 0, y: 0 };
        const dimmed = highlightedTeamId != null && n.teamId !== highlightedTeamId;
        const isSel = n.id === selectedNodeId;
        const data: AgentNodeData = {
          node: n,
          color,
          teamName: team?.name ?? '-',
          selected: isSel,
          dimmed,
          compact,
        };
        return { id: n.id, type: 'agent', position: pos, data, draggable: false, zIndex: isSel ? 1000 : 0 };
      }),
    [nodeList, teams, positions, selectedNodeId, highlightedTeamId, compact],
  );

  const rfEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
    const dimmedEdge = (a: string, b: string): boolean => {
      if (highlightedTeamId == null) return false;
      return nodes[a]?.teamId !== highlightedTeamId && nodes[b]?.teamId !== highlightedTeamId;
    };
    for (const n of nodeList) {
      if (n.parentId && nodes[n.parentId]) {
        const color = (n.teamId && teams[n.teamId]?.color) || '#64748b';
        const active =
          activeEdges.has(`${n.parentId}->${n.id}`) ||
          activeEdges.has(`${n.id}->${n.parentId}`) ||
          n.status === 'working';
        const data: FlowEdgeData = { color, active, kind: 'structural', dimmed: dimmedEdge(n.parentId, n.id) };
        edges.push({ id: `e:${n.parentId}->${n.id}`, source: n.parentId, target: n.id, type: 'flow', data });
      }
      for (const dep of n.dependsOn) {
        if (!nodes[dep]) continue;
        const data: FlowEdgeData = {
          color: '#f59e0b',
          active: activeEdges.has(`${dep}->${n.id}`),
          kind: 'dep',
          dimmed: dimmedEdge(dep, n.id),
        };
        edges.push({
          id: `d:${dep}->${n.id}`,
          source: dep,
          target: n.id,
          type: 'flow',
          data,
          markerEnd: { type: MarkerType.ArrowClosed, color: '#f59e0b' },
        });
      }
    }
    for (const link of Object.values(collaborations)) {
      if (!nodes[link.from] || !nodes[link.to]) continue;
      const pulse = activeCollabIds.has(`${link.from}->${link.to}`) || activeCollabIds.has(`${link.to}->${link.from}`);
      // Animate the moving dot only on a real collaboration event, not constantly while open.
      const data: FlowEdgeData = {
        color: '#22c3a6',
        active: pulse,
        kind: link.endedAt && !pulse ? 'collabPast' : 'collab',
        dimmed: dimmedEdge(link.from, link.to),
      };
      edges.push({ id: `c:${link.id}`, source: link.from, target: link.to, type: 'flow', data });
    }
    return edges;
  }, [nodeList, nodes, teams, activeEdges, activeCollabIds, highlightedTeamId, collaborations]);

  return (
    <div className="graph-wrap">
      <div className="view-toggle" role="group" aria-label="Graph view mode">
        <button className={viewMode === '2d' ? 'on' : ''} onClick={() => setViewMode('2d')}>
          2D
        </button>
        <button className={viewMode === '3d' ? 'on' : ''} onClick={() => setViewMode('3d')}>
          3D
        </button>
      </div>
      {viewMode === '2d' ? (
        <>
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.04}
            maxZoom={2.2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            proOptions={{ hideAttribution: true }}
            zoomOnScroll
            panOnScroll={false}
            zoomOnPinch
            panOnDrag
            onNodeClick={(_, node) => selectNode(node.id)}
            onPaneClick={() => selectNode(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={26} size={1} color="#222b3d" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </>
      ) : (
        <BrainGraph3D
          nodes={nodeList}
          teams={teams}
          collaborations={Object.values(collaborations)}
          flows={flows}
          selectedNodeId={selectedNodeId}
        />
      )}
      <DepartmentLegend />
      <NodeDetailPanel />
      <div className="edge-legend">
        <div className="edge-legend__title">连线说明</div>
        <div className="edge-legend__row">
          <span className="edge-legend__line solid" />
          隶属 · 上级派发（颜色=部门）
        </div>
        <div className="edge-legend__row">
          <span className="edge-legend__line dashed" />
          依赖 · 需等对方先完成
        </div>
        <div className="edge-legend__row">
          <span className="edge-legend__line collab" />
          协作 · 跨部门合作
        </div>
        <div className="edge-legend__row">
          <span className="edge-legend__dot" />
          移动圆点 · 实时数据流
        </div>
      </div>
    </div>
  );
}

export function SwarmGraph() {
  return (
    <ReactFlowProvider>
      <GraphInner />
    </ReactFlowProvider>
  );
}
