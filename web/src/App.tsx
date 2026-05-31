import { useEffect, useState } from 'react';
import { getConfig } from './api';
import { ChatRoom } from './components/ChatRoom';
import { RightPanel } from './components/RightPanel';
import { SwarmGraph } from './components/SwarmGraph';
import { RUN_STATUS_CN } from './labels';
import { useSwarm } from './store';
import type { ServerConfig } from './types';

export function App() {
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const status = useSwarm((s) => s.status);
  const nodes = useSwarm((s) => s.totals.nodes);
  const tokens = useSwarm((s) => s.totals.tokens);
  const tools = useSwarm((s) => s.totals.toolCalls);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">☠</span>
          <span className="brand__name">THANATOS</span>
          <span className="brand__sub">多智能体集群</span>
        </div>
        <div className="chips">
          {config && <span className="chip">{config.model}</span>}
          {config && <span className={`chip chip--mode-${config.mode}`}>{config.mode === 'live' ? '真实' : '模拟'}</span>}
          {config && <span className="chip">上限 {config.maxAgents}</span>}
          <span className="chip chip--metric">{nodes} 智能体</span>
          <span className="chip chip--metric">{tokens.toLocaleString()} 令牌</span>
          <span className="chip chip--metric">{tools} 次工具调用</span>
          <span className={`status status--${status}`}>{RUN_STATUS_CN[status] ?? status}</span>
        </div>
      </header>
      <main className="grid">
        <section className="panel panel--chat">
          <div className="panel__title">中心智能体 · 指挥中心</div>
          <ChatRoom config={config} />
        </section>
        <section className="panel panel--graph">
          <SwarmGraph />
        </section>
        <section className="panel panel--log">
          <RightPanel />
        </section>
      </main>
    </div>
  );
}
