import { useState } from 'react';
import { LogRoom } from './LogRoom';
import { WorkspacePanel } from './WorkspacePanel';

export function RightPanel() {
  const [tab, setTab] = useState<'log' | 'workspace'>('log');
  return (
    <div className="rightpanel">
      <div className="tabs">
        <button className={`tab ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>
          活动日志
        </button>
        <button className={`tab ${tab === 'workspace' ? 'on' : ''}`} onClick={() => setTab('workspace')}>
          工作区
        </button>
      </div>
      <div className="rightpanel__body">{tab === 'log' ? <LogRoom /> : <WorkspacePanel />}</div>
    </div>
  );
}
