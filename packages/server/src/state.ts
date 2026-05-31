import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type ConversationTurn,
  EventBus,
  loadConfig,
  Orchestrator,
  resolveProjectWorkspace,
  type RunSnapshot,
  type ThanatosEvent,
  type ToolRegistry,
} from '@thanatos/core';

export interface CreateRunOptions {
  task: string;
  maxDepth?: number;
  maxFanout?: number;
  maxAgents?: number;
  mode?: 'live' | 'mock';
  forceScale?: boolean;
  /** Groups runs into a single multi-turn conversation for memory + workspace. */
  conversationId?: string;
}

export interface RunRecord {
  runId: string;
  conversationId: string;
  task: string;
  mode: 'live' | 'mock';
  bus: EventBus;
  orchestrator: Orchestrator;
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface RunSummary {
  runId: string;
  conversationId: string;
  task: string;
  mode: 'live' | 'mock';
  status: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt?: number;
  totals: RunSnapshot['totals'];
}

export interface ConversationSummary {
  conversationId: string;
  lastTask: string;
  runCount: number;
  lastStartedAt: number;
  status: 'running' | 'done' | 'failed';
  mode: 'live' | 'mock';
}

/** Owns all in-flight and finished runs; each run has its own event bus. */
export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly conversations = new Map<string, ConversationTurn[]>();
  /** Summaries of finished runs loaded from disk (not currently in memory). */
  private readonly persisted = new Map<string, RunSummary>();
  private readonly persistRoot = resolve(process.cwd(), 'runs');
  private readonly baseCfg = loadConfig();

  /** Optional shared registry (e.g. with MCP tools) used by every run. */
  constructor(private readonly tools?: ToolRegistry) {}

  create(opts: CreateRunOptions): RunRecord {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const cfg = loadConfig({
      ...(opts.mode ? { llmMode: opts.mode } : {}),
      ...(opts.maxAgents && opts.maxAgents > 0 ? { maxAgents: opts.maxAgents } : {}),
    });
    const bus = new EventBus();
    const orchestrator = new Orchestrator({ cfg, bus, tools: this.tools });

    const convoId = opts.conversationId ?? runId;
    const history = this.conversations.get(convoId) ?? [];

    const record: RunRecord = {
      runId,
      conversationId: convoId,
      task: opts.task,
      mode: cfg.llmMode,
      bus,
      orchestrator,
      status: 'running',
      startedAt: Date.now(),
    };
    this.runs.set(runId, record);

    bus.subscribe((event) => {
      if (event.type === 'run:finished') {
        record.status = event.status;
        record.finishedAt = Date.now();
        if (event.finalResult) {
          const turns = this.conversations.get(convoId) ?? [];
          turns.push({ task: opts.task, result: event.finalResult });
          this.conversations.set(convoId, turns);
        }
        void this.persist(record);
      }
    });

    orchestrator
      .run({
        task: opts.task,
        runId,
        maxDepth: opts.maxDepth,
        maxFanout: opts.maxFanout,
        forceScale: opts.forceScale,
        projectId: convoId ?? runId,
        history,
      })
      .catch((err: unknown) => {
        record.status = 'failed';
        record.finishedAt = Date.now();
        record.error = err instanceof Error ? err.message : String(err);
      });

    return record;
  }

  get(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  private liveSummary(r: RunRecord): RunSummary {
    return {
      runId: r.runId,
      conversationId: r.conversationId,
      task: r.task,
      mode: r.mode,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      totals: r.orchestrator.currentSnapshot().totals,
    };
  }

  list(conversationId?: string): RunSummary[] {
    const byId = new Map<string, RunSummary>();
    for (const s of this.persisted.values()) byId.set(s.runId, s);
    for (const r of this.runs.values()) byId.set(r.runId, this.liveSummary(r)); // live wins
    let all = [...byId.values()];
    if (conversationId) all = all.filter((s) => (s.conversationId ?? s.runId) === conversationId);
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Group runs into conversations (most recent first). */
  listConversations(): ConversationSummary[] {
    const groups = new Map<string, RunSummary[]>();
    for (const s of this.list()) {
      const cid = s.conversationId ?? s.runId;
      const arr = groups.get(cid) ?? [];
      arr.push(s);
      groups.set(cid, arr);
    }
    const out: ConversationSummary[] = [];
    for (const [conversationId, runs] of groups) {
      const sorted = runs.sort((a, b) => b.startedAt - a.startedAt);
      const latest = sorted[0]!;
      out.push({
        conversationId,
        lastTask: latest.task,
        runCount: sorted.length,
        lastStartedAt: latest.startedAt,
        status: latest.status,
        mode: latest.mode,
      });
    }
    return out.sort((a, b) => b.lastStartedAt - a.lastStartedAt);
  }

  /** Delete a whole conversation: its runs (memory + disk) and its workspace. */
  async deleteConversation(conversationId: string): Promise<number> {
    const targets = this.list().filter((s) => (s.conversationId ?? s.runId) === conversationId);
    let removed = 0;
    for (const s of targets) {
      this.runs.delete(s.runId);
      this.persisted.delete(s.runId);
      try {
        await rm(resolve(this.persistRoot, s.runId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      removed++;
    }
    this.conversations.delete(conversationId);
    try {
      await rm(resolveProjectWorkspace(this.baseCfg, conversationId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return removed;
  }

  /** Current snapshot from memory, or the persisted one from disk. */
  async snapshotOf(runId: string): Promise<RunSnapshot | undefined> {
    const live = this.runs.get(runId);
    if (live) return live.orchestrator.currentSnapshot();
    return this.readJson<RunSnapshot>(runId, 'snapshot.json');
  }

  /** Event history from memory, or the persisted log from disk. */
  async eventsOf(runId: string): Promise<ThanatosEvent[]> {
    const live = this.runs.get(runId);
    if (live) return live.bus.history();
    return (await this.readJson<ThanatosEvent[]>(runId, 'events.json')) ?? [];
  }

  /** Write snapshot + events + summary so a finished run can be reloaded/replayed. */
  private async persist(record: RunRecord): Promise<void> {
    try {
      const dir = resolve(this.persistRoot, record.runId);
      await mkdir(dir, { recursive: true });
      const summary = this.liveSummary(record);
      await Promise.all([
        writeFile(resolve(dir, 'snapshot.json'), JSON.stringify(record.orchestrator.currentSnapshot()), 'utf8'),
        writeFile(resolve(dir, 'events.json'), JSON.stringify(record.bus.history()), 'utf8'),
        writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary), 'utf8'),
      ]);
      this.persisted.set(record.runId, summary);
    } catch {
      /* persistence is best-effort */
    }
  }

  /** Load summaries of previously finished runs from disk at startup. */
  async loadPersisted(): Promise<number> {
    if (!existsSync(this.persistRoot)) return 0;
    let count = 0;
    let entries: string[] = [];
    try {
      entries = await readdir(this.persistRoot);
    } catch {
      return 0;
    }
    for (const runId of entries) {
      if (this.persisted.has(runId)) continue;
      const summary = await this.readJson<RunSummary>(runId, 'summary.json');
      if (summary && summary.runId) {
        this.persisted.set(summary.runId, summary);
        count++;
      }
    }
    return count;
  }

  private async readJson<T>(runId: string, file: string): Promise<T | undefined> {
    const path = resolve(this.persistRoot, runId, file);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }
}
