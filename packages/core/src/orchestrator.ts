import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { nanoid } from 'nanoid';
import { aggregateNode, type AgentDeps, type ExecOutcome, executeNode, planNode, reviewNode } from './agent.js';
import type { ThanatosConfig } from './config.js';
import { EventBus } from './events.js';
import { createLlmClient, type LlmClient } from './llm.js';
import { defaultToolRegistry, resolveProjectWorkspace, ToolRegistry } from './tools.js';
import type {
  AgentNode,
  AgentRole,
  CollaborationLink,
  ConversationTurn,
  DecompositionPlan,
  NodeResult,
  NodeStatus,
  RunSnapshot,
  SubtaskSpec,
  TaskMode,
  Team,
} from './types.js';
import { colorFromString, sleep, truncate } from './util.js';

export interface RunOptions {
  task: string;
  runId?: string;
  /** Max delegation levels below the central agent. */
  maxDepth?: number;
  /** Max children any node may spawn. */
  maxFanout?: number;
  /** Prior turns for multi-turn memory (most recent last). */
  history?: ConversationTurn[];
  /** Force every level to fan out to maxFanout until the agent budget fills. */
  forceScale?: boolean;
  /** Workspace is isolated under workspace/<projectId>/ (defaults to runId). */
  projectId?: string;
}

interface MakeNodeArgs {
  name: string;
  role: AgentRole;
  depth: number;
  parentId: string | null;
  teamId: string | null;
  mission: string;
  mode: TaskMode;
  dependsOn: string[];
  collaboratesWith?: string[];
  status: NodeStatus;
}

export interface OrchestratorDeps {
  cfg: ThanatosConfig;
  bus?: EventBus;
  llm?: LlmClient;
  tools?: ToolRegistry;
}

/**
 * Builds and runs the agent organization for a single task. State lives in two
 * maps (nodes + teams) and every mutation is mirrored as an event on the bus so
 * the visualization can reconstruct the graph live.
 */
export class Orchestrator {
  readonly bus: EventBus;
  private readonly cfg: ThanatosConfig;
  private readonly llm: LlmClient;
  private readonly tools: ToolRegistry;

  private readonly nodes = new Map<string, AgentNode>();
  private readonly teams = new Map<string, Team>();
  private readonly collaborations = new Map<string, CollaborationLink>();

  private runId = '';
  private goal = '';
  private rootId: string | null = null;
  private maxDepth = 4;
  private maxFanout = 5;
  private forceScale = false;
  private startedAt = 0;
  private finishedAt: number | undefined;
  private status: RunSnapshot['status'] = 'running';
  private finalResult: string | undefined;
  private totalTokens = 0;
  private budgetWarned = false;
  private agentDeps!: AgentDeps;

  constructor(deps: OrchestratorDeps) {
    this.cfg = deps.cfg;
    this.bus = deps.bus ?? new EventBus();
    this.llm = deps.llm ?? createLlmClient(deps.cfg);
    this.tools = deps.tools ?? defaultToolRegistry(deps.cfg);
  }

  async run(opts: RunOptions): Promise<RunSnapshot> {
    this.runId = opts.runId ?? `run_${nanoid(8)}`;
    this.goal = opts.task;
    this.maxDepth = opts.maxDepth ?? 4;
    this.maxFanout = opts.maxFanout ?? 6;
    this.forceScale = opts.forceScale ?? false;
    this.startedAt = Date.now();
    const scratchDir = resolve(process.cwd(), 'runs', this.runId, 'scratch');
    const workspaceDir = resolveProjectWorkspace(this.cfg, opts.projectId ?? this.runId);
    await mkdir(scratchDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });

    this.agentDeps = {
      llm: this.llm,
      tools: this.tools,
      bus: this.bus,
      cfg: this.cfg,
      runId: this.runId,
      scratchDir,
      workspaceDir,
      goal: this.goal,
      conversation: formatConversation(opts.history ?? []),
    };

    this.bus.emit({ type: 'run:started', runId: this.runId, task: this.goal });
    this.log('info', '系统', undefined, `运行开始（${this.llm.mode === 'mock' ? '模拟' : '真实'}模式）：${truncate(this.goal, 120)}`);

