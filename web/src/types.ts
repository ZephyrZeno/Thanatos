export type AgentRole = 'central' | 'lead' | 'worker';

export type NodeStatus =
  | 'pending'
  | 'blocked'
  | 'planning'
  | 'delegating'
  | 'working'
  | 'aggregating'
  | 'done'
  | 'failed';

export type TaskMode = 'sync' | 'async';
export type FlowKind = 'dispatch' | 'result' | 'message' | 'collaboration';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentNode {
  id: string;
  name: string;
  role: AgentRole;
  depth: number;
  parentId: string | null;
  teamId: string | null;
  mission: string;
  status: NodeStatus;
  childrenIds: string[];
  result?: string;
  error?: string;
  mode: TaskMode;
  dependsOn: string[];
  collaboratesWith: string[];
  collaborationNotes?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  tokensUsed: number;
  toolCalls: number;
  retries: number;
  reworks: number;
}

export interface CollaborationLink {
  id: string;
  from: string;
  to: string;
  reason: string;
  startedAt: number;
  endedAt?: number;
}

export interface Team {
  id: string;
  name: string;
  mission: string;
  leadId: string;
  parentTeamId: string | null;
  dependsOn: string[];
  color: string;
  depth: number;
}

export interface Totals {
  nodes: number;
  tokens: number;
  toolCalls: number;
}

interface Base {
  runId: string;
  ts: number;
  seq: number;
}

export type ThanatosEvent =
  | (Base & { type: 'run:started'; task: string })
  | (Base & { type: 'run:finished'; status: 'done' | 'failed'; finalResult?: string; totals: Totals })
  | (Base & { type: 'team:created'; team: Team })
  | (Base & { type: 'node:created'; node: AgentNode })
  | (Base & { type: 'node:updated'; nodeId: string; patch: Partial<AgentNode> })
  | (Base & { type: 'edge:flow'; from: string; to: string; kind: FlowKind; label?: string })
  | (Base & { type: 'collaboration:started'; link: CollaborationLink })
  | (Base & { type: 'collaboration:ended'; linkId: string; endedAt: number })
  | (Base & { type: 'log'; level: LogLevel; scope: string; nodeId?: string; message: string })
  | (Base & { type: 'tool:call'; nodeId: string; tool: string; args: string; ok: boolean; preview: string });

export interface ServerConfig {
  model: string;
  mode: 'live' | 'mock';
  maxAgents: number;
  maxConcurrency: number;
  pythonTool: boolean;
}
