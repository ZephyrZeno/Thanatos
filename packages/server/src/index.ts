import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import {
  connectMcpServers,
  defaultToolRegistry,
  listWorkspaceDir,
  loadConfig,
  loadMcpConfig,
  resolveProjectWorkspace,
  resolvePathInWorkspaceDir,
} from '@thanatos/core';
import { RunManager } from './state.js';

function projectRoot(project: unknown): string {
  return resolveProjectWorkspace(cfg, typeof project === 'string' && project ? project : 'default');
}

function revealInFileManager(target: string): void {
  if (process.platform === 'win32') {
    const isFile = existsSync(target) && statSync(target).isFile();
    const args = isFile ? ['/select,', target] : [target];
    spawn('explorer', args, { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
  }
}

const cfg = loadConfig();
const registry = defaultToolRegistry(cfg);
const manager = new RunManager(registry);
let mcpServers: string[] = [];

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, model: cfg.model, mode: cfg.llmMode });
});

app.get('/api/config', (_req, res) => {
  res.json({
    model: cfg.model,
    mode: cfg.llmMode,
    maxAgents: cfg.maxAgents,
    maxConcurrency: cfg.maxConcurrency,
    pythonTool: cfg.enablePythonTool,
    tools: registry.schemas().map((s) => s.name),
    mcpServers,
  });
});

app.post('/api/runs', (req, res) => {
  const body = (req.body ?? {}) as {
    task?: unknown;
    maxDepth?: unknown;
    maxFanout?: unknown;
    maxAgents?: unknown;
    mode?: unknown;
    forceScale?: unknown;
    conversationId?: unknown;
  };
  const task = typeof body.task === 'string' ? body.task.trim() : '';
  if (!task) {
    res.status(400).json({ error: 'task is required' });
    return;
  }
  const record = manager.create({
    task,
    maxDepth: typeof body.maxDepth === 'number' ? body.maxDepth : undefined,
    maxFanout: typeof body.maxFanout === 'number' ? body.maxFanout : undefined,
    maxAgents: typeof body.maxAgents === 'number' ? body.maxAgents : undefined,
    mode: body.mode === 'mock' || body.mode === 'live' ? body.mode : undefined,
    forceScale: body.forceScale === true,
    conversationId: typeof body.conversationId === 'string' ? body.conversationId : undefined,
  });
  res.json({ runId: record.runId, mode: record.mode });
});

app.get('/api/runs', (req, res) => {
  const conv = typeof req.query.conversation === 'string' ? req.query.conversation : undefined;
  res.json(manager.list(conv));
});

app.get('/api/conversations', (_req, res) => {
  res.json(manager.listConversations());
});

app.delete('/api/conversations/:id', async (req, res) => {
  const removed = await manager.deleteConversation(req.params.id);
  res.json({ ok: true, removed });
});

app.get('/api/runs/:id', async (req, res) => {
  const snapshot = await manager.snapshotOf(req.params.id);
  if (!snapshot) {
    res.status(404).json({ error: 'unknown run' });
    return;
  }
  res.json(snapshot);
});

app.get('/api/runs/:id/events', async (req, res) => {
  const events = await manager.eventsOf(req.params.id);
  res.json(events);
});

app.get('/api/workspace', async (req, res) => {
  const root = projectRoot(req.query.project);
  const files = await listWorkspaceDir(root);
  res.json({ root: 'workspace', files });
});

app.post('/api/workspace/reveal', (req, res) => {
  try {
    const b = (req.body ?? {}) as { path?: unknown; project?: unknown };
    const root = projectRoot(b.project);
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    const target = typeof b.path === 'string' && b.path ? resolvePathInWorkspaceDir(root, b.path) : root;
    revealInFileManager(existsSync(target) ? target : root);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'reveal failed' });
  }
});

app.get('/api/workspace/file', async (req, res) => {
  const p = typeof req.query.path === 'string' ? req.query.path : '';
  if (!p) {
    res.status(400).json({ error: 'path required' });
    return;
  }
  try {
    const abs = resolvePathInWorkspaceDir(projectRoot(req.query.project), p);
    if (!existsSync(abs)) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const content = await readFile(abs, 'utf8');
    res.json({ path: p, content: content.slice(0, 200_000) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'bad path' });
  }
});

// Serve the built web app (production). In dev, Vite serves it on :5173.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '../../../web/dist');
const webIndex = resolve(webDist, 'index.html');
if (existsSync(webIndex)) {
  app.use(express.static(webDist));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(webIndex);
    } else {
      next();
    }
  });
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const runId = url.searchParams.get('runId') ?? '';
  const record = manager.get(runId);
  if (!record) {
    socket.send(JSON.stringify({ type: 'error', message: 'unknown runId' }));
    socket.close();
    return;
  }
  // Replay history so a late-joining client can rebuild the graph, then stream.
  socket.send(JSON.stringify({ type: 'history', events: record.bus.history() }));
  const unsubscribe = record.bus.subscribe((event) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  });
  socket.on('close', unsubscribe);
  socket.on('error', unsubscribe);
});

async function start(): Promise<void> {
  try {
    const loaded = await manager.loadPersisted();
    if (loaded > 0) console.log(`[runs] loaded ${loaded} persisted run(s) from disk`);
  } catch {
    /* ignore */
  }
  try {
    const mcpConfig = await loadMcpConfig();
    const mcp = await connectMcpServers(mcpConfig, registry, (m) => console.log(`[mcp] ${m}`));
    mcpServers = mcp.servers;
    if (mcp.servers.length > 0) {
      console.log(`[mcp] ${mcp.toolNames.length} tool(s) from: ${mcp.servers.join(', ')}`);
    }
  } catch (err) {
    console.warn('[mcp] init failed:', err instanceof Error ? err.message : err);
  }
  server.listen(cfg.port, () => {
    console.log(`Thanatos server → http://localhost:${cfg.port}  (model=${cfg.model}, mode=${cfg.llmMode})`);
  });
}

void start();
