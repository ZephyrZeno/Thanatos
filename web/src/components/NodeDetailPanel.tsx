import { MODE_CN, STATUS_CN, tierLabel } from '../labels';
import { selectNode, useSwarm } from '../store';
import { STATUS_COLOR } from './AgentNodeCard';

function Row({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <div className="detail__row">
      <span className="detail__k">{k}</span>
      <span className="detail__v" style={color ? { color } : undefined}>
        {v}
      </span>
    </div>
  );
}

function Chips({ ids, names }: { ids: string[]; names: Map<string, string> }) {
  if (ids.length === 0) return <div className="trace__empty">—</div>;
  return (
    <div className="trace__chips">
      {ids.map((id) => (
        <button key={id} className="trace__chip" onClick={() => selectNode(id)} title="点击追溯">
          {names.get(id) ?? id}
        </button>
      ))}
    </div>
  );
}

export function NodeDetailPanel() {
  const id = useSwarm((s) => s.selectedNodeId);
  const nodes = useSwarm((s) => s.nodes);
  const teams = useSwarm((s) => s.teams);

  if (!id) return null;
  const node = nodes[id];
  if (!node) return null;

  const team = node.teamId ? teams[node.teamId] : undefined;
  const names = new Map(Object.values(nodes).map((n) => [n.id, n.name] as const));

  // Traceability: ancestry path, sub-parts, and collaborators (deps + dependents).
  const ancestors: string[] = [];
  const guard = new Set<string>();
  let p = node.parentId;
  while (p && nodes[p] && !guard.has(p)) {
    guard.add(p);
    ancestors.unshift(p);
    p = nodes[p]?.parentId ?? null;
  }
  const children = node.childrenIds.filter((id) => nodes[id]);
  const deps = node.dependsOn.filter((id) => nodes[id]);
  const dependents = Object.values(nodes)
    .filter((n) => n.dependsOn.includes(node.id))
    .map((n) => n.id);

  return (
    <div className="detail">
      <div className="detail__head">
        <span className="detail__name">{node.name}</span>
        <button className="detail__close" onClick={() => selectNode(null)} aria-label="close">
          ×
        </button>
      </div>
      <div className="detail__body">
        <Row k="层级" v={tierLabel(node.depth, node.role)} />
        <Row k="状态" v={STATUS_CN[node.status]} color={STATUS_COLOR[node.status]} />
        <Row k="部门" v={team?.name ?? '—'} color={team?.color} />
        <Row k="模式" v={MODE_CN[node.mode]} />
        <Row k="深度" v={String(node.depth)} />
        <Row k="令牌" v={node.tokensUsed.toLocaleString()} />
        <Row k="工具调用" v={String(node.toolCalls)} />
        {node.retries > 0 && <Row k="重试" v={String(node.retries)} color="#e0a32e" />}
        {node.reworks > 0 && <Row k="打回重做" v={String(node.reworks)} color="#e0a32e" />}

        <div className="detail__section">追溯 · 上级链路</div>
        <Chips ids={ancestors} names={names} />
        <div className="detail__section">下属 · 子部分（谁完成的）</div>
        <Chips ids={children} names={names} />
        <div className="detail__section">协作 · 依赖（需先完成）</div>
        <Chips ids={deps} names={names} />
        <div className="detail__section">协作 · 被依赖（下游）</div>
        <Chips ids={dependents} names={names} />

        <div className="detail__section">任务</div>
        <div className="detail__text">{node.mission}</div>

        {node.error && (
          <>
            <div className="detail__section detail__section--err">错误</div>
            <div className="detail__text">{node.error}</div>
          </>
        )}
        {node.result && (
          <>
            <div className="detail__section">结果</div>
            <div className="detail__text">{node.result}</div>
          </>
        )}
      </div>
    </div>
  );
}
