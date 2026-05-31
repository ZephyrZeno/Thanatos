import { useMemo } from 'react';
import { useSwarm } from '../store';

/** Group raw tool names into human-readable activity categories. */
function categorize(tool: string): string {
  if (/^workspace_write_file$|^workspace_edit_file$|^write_file$/.test(tool)) return '改代码';
  if (/^workspace_read_file$|^workspace_list$|^read_file$/.test(tool)) return '读取';
  if (/^run_command$/.test(tool)) return '构建/命令';
  if (/^detect_environment$/.test(tool)) return '环境';
  if (/^run_python$/.test(tool)) return '计算';
  if (/web_search|http_fetch|fetch|search|browse/i.test(tool)) return '搜索/网络';
  return '其他';
}

const CAT_COLOR: Record<string, string> = {
  '改代码': '#34d399',
  '读取': '#60a5fa',
  '构建/命令': '#f59e0b',
  '环境': '#a78bfa',
  '计算': '#22d3ee',
  '搜索/网络': '#f472b6',
  '其他': '#94a3b8',
};

export function ToolsPanel() {
  const tools = useSwarm((s) => s.tools);

  const { cats, byTool, total, fails } = useMemo(() => {
    const cats = new Map<string, number>();
    const byTool = new Map<string, { total: number; fail: number }>();
    let fails = 0;
    for (const t of tools) {
      const c = categorize(t.tool);
      cats.set(c, (cats.get(c) ?? 0) + 1);
      const e = byTool.get(t.tool) ?? { total: 0, fail: 0 };
      e.total++;
      if (!t.ok) {
        e.fail++;
        fails++;
      }
      byTool.set(t.tool, e);
    }
    return {
      cats: [...cats.entries()].sort((a, b) => b[1] - a[1]),
      byTool: [...byTool.entries()].sort((a, b) => b[1].total - a[1].total),
      total: tools.length,
      fails,
    };
  }, [tools]);

  return (
    <div className="toolspanel">
      <div className="toolspanel__head">
        工具调用构成 · 共 {total} 次{fails > 0 ? ` · ${fails} 失败` : ''}
      </div>
      <div className="toolspanel__body">
        {total === 0 && <div className="logroom__empty">暂无工具调用。运行任务后在此查看“在写代码还是在读”。</div>}

        {total > 0 && (
          <>
            <div className="toolspanel__bar">
              {cats.map(([name, n]) => (
                <div
                  key={name}
                  className="toolspanel__seg"
                  title={`${name} ${n}`}
                  style={{ width: `${(n / total) * 100}%`, background: CAT_COLOR[name] ?? '#94a3b8' }}
                />
              ))}
            </div>
            <div className="toolspanel__cats">
              {cats.map(([name, n]) => (
                <span key={name} className="toolcat">
                  <i style={{ background: CAT_COLOR[name] ?? '#94a3b8' }} />
                  {name} {n} ({Math.round((n / total) * 100)}%)
                </span>
              ))}
            </div>

            <div className="toolspanel__list">
              {byTool.map(([name, s]) => (
                <div key={name} className="toolstat">
                  <span className="toolstat__name">{name}</span>
                  <span className="toolstat__count">
                    {s.total}
                    {s.fail > 0 ? <span className="toolstat__fail"> · {s.fail} 失败</span> : null}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
