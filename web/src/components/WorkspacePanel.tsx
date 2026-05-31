import { useCallback, useEffect, useState } from 'react';
import { listWorkspace, readWorkspaceFile, revealWorkspace, type WorkspaceFile } from '../api';
import { useSwarm } from '../store';

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}

export function WorkspacePanel() {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const status = useSwarm((s) => s.status);
  const project = useSwarm((s) => s.conversationId);

  const refresh = useCallback(async () => {
    setFiles(await listWorkspace(project));
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-refresh the file list while a run is active.
  useEffect(() => {
    if (status !== 'running') return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [status, refresh]);

  const open = async (path: string) => {
    setSelected(path);
    setContent(await readWorkspaceFile(path, project));
  };

  return (
    <div className="ws">
      <div className="ws__head">
        <span className="ws__title">工作区 · {files.length} 个文件</span>
        <div className="ws__head-actions">
          <button className="ws__refresh" onClick={() => void revealWorkspace(project)} title="在系统文件管理器中打开本项目目录">
            在文件管理器中打开
          </button>
          <button className="ws__refresh" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
      </div>
      <div className="ws__list">
        {files.length === 0 && <div className="ws__empty">智能体还没有创建文件。</div>}
        {files.map((f) => (
          <button key={f.path} className={`ws__item ${selected === f.path ? 'on' : ''}`} onClick={() => void open(f.path)}>
            <span className="ws__name">{f.path}</span>
            <span className="ws__size">{fmtSize(f.size)}</span>
          </button>
        ))}
      </div>
      <div className="ws__viewer">
        {selected ? (
          <>
            <div className="ws__path">
              <span className="ws__path-name">{selected}</span>
              <span className="ws__path-actions">
                <button className="ws__refresh" onClick={() => void revealWorkspace(project, selected)}>
                  打开位置
                </button>
                <button className="ws__refresh" onClick={() => void open(selected)}>
                  重读
                </button>
              </span>
            </div>
            <pre className="ws__content">{content || '（空文件）'}</pre>
          </>
        ) : (
          <div className="ws__empty">点击左侧文件查看内容。</div>
        )}
      </div>
    </div>
  );
}
