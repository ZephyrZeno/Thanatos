import { useEffect, useMemo, useRef, useState } from 'react';
import { useSwarm } from '../store';

const LEVEL_COLOR: Record<string, string> = {
  debug: '#64748b',
  info: '#9fb3c8',
  warn: '#e0a32e',
  error: '#ef4444',
};

function timeStr(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function LogRoom() {
  const logs = useSwarm((s) => s.logs);
  const teams = useSwarm((s) => s.teams);
  const [scope, setScope] = useState('all');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const l of logs) set.add(l.scope);
    return ['all', ...[...set].sort()];
  }, [logs]);

  const scopeLabel = (s: string) => (s === 'all' ? '全部' : s);

  const colorForScope = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of Object.values(teams)) map.set(t.name, t.color);
    return map;
  }, [teams]);

  const filtered = useMemo(() => (scope === 'all' ? logs : logs.filter((l) => l.scope === scope)), [logs, scope]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [filtered.length]);

  return (
    <div className="logroom">
      <div className="logroom__head">
        <span className="logroom__filterlabel">范围</span>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          {scopes.map((s) => (
            <option key={s} value={s}>
              {scopeLabel(s)}
            </option>
          ))}
        </select>
      </div>
      <div className="logroom__body">
        {filtered.length === 0 && <div className="logroom__empty">暂无活动。</div>}
        {filtered.map((l) => (
          <div key={l.seq} className="logline">
            <span className="logline__time">{timeStr(l.ts)}</span>
            <span
              className="logline__scope"
              style={{ color: colorForScope.get(l.scope) ?? '#7c8aa0', borderColor: (colorForScope.get(l.scope) ?? '#7c8aa0') + '55' }}
            >
              {l.scope}
            </span>
            <span className="logline__msg" style={{ color: LEVEL_COLOR[l.level] ?? '#c9d4e3' }}>
              {l.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