    const central = this.makeNode({
      name: '中心',
      role: 'central',
      depth: 0,
      parentId: null,
      teamId: null,
      mission: this.goal,
      mode: 'sync',
      dependsOn: [],
      collaboratesWith: [],
      status: 'pending',
    });
    this.rootId = central.id;

    // Periodic progress report (instead of flooding the log with tool calls).
    const progressTimer = setInterval(() => {
      const all = [...this.nodes.values()];
      const done = all.filter((n) => n.status === 'done' || n.status === 'failed').length;
      const working = all.filter((n) => n.status === 'working');
      const names = working.slice(0, 3).map((n) => n.name).join('、');
      const tokens = all.reduce((a, n) => a + n.tokensUsed, 0);
      const suffix = working.length > 0 ? ` · 进行中 ${working.length}：${names}${working.length > 3 ? '…' : ''}` : '';
      this.log('info', '进度', undefined, `完成 ${done}/${all.length} · ${tokens} tokens${suffix}`);
    }, 15_000);

    let status: RunSnapshot['status'] = 'done';
    let finalResult = '';
    try {
      const result = await this.runNode(central, this.cfg.maxAgents);
      finalResult = result.text;
      status = result.ok ? 'done' : 'failed';
    } catch (err) {
      status = 'failed';
      finalResult = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(progressTimer);
    }

    // Persist the central's synthesis as a durable workspace document.
    try {
      const reportPath = resolve(workspaceDir, 'FINAL_REPORT.md');
      await writeFile(reportPath, finalResult || '(empty)', 'utf8');
      this.log('info', '系统', this.rootId ?? undefined, '最终报告已写入 workspace/FINAL_REPORT.md');
    } catch {
      /* best-effort */
    }

