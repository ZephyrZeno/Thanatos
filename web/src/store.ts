import { useRef, useSyncExternalStore } from 'react';
import { wsUrl } from './api';
import type { AgentNode, CollaborationLink, FlowKind, LogLevel, Team, ThanatosEvent, Totals } from './types';

export interface LogLine {
  seq: number;
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  nodeId?: string;
}

export interface ToolLine {
  seq: number;
  ts: number;
  nodeId: string;
  tool: string;
  ok: boolean;
  preview: string;
  args: string;
}

export interface FlowPulse {
  id: string;
  from: string;
  to: string;
  kind: FlowKind;
  ts: number;
}

export type RunStatus = 'idle' | 'running' | 'done' | 'failed';

export interface SwarmState {
  runId: string | null;
  status: RunStatus;
  task: string;
  nodes: Record<string, AgentNode>;
  teams: Record<string, Team>;
  collaborations: Record<string, CollaborationLink>;
  order: string[];
  logs: LogLine[];
  tools: ToolLine[];
  flows: FlowPulse[];
  finalResult?: string;
  totals: Totals;
  /** UI: node whose detail panel is open. */
  selectedNodeId: string | null;
  /** UI: department to spotlight (others dim). */
  highlightedTeamId: string | null;
  /** Conversation/project id — groups runs + isolates the workspace. */
  conversationId: string;
}

function newConversationId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? `c_${crypto.randomUUID().slice(0, 8)}`
    : `c_${Math.random().toString(36).slice(2, 10)}`;
}

function initial(): SwarmState {
  return {
    runId: null,
    status: 'idle',
    task: '',
    nodes: {},
    teams: {},
    collaborations: {},
    order: [],
    logs: [],
    tools: [],
    flows: [],
    totals: { nodes: 0, tokens: 0, toolCalls: 0 },
    selectedNodeId: null,
    highlightedTeamId: null,
    conversationId: newConversationId(),
  };
}

let state: SwarmState = initial();
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;

function emit(): void {
  for (const l of listeners) l();
}
function set(next: SwarmState): void {
  state = next;
  emit();
}

export function getState(): SwarmState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSwarm<T>(selector: (s: SwarmState) => T, isEqual?: (a: T, b: T) => boolean): T {
  const cache = useRef<{ value: T } | null>(null);
  const getSnapshot = (): T => {
    const next = selector(state);
    if (cache.current && (isEqual ? isEqual(cache.current.value, next) : Object.is(cache.current.value, next))) {
      return cache.current.value;
    }
    cache.current = { value: next };
    return next;
  };
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function applyEvent(e: ThanatosEvent): void {
  switch (e.type) {
    case 'run:started':
      set({ ...initial(), conversationId: state.conversationId, runId: e.runId, status: 'running', task: e.task });
      break;
    case 'node:created': {
      const order = state.order.includes(e.node.id) ? state.order : [...state.order, e.node.id];
      set({
        ...state,
        nodes: { ...state.nodes, [e.node.id]: e.node },
        order,
        totals: { ...state.totals, nodes: order.length },
      });
      break;
    }
    case 'node:updated': {
      const cur = state.nodes[e.nodeId];
      if (!cur) break;
      const merged = { ...cur, ...e.patch };
      const nodes = { ...state.nodes, [e.nodeId]: merged };
      const tokens = Object.values(nodes).reduce((a, n) => a + (n.tokensUsed ?? 0), 0);
      const toolCalls = Object.values(nodes).reduce((a, n) => a + (n.toolCalls ?? 0), 0);
      set({ ...state, nodes, totals: { ...state.totals, tokens, toolCalls } });
      break;
    }
    case 'team:created':
      set({ ...state, teams: { ...state.teams, [e.team.id]: e.team } });
      break;
    case 'edge:flow': {
      const pulse: FlowPulse = { id: `${e.from}->${e.to}:${e.seq}`, from: e.from, to: e.to, kind: e.kind, ts: Date.now() };
      set({ ...state, flows: [...state.flows, pulse].slice(-300) });
      break;
    }
    case 'collaboration:started':
      set({ ...state, collaborations: { ...state.collaborations, [e.link.id]: e.link } });
      break;
    case 'collaboration:ended': {
      const cur = state.collaborations[e.linkId];
      if (!cur) break;
      set({ ...state, collaborations: { ...state.collaborations, [e.linkId]: { ...cur, endedAt: e.endedAt } } });
      break;
    }
    case 'log':
      set({
        ...state,
        logs: [...state.logs, { seq: e.seq, ts: e.ts, level: e.level, scope: e.scope, message: e.message, nodeId: e.nodeId }].slice(-800),
      });
      break;
    case 'tool:call': {
      const tool: ToolLine = { seq: e.seq, ts: e.ts, nodeId: e.nodeId, tool: e.tool, ok: e.ok, preview: e.preview, args: e.args };
      // Keep tool calls in the tools list (for counts), but DON'T spam the
      // activity log with every call — only surface failures there.
      const tools = [...state.tools, tool].slice(-400);
      if (e.ok) {
        set({ ...state, tools });
      } else {
        const log: LogLine = {
          seq: e.seq,
          ts: e.ts,
          level: 'warn',
          scope: '工具',
          nodeId: e.nodeId,
          message: `${e.tool} 失败：${e.preview}`,
        };
        set({ ...state, tools, logs: [...state.logs, log].slice(-800) });
      }
      break;
    }
    case 'run:finished':
      set({ ...state, status: e.status, finalResult: e.finalResult, totals: e.totals });
      break;
    default:
      break;
  }
}

interface WsMessage {
  type?: string;
  events?: ThanatosEvent[];
}

/** Connect (or reconnect) to a run's live event stream. */
export function connectRun(runId: string): void {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  set({ ...initial(), conversationId: state.conversationId, runId, status: 'running' });

  const ws = new WebSocket(wsUrl(runId));
  socket = ws;
  ws.onmessage = (ev) => {
    let data: ThanatosEvent | WsMessage;
    try {
      data = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if ((data as WsMessage).type === 'history' && Array.isArray((data as WsMessage).events)) {
      for (const inner of (data as WsMessage).events ?? []) applyEvent(inner);
      return;
    }
    if ((data as WsMessage).type === 'error') return;
    applyEvent(data as ThanatosEvent);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
  };
}

export function resetSwarm(): void {
  set({ ...initial(), conversationId: state.conversationId });
}

/** Start a brand-new conversation/project (fresh memory + isolated workspace). */
export function newConversation(): void {
  set(initial());
}

/** Switch to an existing conversation id (clears the live graph; caller replays a run). */
export function setConversation(conversationId: string): void {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  set({ ...initial(), conversationId });
}

/** Replay a finished run from its persisted event log (no live socket). */
export async function replayRun(runId: string): Promise<void> {
  if (socket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }
  set({ ...initial(), conversationId: state.conversationId, runId, status: 'running' });
  try {
    const res = await fetch(`/api/runs/${runId}/events`);
    const events = (await res.json()) as ThanatosEvent[];
    for (const e of events) applyEvent(e);
  } catch {
    /* ignore */
  }
}

export function selectNode(id: string | null): void {
  set({ ...state, selectedNodeId: id });
}

export function highlightTeam(id: string | null): void {
  set({ ...state, highlightedTeamId: state.highlightedTeamId === id ? null : id });
}
