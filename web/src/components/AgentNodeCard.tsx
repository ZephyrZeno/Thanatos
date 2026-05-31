import { Handle, Position, type NodeProps } from '@xyflow/react';
import { MODE_CN, STATUS_CN, tierLabel } from '../labels';
import type { AgentNode, NodeStatus } from '../types';

export interface AgentNodeData extends Record<string, unknown> {
  node: AgentNode;
  color: string;
  teamName: string;
  selected?: boolean;
  dimmed?: boolean;
  compact?: boolean;
}

export const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: '#5b6472',
  blocked: '#a07b2d',
  planning: '#3b82f6',
  delegating: '#8b5cf6',
  working: '#22c3a6',
  aggregating: '#e0a32e',
  done: '#33d17a',
  failed: '#ef4444',
};

const ROLE_GLYPH = { central: '★', lead: '◆', worker: '●' } as const;

const handleStyle = {
  left: '50%',
  top: '50%',
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  opacity: 0,
  border: 0,
} as const;

export function AgentNodeCard({ data }: NodeProps) {
  const { node, color, teamName, selected, dimmed, compact } = data as AgentNodeData;
  const statusColor = STATUS_COLOR[node.status];
  const busy = ['planning', 'delegating', 'working', 'aggregating'].includes(node.status);
  const isCentral = node.role === 'central';

  if (compact && !isCentral) {
    return (
      <div
        className={`agent-node agent-node--compact role-${node.role} ${busy ? 'busy' : ''} ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''}`}
        style={{ borderColor: color, boxShadow: selected ? `0 0 0 2px ${color}` : `0 0 0 1px ${color}55` }}
        title={`${node.name} · ${tierLabel(node.depth, node.role)}\n\n${node.mission}`}
      >
        <Handle type="target" position={Position.Top} style={handleStyle} />
        <span className="agent-node__cdot" style={{ background: statusColor }} />
        <span className="agent-node__cname">{node.name}</span>
        <Handle type="source" position={Position.Bottom} style={handleStyle} />
      </div>
    );
  }

  return (
    <div
      className={`agent-node role-${node.role} ${busy ? 'busy' : ''} ${selected ? 'selected' : ''} ${dimmed ? 'dimmed' : ''}`}
      style={{
        borderColor: color,
        boxShadow: selected ? `0 0 0 2px ${color}, 0 8px 24px #000a` : `0 0 0 1px ${color}33, 0 6px 18px #0008`,
      }}
      title={`${node.name}\n\n${node.mission}`}
    >
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <div className="agent-node__head">
        <span className="agent-node__glyph" style={{ color }}>
          {ROLE_GLYPH[node.role]}
        </span>
        <span className="agent-node__name">{node.name}</span>
        <span className="agent-node__status" style={{ background: statusColor }} />
      </div>
      <div className="agent-node__team" style={{ color }}>
        {tierLabel(node.depth, node.role)} · {MODE_CN[node.mode]}
      </div>
      <div className="agent-node__mission">{node.mission}</div>
      <div className="agent-node__foot">
        <span className="agent-node__badge">{STATUS_CN[node.status]}</span>
        <span className="agent-node__metrics">
          {node.retries > 0 ? <span className="agent-node__retry">↻{node.retries}</span> : null}
          {node.reworks > 0 ? <span className="agent-node__retry">⤺{node.reworks}</span> : null}
          {node.tokensUsed > 0 ? ` ${node.tokensUsed}t` : ''}
          {node.toolCalls > 0 ? ` · ${node.toolCalls}🔧` : ''}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
    </div>
  );
}
