import type { ThanatosConfig } from './config.js';
import type { EventBus } from './events.js';
import { type ChatMessage, type LlmClient, newToolCallId } from './llm.js';
import { aggregateMessages, executeSystem, planMessages, type PlanContext, reviewMessages } from './prompts.js';
import { ToolRegistry } from './tools.js';
import type { AgentNode, DecompositionPlan, SubtaskSpec, TaskMode } from './types.js';
import { extractJson, truncate } from './util.js';

export interface AgentDeps {
  llm: LlmClient;
  tools: ToolRegistry;
  bus: EventBus;
  cfg: ThanatosConfig;
  runId: string;
  scratchDir: string;
  /** Per-project durable workspace directory. */
  workspaceDir: string;
  goal: string;
  /** Formatted prior-turn context shown to the central agent (empty if none). */
  conversation: string;
}

export interface PlanOutcome {
  plan: DecompositionPlan;
  tokens: number;
}

export interface ExecOutcome {
  ok: boolean;
  text: string;
  error?: string;
  tokens: number;
  toolCalls: number;
}

export class ToolIterationLimitError extends Error {
  constructor(readonly iterations: number) {
    super(`tool iteration limit reached after ${iterations} assistant/tool rounds before a final deliverable`);
    this.name = 'ToolIterationLimitError';
  }
}

/** Ask a node whether to delegate or execute, and to produce a subtask plan. */
export async function planNode(
  ctx: PlanContext,
  deps: AgentDeps,
): Promise<PlanOutcome> {
  const mustExecute = ctx.remainingDepth <= 0 || ctx.agentBudgetLeft < 2 || ctx.node.role === 'worker';
  const { system, user } = planMessages({ ...ctx, conversation: deps.conversation });

  const res = await deps.llm.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    jsonMode: true,
    temperature: 0.5,
    mockHint: {
      kind: 'plan',
      depth: ctx.node.depth,
      name: ctx.node.name,
      fanout: ctx.maxFanout,
      remainingDepth: ctx.remainingDepth,
    },
  });

  const raw = extractJson<Partial<DecompositionPlan>>(res.content);
  const plan = normalizePlan(raw, ctx.maxFanout, mustExecute);
  return { plan, tokens: res.usage.totalTokens };
}

function normalizePlan(
  raw: Partial<DecompositionPlan> | undefined,
  maxFanout: number,
  mustExecute: boolean,
): DecompositionPlan {
  const reasoning = typeof raw?.reasoning === 'string' ? raw.reasoning : '';
  const rawSubtasks = Array.isArray(raw?.subtasks) ? raw!.subtasks : [];

  if (mustExecute || raw?.strategy !== 'delegate' || rawSubtasks.length === 0) {
    return { reasoning: reasoning || 'Executing directly.', strategy: 'execute', subtasks: [] };
  }

  const subtasks: SubtaskSpec[] = rawSubtasks.slice(0, maxFanout).map((s, idx) => {
    const mode: TaskMode = s?.mode === 'sync' ? 'sync' : 'async';
    const kind = s?.kind === 'team' ? 'team' : 'worker';
    const dependsOn = Array.isArray(s?.dependsOn)
      ? [...new Set(s.dependsOn)].filter((d) => Number.isInteger(d) && d >= 0 && d < rawSubtasks.length && d !== idx)
      : [];
    return {
      name: (typeof s?.name === 'string' && s.name.trim()) || `Unit ${idx + 1}`,
      mission: (typeof s?.mission === 'string' && s.mission.trim()) || 'Contribute to the parent mission.',
      kind,
      mode,
      dependsOn,
      collaborateWith: normalizeIndexList(s?.collaborateWith, rawSubtasks.length, idx),
    };
  });

  return { reasoning, strategy: 'delegate', subtasks };
}

function normalizeIndexList(value: unknown, length: number, selfIdx: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)].filter((d) => Number.isInteger(d) && d >= 0 && d < length && d !== selfIdx);
}

export interface ReviewOutcome {
  pass: boolean;
  reason: string;
  tokens: number;
}

/** A strict reviewer judges whether a result fulfills the mission and stays on-topic. */
export async function reviewNode(node: AgentNode, result: string, deps: AgentDeps): Promise<ReviewOutcome> {
  const { system, user } = reviewMessages(node, deps.goal, result);
  const res = await deps.llm.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    jsonMode: true,
    temperature: 0.1,
    mockHint: { kind: 'review', depth: node.depth, name: node.name },
  });
  const parsed = extractJson<{ pass?: unknown; reason?: unknown }>(res.content);
  const pass = parsed?.pass === true || /\b(true|pass|accept|通过|合格)\b/i.test(String(parsed?.pass ?? ''));
  const reason = typeof parsed?.reason === 'string' ? parsed.reason : '';
  // If the reviewer's output was unparseable, don't block the pipeline — accept.
  const ok = parsed === undefined ? true : pass;
  return { pass: ok, reason, tokens: res.usage.totalTokens };
}

