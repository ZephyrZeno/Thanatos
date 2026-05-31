import { useEffect, useRef, useState } from 'react';
import { createRun, deleteConversation, getRun, listConversations, listRuns, type ConversationSummary } from '../api';
import { connectRun, newConversation, replayRun, setConversation, useSwarm } from '../store';
import type { ServerConfig } from '../types';

const STATUS_DOT: Record<string, string> = { running: '#22c3a6', done: '#33d17a', failed: '#ef4444' };

interface Turn {
  runId: string;
  task: string;
  result: string;
  status: 'done' | 'failed';
}

export function ChatRoom(_props: { config: ServerConfig | null }) {
  const [task, setTask] = useState('');
  const [mode, setMode] = useState<'live' | 'mock'>('mock');
  const [maxAgents, setMaxAgents] = useState(40);
  const [forceScale, setForceScale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<Turn[]>([]);
  const conversationId = useSwarm((s) => s.conversationId);
  const [showHistory, setShowHistory] = useState(false);
  const [convos, setConvos] = useState<ConversationSummary[]>([]);

  const runId = useSwarm((s) => s.runId);
  const status = useSwarm((s) => s.status);
  const liveTask = useSwarm((s) => s.task);
  const finalResult = useSwarm((s) => s.finalResult);
  const totalNodes = useSwarm((s) => s.totals.nodes);
  const totalTokens = useSwarm((s) => s.totals.tokens);

  // Default to safe mock mode; the user opts into live explicitly.
  void _props;

  const pushed = useRef<string | null>(null);
  useEffect(() => {
    if ((status === 'done' || status === 'failed') && runId && finalResult && pushed.current !== runId) {
      pushed.current = runId;
      setHistory((h) => [...h, { runId, task: liveTask, result: finalResult, status }]);
    }
  }, [status, runId, finalResult, liveTask]);

  const submit = async () => {
    const text = task.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { runId: id } = await createRun({
        task: text,
        mode,
        maxAgents,
        forceScale,
        conversationId,
      });
      connectRun(id);
      setTask('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => {
    setHistory([]);
    pushed.current = null;
    newConversation();
  };

  const refreshConvos = async () => setConvos(await listConversations());

  const toggleHistory = async () => {
    const next = !showHistory;
    setShowHistory(next);
    if (next) await refreshConvos();
  };

  const openConversation = async (c: ConversationSummary) => {
    setShowHistory(false);
    setConversation(c.conversationId);
    const convRuns = await listRuns(c.conversationId);
    const chrono = [...convRuns].sort((a, b) => a.startedAt - b.startedAt);
    const turns: Turn[] = [];
    for (const r of chrono) {
      const snap = await getRun(r.runId);
      if (snap?.finalResult) {
        turns.push({ runId: r.runId, task: r.task, result: snap.finalResult, status: r.status === 'failed' ? 'failed' : 'done' });
      }
    }
    setHistory(turns);
    const latest = convRuns[0];
    pushed.current = latest ? latest.runId : null;
    if (latest) {
      if (latest.status === 'running') connectRun(latest.runId);
      else void replayRun(latest.runId);
    }
  };

  const removeConversation = async (c: ConversationSummary) => {
    await deleteConversation(c.conversationId);
    if (c.conversationId === conversationId) newChat();
    await refreshConvos();
  };

  const running = status === 'running' && !!runId;

  return (
    <div className="chat">
      <div className="chat__bar">
        <span className="chat__bar-label">记忆开启 · {history.length} 轮</span>
        <div className="chat__bar-actions">
          <button className="chat__new" onClick={toggleHistory}>
            历史对话
          </button>
          <button className="chat__new" onClick={newChat} disabled={running}>
            + 新对话
          </button>
        </div>
        {showHistory && (
          <div className="history-menu">
            {convos.length === 0 && <div className="history-empty">暂无历史对话。</div>}
            {convos.map((c) => (
              <div
                key={c.conversationId}
                className={`history-item ${c.conversationId === conversationId ? 'on' : ''}`}
                onClick={() => void openConversation(c)}
              >
                <span className="history-dot" style={{ background: STATUS_DOT[c.status] ?? '#64748b' }} />
                <span className="history-task">{c.lastTask || '(空对话)'}</span>
                <span className="history-meta">
                  {c.runCount}任务 · {new Date(c.lastStartedAt).toLocaleTimeString(undefined, { hour12: false })}
                </span>
                <button
                  className="history-del"
                  title="删除该对话及其工作区"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeConversation(c);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chat__log">
        {history.length === 0 && !running && (
          <div className="chat__empty">
            给中心智能体一个目标。它会自动设计部门树、分派工作，并汇总成一个答案。
          </div>
        )}
        {history.map((t) => (
          <div key={t.runId} className="chat__turn">
            <div className="bubble bubble--user">{t.task}</div>
            <div className={`bubble bubble--agent ${t.status === 'failed' ? 'bubble--failed' : ''}`}>{t.result}</div>
          </div>
        ))}
        {running && (
          <div className="chat__turn">
            <div className="bubble bubble--user">{liveTask}</div>
            <div className="bubble bubble--agent bubble--thinking">
              <span className="spinner" /> 中心智能体正在编排…… {totalNodes} 个智能体 · {totalTokens} 令牌
            </div>
          </div>
        )}
      </div>

      {error && <div className="chat__error">{error}</div>}

      <div className="chat__compose">
        <textarea
          value={task}
          placeholder="给集群一个目标…（Ctrl/⌘ + Enter 发送）"
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
          }}
          rows={3}
        />
        <div className="chat__controls">
          <label className="ctl">
            模式
            <select value={mode} onChange={(e) => setMode(e.target.value as 'live' | 'mock')}>
              <option value="mock">模拟</option>
              <option value="live">真实</option>
            </select>
          </label>
          <label className="ctl">
            规模(上限)
            <input type="number" min={1} max={2000} value={maxAgents} onChange={(e) => setMaxAgents(Number(e.target.value))} />
          </label>
          <label className="ctl ctl--check" title="强制铺满：均衡地把上限内的智能体都编入组织（中心自动分配层级与小组）">
            强制铺满
            <input type="checkbox" checked={forceScale} onChange={(e) => setForceScale(e.target.checked)} />
          </label>
          <button className="send" onClick={submit} disabled={busy || running || !task.trim()}>
            {running ? '运行中…' : '派发'}
          </button>
        </div>
      </div>
    </div>
  );
}