    this.finishedAt = Date.now();
    this.status = status;
    this.finalResult = finalResult;
    const snapshot = this.snapshot(status, finalResult);
    this.bus.emit({
      type: 'run:finished',
      runId: this.runId,
      status,
      finalResult,
      totals: snapshot.totals,
    });
    const statusCn = status === 'done' ? '完成' : status === 'failed' ? '失败' : '运行中';
    this.log('info', '系统', undefined, `运行${statusCn} · ${snapshot.totals.nodes} 个智能体 · ${snapshot.totals.tokens} 令牌`);
    return snapshot;
  }

  // --- core recursion -----------------------------------------------------

  private async runNode(node: AgentNode, subtreeBudget: number): Promise<NodeResult> {
    // Cost ceiling: once the run's token budget is spent, new agents return a
    // cheap stub instead of calling the model, so the run always terminates.
    if (this.overBudget()) {
      this.warnBudgetOnce();
      this.patch(node, { status: 'done', result: '(skipped — run token budget reached)', finishedAt: Date.now() });
      this.reportUp(node);
      return { nodeId: node.id, ok: true, text: node.result ?? '' };
    }

    try {
      this.patch(node, { status: 'planning', startedAt: node.startedAt ?? Date.now() });

      const remainingDepth = this.maxDepth - node.depth;
      const room = this.cfg.maxAgents - this.nodes.size;
      // Under force-scale this subtree may only create up to (budget-1) more.
      const subtreeRoom = this.forceScale ? Math.min(room, Math.max(0, subtreeBudget - 1)) : room;
      const agentBudgetLeft = this.forceScale ? subtreeRoom : room;

      let plan: DecompositionPlan;
      let planTokens = 0;
      try {
        const result = await this.withNodeRetry(node, 'plan', () =>
          planNode(
            { goal: this.goal, node, remainingDepth, maxFanout: this.maxFanout, agentBudgetLeft, forceScale: this.forceScale },
            this.agentDeps,
          ),
        );
        plan = result.plan;
        planTokens = result.tokens;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log('warn', this.scopeOf(node), node.id, `规划多次重试失败，改为直接执行：${truncate(message, 100)}`);
        plan = { reasoning: '', strategy: 'execute', subtasks: [] };
      }

      let subtasks: SubtaskSpec[];
      let childBudgets: number[];
      // Force-scale pads fan-out ONLY when the node genuinely delegates. If the
      // model judged the mission atomic/trivial (execute), we respect that and
      // run it with a single agent — no over-staffing of "handy" work.
      if (this.forceScale && plan.strategy === 'delegate' && remainingDepth > 0 && subtreeRoom >= 2) {
        const built = this.buildBalanced(node, plan, remainingDepth, subtreeRoom);
        subtasks = built.subtasks;
        childBudgets = built.budgets;
      } else {
        subtasks = plan.strategy === 'delegate' ? plan.subtasks.slice(0, Math.max(0, room)) : [];
        childBudgets = subtasks.map(() => this.cfg.maxAgents);
      }

      if (subtasks.length === 0) {
        return await this.executeLeaf(node, planTokens);
      }
      return await this.delegate(node, subtasks, planTokens, childBudgets);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.patch(node, { status: 'failed', error: message, finishedAt: Date.now() });
      this.log('error', this.scopeOf(node), node.id, `失败：${message}`);
      this.reportUp(node);
      return { nodeId: node.id, ok: false, text: `(failed: ${message})`, error: message };
    }
  }

  private async executeLeaf(node: AgentNode, planTokens: number): Promise<NodeResult> {
    this.patch(node, { status: 'working' });
    this.log('info', this.scopeOf(node), node.id, `执行中：${truncate(node.mission, 80)}`);

    let outcome: ExecOutcome;
    try {
      outcome = await this.withNodeRetry(node, 'execute', () => executeNode(node, this.agentDeps));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.totalTokens += planTokens;
      this.patch(node, { status: 'failed', error: message, finishedAt: Date.now(), tokensUsed: planTokens });
      this.log('error', this.scopeOf(node), node.id, `重试 ${this.cfg.maxNodeRetries} 次后放弃：${truncate(message, 100)}`);
      this.reportUp(node);
      return { nodeId: node.id, ok: false, text: `(failed: ${message})`, error: message };
    }

    // Review → rework loop, but ONLY for leaves that did real tool work
    // (i.e. likely produced or changed artifacts). Pure-text leaves skip the
    // reviewer to cut LLM cost roughly in half on large swarms.
    let reviewTokens = 0;
    if (outcome.toolCalls > 0) {
      reviewTokens = await this.reviewAndRework(node, () => outcome.text, async (reason) => {
        outcome = await this.withNodeRetry(node, 'execute', () => executeNode(node, this.agentDeps, reason));
      });
    }

    this.totalTokens += planTokens + outcome.tokens + reviewTokens;
    this.patch(node, {
      status: 'done',
      result: outcome.text,
      finishedAt: Date.now(),
      tokensUsed: planTokens + outcome.tokens + reviewTokens,
      toolCalls: outcome.toolCalls,
    });
    this.reportUp(node);
    return { nodeId: node.id, ok: true, text: outcome.text };
  }

  /**
   * Run a strict review of the node's current result; on rejection, invoke
   * `redo(reason)` to rework it (up to maxReworks). Returns review token cost.
   */
  private async reviewAndRework(
    node: AgentNode,
    getResult: () => string,
    redo: (reason: string) => Promise<void>,
  ): Promise<number> {
    if (!this.cfg.enableReview) return 0;
    let tokens = 0;
    for (let attempt = 0; attempt < this.cfg.maxReworks; attempt++) {
      let review: { pass: boolean; reason: string; tokens: number };
      try {
        review = await reviewNode(node, getResult(), this.agentDeps);
      } catch {
        break; // reviewer failed — don't block the pipeline
      }
      tokens += review.tokens;
      if (review.pass) break;
      this.patch(node, { reworks: node.reworks + 1, status: 'working' });
      this.log('warn', this.scopeOf(node), node.id, `审核未通过，打回重做（第 ${attempt + 1} 次）：${truncate(review.reason, 100)}`);
      try {
        await redo(review.reason);
      } catch {
        break;
      }
    }
    return tokens;
  }

  /**
   * Budget-balanced fan-out. Names/missions come from the LLM's own plan (it
   * invents them for the goal's domain); we choose a child count that divides
   * the subtree budget evenly across the remaining depth, so the org grows
   * BALANCED (no single branch hogs the budget) and fills toward the cap.
   */
  private buildBalanced(
    node: AgentNode,
    plan: DecompositionPlan,
    remainingDepth: number,
    subtreeRoom: number,
  ): { subtasks: SubtaskSpec[]; budgets: number[] } {
    // Even branching factor: count ≈ budget^(1/remainingDepth), capped.
    const ideal = Math.round(Math.pow(Math.max(1, subtreeRoom), 1 / Math.max(1, remainingDepth)));
    const count = Math.max(2, Math.min(this.maxFanout, ideal, subtreeRoom));
    const childBudget = Math.max(1, Math.floor(subtreeRoom / count));
    const kind: SubtaskSpec['kind'] = remainingDepth - 1 >= 1 && childBudget >= 2 ? 'team' : 'worker';
    const base = plan.strategy === 'delegate' ? plan.subtasks : [];

    const subtasks: SubtaskSpec[] = [];
    for (let i = 0; i < count; i++) {
      const seed = base[i];
      subtasks.push({
        name: seed?.name ?? `${node.name}·${i + 1}`,
        mission: seed?.mission ?? `负责「${node.name}」的第 ${i + 1} 部分。`,
        kind,
        mode: seed?.mode === 'sync' ? 'sync' : 'async',
        dependsOn: Array.isArray(seed?.dependsOn) ? seed.dependsOn.filter((d) => d < i) : [],
        collaborateWith: Array.isArray(seed?.collaborateWith)
          ? seed.collaborateWith.filter((d) => Number.isInteger(d) && d >= 0 && d < count && d !== i)
          : i > 0
            ? [i - 1]
            : [],
      });
    }
    return { subtasks, budgets: new Array(count).fill(childBudget) };
  }

  private overBudget(): boolean {
    return this.cfg.maxRunTokens > 0 && this.totalTokens >= this.cfg.maxRunTokens;
  }

  private warnBudgetOnce(): void {
    if (this.budgetWarned) return;
    this.budgetWarned = true;
    this.log('warn', '系统', undefined, `已达运行令牌预算（${this.cfg.maxRunTokens}），其余智能体将被跳过。`);
  }

  /**
   * Re-run a node's unit of work on error, waiting (with exponential backoff +
   * jitter) between attempts. This is the "if an agent breaks or can't connect,
   * wait and retry" layer that sits above the LLM client's per-request retries.
   */
  private async withNodeRetry<T>(node: AgentNode, label: 'plan' | 'execute' | 'aggregate', fn: () => Promise<T>): Promise<T> {
    const busyStatus: NodeStatus = label === 'aggregate' ? 'aggregating' : label === 'plan' ? 'planning' : 'working';
    let attempt = 0;
    let lastErr: unknown;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt >= this.cfg.maxNodeRetries) break;
        attempt++;
        const message = err instanceof Error ? err.message : String(err);
        this.patch(node, { retries: node.retries + 1, status: 'blocked' });
        const backoff = Math.min(30_000, this.cfg.nodeRetryBaseMs * 2 ** (attempt - 1)) + Math.random() * 500;
        const labelCn = label === 'plan' ? '规划' : label === 'aggregate' ? '汇总' : '执行';
        this.log(
          'warn',
          this.scopeOf(node),
          node.id,
          `${labelCn}出错（第 ${attempt}/${this.cfg.maxNodeRetries} 次重试，${Math.round(backoff)}ms 后）：${truncate(message, 100)}`,
        );
        await sleep(backoff);
        this.patch(node, { status: busyStatus });
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async delegate(
    node: AgentNode,
    subtasks: SubtaskSpec[],
    planTokens: number,
    childBudgets: number[],
  ): Promise<NodeResult> {
    const myTeam = this.ensureTeam(node);
    const n = subtasks.length;
    const childIds = subtasks.map(() => this.newId());
    const isTeam = subtasks.map((s) => s.kind === 'team');

    // Explicit deps: keep only backward edges so the child graph is always a DAG.
    const deps: string[][] = subtasks.map((s, idx) =>
      s.dependsOn.filter((i) => i < idx).map((i) => childIds[i]!),
    );
    const collaborations: string[][] = subtasks.map((s, idx) =>
      (s.collaborateWith ?? [])
        .filter((i) => i >= 0 && i < subtasks.length && i !== idx)
        .map((i) => childIds[i]!)
        .filter(Boolean),
    );
    // Serialize sync siblings into a chain (also backward edges).
    let prevSync = -1;
    subtasks.forEach((s, idx) => {
      if (s.mode === 'sync') {
        if (prevSync >= 0 && !deps[idx]!.includes(childIds[prevSync]!)) deps[idx]!.push(childIds[prevSync]!);
        prevSync = idx;
      }
    });

    // Team groupings: a 'team' child heads its own department/sub-team; a
    // 'worker' child joins this node's team.
    const childTeamId: string[] = subtasks.map((s, idx) => {
      if (s.kind === 'team') {
        const dept = this.createTeam(s.name, childIds[idx]!, myTeam.id, node.depth + 1, s.mission);
        return dept.id;
      }
      return myTeam.id;
    });
    // Inter-department dependency edges (best effort, for the snapshot).
    subtasks.forEach((s, idx) => {
      if (!isTeam[idx]) return;
      const team = this.teams.get(childTeamId[idx]!);
      if (!team) return;
      team.dependsOn = deps[idx]!
        .filter((depId) => isTeam[childIds.indexOf(depId)] === true)
        .map((depId) => childTeamId[childIds.indexOf(depId)]!);
    });

    this.patch(node, { status: 'delegating' });
    this.log(
      'info',
      this.scopeOf(node),
      node.id,
      `拆分为 ${n} 个单元：${subtasks.map((s) => s.name).join('、')}`,
    );

    const childNodes = subtasks.map((s, idx) =>
      this.makeNode({
        name: s.name,
        role: isTeam[idx] ? 'lead' : 'worker',
        depth: node.depth + 1,
        parentId: node.id,
        teamId: childTeamId[idx]!,
        mission: s.mission,
        mode: s.mode,
        dependsOn: deps[idx]!,
        collaboratesWith: collaborations[idx]!,
        status: deps[idx]!.length > 0 ? 'blocked' : 'pending',
        forcedId: childIds[idx]!,
      }),
    );
    node.childrenIds = childIds;
    this.patch(node, { childrenIds: childIds });
    for (const child of childNodes) {
      this.bus.emit({ type: 'edge:flow', runId: this.runId, from: node.id, to: child.id, kind: 'dispatch' });
    }
    this.startCollaborations(node, childNodes, subtasks, collaborations);

    const results = await this.runChildren(childNodes, childBudgets);
    this.endCollaborations(childNodes);

    this.patch(node, { status: 'aggregating' });
    const childResults = childNodes.map((c, i) => ({
      name: c.name,
      ok: results[i]?.ok ?? false,
      text: results[i]?.text ?? '(no result)',
    }));

    let agg: ExecOutcome;
    try {
      agg = await this.withNodeRetry(node, 'aggregate', () => aggregateNode(node, childResults, this.agentDeps));
    } catch (err) {
      // Never throw away the children's work — fall back to concatenation.
      const joined = childResults.map((c) => `## ${c.name}${c.ok ? '' : ' (failed)'}\n${c.text}`).join('\n\n');
      agg = { ok: true, text: joined || '(no results)', tokens: 0, toolCalls: 0 };
      const message = err instanceof Error ? err.message : String(err);
      this.log('warn', this.scopeOf(node), node.id, `汇总多次重试失败，已拼接 ${n} 个子结果：${truncate(message, 80)}`);
    }

    // The central's final synthesis is reviewed for on-topic fidelity and reworked if it drifts.
    let reviewTokens = 0;
    if (node.role === 'central') {
      reviewTokens = await this.reviewAndRework(node, () => agg.text, async (reason) => {
        agg = await this.withNodeRetry(node, 'aggregate', () => aggregateNode(node, childResults, this.agentDeps, reason));
      });
    }

    this.totalTokens += planTokens + agg.tokens + reviewTokens;
    this.patch(node, {
      status: 'done',
      result: agg.text,
      finishedAt: Date.now(),
      tokensUsed: planTokens + agg.tokens + reviewTokens,
    });
    this.log('info', this.scopeOf(node), node.id, `已汇总 ${n} 个子结果`);
    this.reportUp(node);
    return { nodeId: node.id, ok: true, text: agg.text };
  }

  private startCollaborations(
    parent: AgentNode,
    childNodes: AgentNode[],
    subtasks: SubtaskSpec[],
    collaborations: string[][],
  ): void {
    const byId = new Map(childNodes.map((c) => [c.id, c] as const));
    const notes = new Map<string, string[]>();
    const seen = new Set<string>();
    for (const [idx, from] of childNodes.entries()) {
      for (const toId of collaborations[idx] ?? []) {
        const to = byId.get(toId);
        if (!to) continue;
        const key = [from.id, to.id].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const reason = `Coordinate "${from.name}" with "${to.name}" under "${parent.name}". Share assumptions, interfaces, findings, and validation notes through workspace files when useful.`;
        const link: CollaborationLink = {
          id: `c_${nanoid(8)}`,
          from: from.id,
          to: to.id,
          reason,
          startedAt: Date.now(),
        };
        this.collaborations.set(link.id, link);
        this.bus.emit({ type: 'collaboration:started', runId: this.runId, link });
        this.bus.emit({ type: 'edge:flow', runId: this.runId, from: from.id, to: to.id, kind: 'collaboration', label: 'collab' });
        const fromMission = subtasks[idx]?.mission ?? from.mission;
        notes.set(from.id, [...(notes.get(from.id) ?? []), `Collaborate with ${to.name}: ${to.mission}`]);
        notes.set(to.id, [...(notes.get(to.id) ?? []), `Collaborate with ${from.name}: ${fromMission}`]);
      }
    }
    for (const child of childNodes) {
      const childNotes = notes.get(child.id);
      if (!childNotes?.length) continue;
      this.patch(child, {
        collaborationNotes: [
          'You may freely coordinate with these peer units while doing your mission.',
          ...childNotes,
          'If you produce a shared contract, benchmark, source summary, or integration note, write it to the durable workspace.',
        ].join('\n'),
      });
    }
    if (seen.size > 0) this.log('info', this.scopeOf(parent), parent.id, `created ${seen.size} collaboration link(s)`);
  }

  private endCollaborations(childNodes: AgentNode[]): void {
    const ids = new Set(childNodes.map((c) => c.id));
    for (const link of this.collaborations.values()) {
      if (link.endedAt || (!ids.has(link.from) && !ids.has(link.to))) continue;
      link.endedAt = Date.now();
      this.bus.emit({ type: 'collaboration:ended', runId: this.runId, linkId: link.id, endedAt: link.endedAt });
    }
  }

  /** Run children honoring their (acyclic) dependency edges; join on all. */
  private runChildren(children: AgentNode[], budgets: number[]): Promise<NodeResult[]> {
    const byId = new Map(children.map((c, i) => [c.id, { node: c, budget: budgets[i] ?? this.cfg.maxAgents }] as const));
    const started = new Map<string, Promise<NodeResult>>();

    const start = (child: AgentNode): Promise<NodeResult> => {
      const existing = started.get(child.id);
      if (existing) return existing;
      const promise = (async () => {
        for (const depId of child.dependsOn) {
          const dep = byId.get(depId);
          if (!dep) continue;
          await start(dep.node);
          this.bus.emit({
            type: 'edge:flow',
            runId: this.runId,
            from: depId,
            to: child.id,
            kind: 'message',
            label: 'handoff',
          });
        }
        return this.runNode(child, byId.get(child.id)?.budget ?? this.cfg.maxAgents);
      })();
      started.set(child.id, promise);
      return promise;
    };

    return Promise.all(children.map(start));
  }

  // --- state helpers ------------------------------------------------------

  private newId(): string {
    return `n_${nanoid(8)}`;
  }

  private makeNode(args: MakeNodeArgs & { forcedId?: string }): AgentNode {
    const node: AgentNode = {
      id: args.forcedId ?? this.newId(),
      name: args.name,
      role: args.role,
      depth: args.depth,
      parentId: args.parentId,
      teamId: args.teamId,
      mission: args.mission,
      status: args.status,
      childrenIds: [],
      mode: args.mode,
      dependsOn: args.dependsOn,
      collaboratesWith: args.collaboratesWith ?? [],
      createdAt: Date.now(),
      tokensUsed: 0,
      toolCalls: 0,
      retries: 0,
      reworks: 0,
    };
    this.nodes.set(node.id, node);
    this.bus.emit({ type: 'node:created', runId: this.runId, node: { ...node } });
    return node;
  }

  private ensureTeam(node: AgentNode): Team {
    if (node.teamId) {
      const existing = this.teams.get(node.teamId);
      if (existing) return existing;
    }
    const parentTeamId = node.parentId ? this.nodes.get(node.parentId)?.teamId ?? null : null;
    const name = node.role === 'central' ? '指挥中心' : node.name;
    const team = this.createTeam(name, node.id, parentTeamId, node.depth, node.mission);
    node.teamId = team.id;
    this.patch(node, { teamId: team.id });
    return team;
  }

  private createTeam(
    name: string,
    leadId: string,
    parentTeamId: string | null,
    depth: number,
    mission: string,
  ): Team {
    const team: Team = {
      id: `t_${nanoid(8)}`,
      name,
      mission,
      leadId,
      parentTeamId,
      dependsOn: [],
      color: colorFromString(name + depth),
      depth,
    };
    this.teams.set(team.id, team);
    this.bus.emit({ type: 'team:created', runId: this.runId, team: { ...team } });
    return team;
  }

  private patch(node: AgentNode, patch: Partial<AgentNode>): void {
    Object.assign(node, patch);
    this.bus.emit({ type: 'node:updated', runId: this.runId, nodeId: node.id, patch });
  }

  private reportUp(node: AgentNode): void {
    if (!node.parentId) return;
    this.bus.emit({
      type: 'edge:flow',
      runId: this.runId,
      from: node.id,
      to: node.parentId,
      kind: 'result',
      label: node.status === 'failed' ? 'failed' : 'result',
    });
  }

  private scopeOf(node: AgentNode): string {
    if (node.teamId) return this.teams.get(node.teamId)?.name ?? '系统';
    return node.role === 'central' ? '指挥中心' : '系统';
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', scope: string, nodeId: string | undefined, message: string): void {
    this.bus.emit({ type: 'log', runId: this.runId, level, scope, nodeId, message });
  }

  /** Snapshot of the current state (status reflects in-progress runs). */
  currentSnapshot(): RunSnapshot {
    return this.snapshot(this.status, this.finalResult);
  }

  snapshot(status: RunSnapshot['status'], finalResult?: string): RunSnapshot {
    const nodes = [...this.nodes.values()];
    const totals = {
      nodes: nodes.length,
      tokens: nodes.reduce((a, n) => a + n.tokensUsed, 0),
      toolCalls: nodes.reduce((a, n) => a + n.toolCalls, 0),
    };
    return {
      runId: this.runId,
      task: this.goal,
      status,
      rootId: this.rootId,
      nodes: nodes.map((n) => ({ ...n })),
      teams: [...this.teams.values()].map((t) => ({ ...t })),
      collaborations: [...this.collaborations.values()].map((c) => ({ ...c })),
      finalResult,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      totals,
    };
  }
}

/** Render recent turns into a compact transcript for the central agent. */
function formatConversation(history: ConversationTurn[]): string {
  if (history.length === 0) return '';
  return history
    .slice(-6)
    .map((t, i) => `[Turn ${i + 1}]\nUser: ${truncate(t.task, 400)}\nThanatos: ${truncate(t.result, 800)}`)
    .join('\n\n');
}