/** Leaf execution: run the mission directly, looping through any tool calls. */
export async function executeNode(node: AgentNode, deps: AgentDeps, feedback?: string): Promise<ExecOutcome> {
  const messages: ChatMessage[] = [
    { role: 'system', content: executeSystem(node, deps.goal, deps.conversation) },
    {
      role: 'user',
      content: feedback
        ? `Your previous attempt was REJECTED by review: ${feedback}\nRedo the work, fix this, and stay strictly on the goal's topic. Deliver the final result.`
        : 'Begin. Deliver the final result for your mission.',
    },
  ];
  const toolSchemas = deps.tools.schemas();
  let tokens = 0;
  let toolCalls = 0;

  for (let iter = 0; iter < deps.cfg.maxToolIterations; iter++) {
    const res = await deps.llm.chat({
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      temperature: 0.4,
      mockHint: { kind: 'execute', depth: node.depth, name: node.name },
    });
    tokens += res.usage.totalTokens;

    if (res.toolCalls.length === 0) {
      return { ok: true, text: res.content.trim() || '(no output)', tokens, toolCalls };
    }

    // Record the assistant's tool-call turn, then execute each tool.
    messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      toolCalls++;
      const invocation = await deps.tools.invoke(call.name, call.arguments, {
        runId: deps.runId,
        nodeId: node.id,
        bus: deps.bus,
        cfg: deps.cfg,
        scratchDir: deps.scratchDir,
        workspaceDir: deps.workspaceDir,
      });
      messages.push({
        role: 'tool',
        content: truncate(invocation.output, 6000),
        toolCallId: call.id || newToolCallId(),
        name: call.name,
      });
    }
  }

  // Tool budget exhausted — give ONE final round that may still persist a file,
  // then force a tool-free synthesis so we never discard the worker's progress
  // (previously this forbade tools, which blocked a needed workspace_write_file).
  messages.push({
    role: 'user',
    content:
      '你已达到工具调用上限。如果还有必须保存的文件，请现在用 workspace_write_file 完成保存；随后立即给出你的最终交付物。',
  });
  const last = await deps.llm.chat({
    messages,
    tools: toolSchemas.length > 0 ? toolSchemas : undefined,
    temperature: 0.3,
    mockHint: { kind: 'execute', depth: node.depth, name: node.name },
  });
  tokens += last.usage.totalTokens;
  if (last.toolCalls.length === 0) {
    return { ok: true, text: last.content.trim() || '(no output)', tokens, toolCalls };
  }
  messages.push({ role: 'assistant', content: last.content, toolCalls: last.toolCalls });
  for (const call of last.toolCalls) {
    toolCalls++;
    const invocation = await deps.tools.invoke(call.name, call.arguments, {
      runId: deps.runId,
      nodeId: node.id,
      bus: deps.bus,
      cfg: deps.cfg,
      scratchDir: deps.scratchDir,
      workspaceDir: deps.workspaceDir,
    });
    messages.push({
      role: 'tool',
      content: truncate(invocation.output, 6000),
      toolCallId: call.id || newToolCallId(),
      name: call.name,
    });
  }
  const wrap = await deps.llm.chat({
    messages,
    temperature: 0.3,
    mockHint: { kind: 'execute', depth: node.depth, name: node.name },
  });
  tokens += wrap.usage.totalTokens;
  return { ok: true, text: wrap.content.trim() || last.content.trim() || '(no output)', tokens, toolCalls };
}

/** Combine children's results into one deliverable for this node. */
export async function aggregateNode(
  node: AgentNode,
  children: { name: string; ok: boolean; text: string }[],
  deps: AgentDeps,
  feedback?: string,
): Promise<ExecOutcome> {
  const base = aggregateMessages(node, deps.goal, children, deps.conversation);
  const system = base.system;
  const user = feedback
    ? `${base.user}\n\nYour previous synthesis was REJECTED by review: ${feedback}\nRedo it, fix this, and stay strictly on the goal's exact topic.`
    : base.user;
  const res = await deps.llm.chat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    mockHint: { kind: 'aggregate', depth: node.depth, name: node.name, childResults: children.length },
  });
  return { ok: true, text: res.content.trim() || '(no synthesis)', tokens: res.usage.totalTokens, toolCalls: 0 };
}
