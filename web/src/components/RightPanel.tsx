import { useState } from 'react';
import { LogRoom } from './LogRoom';
import { WorkspacePanel } from './WorkspacePanel';
import { ToolsPanel } from './ToolsPanel';

export function RightPanel() {
  const [tab, setTab] = useState<'log' | 'tools' | 'workspace'>('log');
  return (
    <div className="rightpanel">
      <div className="tabs">
        <button className={`tab ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>
          活动日志
        </button>
        <button className={`tab ${tab === 'tools' ? 'on' : ''}`} onClick={() => setTab('tools')}>
          工具构成
        </button>
        <button className={`tab ${tab === 'workspace' ? 'on' : ''}`} onClick={() => setTab('workspace')}>
          工作区
        </button>
      </div>
      <div className="rightpanel__body">
        {tab === 'log' ? <LogRoom /> : tab === 'tools' ? <ToolsPanel /> : <WorkspacePanel />}
      </div>
    </div>
  );
}
