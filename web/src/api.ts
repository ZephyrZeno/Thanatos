import type { ServerConfig } from './types';

export interface CreateRunBody {
  task: string;
  mode?: 'live' | 'mock';
  maxDepth?: number;
  maxFanout?: number;
  maxAgents?: number;
  forceScale?: boolean;
  conversationId?: string;
}

export async function getConfig(): Promise<ServerConfig> {
  const res = await fetch('/api/config');
  if (!res.ok) throw new Error(`config ${res.status}`);
  return res.json();
}

export async function createRun(body: CreateRunBody): Promise<{ runId: string; mode: 'live' | 'mock' }> {
  const res = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error((detail as { error?: string }).error ?? `run ${res.status}`);
  }
  return res.json();
}

export interface RunSummary {
  runId: string;
  conversationId: string;
  task: string;
  mode: 'live' | 'mock';
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  totals: { nodes: number; tokens: number; toolCalls: number };
}

export interface ConversationSummary {
  conversationId: string;
  lastTask: string;
  runCount: number;
  lastStartedAt: number;
  status: 'running' | 'done' | 'failed';
  mode: 'live' | 'mock';
}

export async function listRuns(conversationId?: string): Promise<RunSummary[]> {
  const url = conversationId ? `/api/runs?conversation=${encodeURIComponent(conversationId)}` : '/api/runs';
  const res = await fetch(url);
  if (!res.ok) return [];
  return res.json();
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch('/api/conversations');
  if (!res.ok) return [];
  return res.json();
}

export async function deleteConversation(conversationId: string): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'DELETE' });
}

export async function getRun(runId: string): Promise<{ task: string; finalResult?: string; status: string } | null> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (!res.ok) return null;
  const d = (await res.json()) as { task?: string; finalResult?: string; status?: string };
  return { task: d.task ?? '', finalResult: d.finalResult, status: d.status ?? 'done' };
}

export interface WorkspaceFile {
  path: string;
  size: number;
}

export async function listWorkspace(project: string): Promise<WorkspaceFile[]> {
  const res = await fetch(`/api/workspace?project=${encodeURIComponent(project)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { files?: WorkspaceFile[] };
  return data.files ?? [];
}

export async function readWorkspaceFile(path: string, project: string): Promise<string> {
  const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}&project=${encodeURIComponent(project)}`);
  if (!res.ok) return '';
  const data = (await res.json()) as { content?: string };
  return data.content ?? '';
}

export async function revealWorkspace(project: string, path?: string): Promise<void> {
  await fetch('/api/workspace/reveal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project, ...(path ? { path } : {}) }),
  });
}

export function wsUrl(runId: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?runId=${encodeURIComponent(runId)}`;
}
