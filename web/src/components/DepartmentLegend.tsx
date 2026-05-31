import { useMemo } from 'react';
import { highlightTeam, useSwarm } from '../store';

export function DepartmentLegend() {
  const teams = useSwarm((s) => s.teams);
  const nodes = useSwarm((s) => s.nodes);
  const highlighted = useSwarm((s) => s.highlightedTeamId);

  const list = useMemo(
    () => Object.values(teams).sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)),
    [teams],
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of Object.values(nodes)) {
      if (n.teamId) map.set(n.teamId, (map.get(n.teamId) ?? 0) + 1);
    }
    return map;
  }, [nodes]);

  if (list.length === 0) return null;

  return (
    <div className="legend">
      <div className="legend__title">部门 · {list.length}</div>
      <div className="legend__items">
        {list.map((t) => (
          <button
            key={t.id}
            className={`legend__item ${highlighted === t.id ? 'on' : ''}`}
            onClick={() => highlightTeam(t.id)}
            style={{ paddingLeft: 8 + t.depth * 8 }}
          >
            <span className="legend__dot" style={{ background: t.color }} />
            <span className="legend__name">{t.name}</span>
            <span className="legend__count">{counts.get(t.id) ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
