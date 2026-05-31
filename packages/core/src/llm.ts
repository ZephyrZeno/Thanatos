import OpenAI from 'openai';
import pLimit from 'p-limit';
import { nanoid } from 'nanoid';
import type { ThanatosConfig } from './config.js';
import { sleep } from './util.js';

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: LlmToolCall[];
  /** Present on tool-result messages. */
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Hint used only by the mock client to synthesize deterministic output. */
export interface MockHint {
  kind: 'plan' | 'execute' | 'aggregate' | 'review';
  depth: number;
  name: string;
  childResults?: number;
  /** Branching factor + remaining depth let mock build a full-scale org tree. */
  fanout?: number;
  remainingDepth?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  temperature?: number;
  /** Ask the model to return a single JSON object. */
  jsonMode?: boolean;
  mockHint?: MockHint;
}

export interface ChatResult {
  content: string;
  toolCalls: LlmToolCall[];
  usage: { totalTokens: number; promptTokens: number; completionTokens: number };
}

export interface LlmClient {
  readonly mode: 'live' | 'mock';
  chat(req: ChatRequest): Promise<ChatResult>;
}

const RETRYABLE =
  /(429|408|409|425|5\d\d|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|upstream|request failed|bad gateway|gateway|overloaded|rate.?limit|temporarily|try again|abort|aborted|idle|stream)/i;

/** Live client talking to any OpenAI-compatible /chat/completions endpoint. */
export class LiveLlmClient implements LlmClient {
  readonly mode = 'live' as const;
  private readonly client: OpenAI;
  private readonly limit: ReturnType<typeof pLimit>;

  constructor(private readonly cfg: ThanatosConfig) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey || 'missing-key',
      baseURL: cfg.apiBaseUrl,
    });
    this.limit = pLimit(Math.max(1, cfg.maxConcurrency));
  }

  chat(req: ChatRequest): Promise<ChatResult> {
    return this.limit(() => this.chatWithRetry(req));
  }

  private async chatWithRetry(req: ChatRequest): Promise<ChatResult> {
    let attempt = 0;
    let allowJsonFormat = req.jsonMode === true;
    let allowTemperature = true;
    let lastErr: unknown;

    while (attempt <= this.cfg.maxRetries) {
      try {
        return await this.once(req, allowJsonFormat, allowTemperature);
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);

        // Downgrade params some (reasoning) models reject, then retry for free.
        if (allowJsonFormat && /response_format|json_object/i.test(msg)) {
          allowJsonFormat = false;
          continue;
        }
        if (allowTemperature && /temperature|unsupported[_ ]value|unsupported parameter/i.test(msg)) {
          allowTemperature = false;
          continue;
        }
        if (attempt >= this.cfg.maxRetries || !RETRYABLE.test(msg)) break;
        const backoff = Math.min(20_000, 600 * 2 ** attempt) + Math.random() * 400;
        await sleep(backoff);
        attempt++;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * One streamed completion. This endpoint family only emits content over SSE
   * (a non-stream request returns empty choices), so we always stream and
   * accumulate content, tool-call deltas, and the trailing usage chunk.
   */
  private async once(req: ChatRequest, allowJsonFormat: boolean, allowTemperature: boolean): Promise<ChatResult> {
    const messages = req.messages.map(toOpenAiMessage);
    const tools = req.tools?.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    // Two-phase abort: a GENEROUS window for the first token (reasoning models
    // can think a long time before emitting anything, and a proxy that opens
    // then never sends is caught here), then a short IDLE window between chunks
    // (catches a stream that freezes mid-flight). This avoids false-aborting
    // slow-but-healthy reasoning while still recovering fast from true hangs.
    const controller = new AbortController();
    const idleMs = Math.min(60_000, this.cfg.requestTimeoutMs);
    const firstTokenMs = Math.min(110_000, this.cfg.requestTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, label: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`stream ${label} timeout ${ms}ms`)), ms);
    };

    const stream = await this.client.chat.completions.create(
      {
        model: this.cfg.model,
        messages,
        stream: true,
        ...(allowTemperature ? { temperature: req.temperature ?? 0.4 } : {}),
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(allowJsonFormat ? { response_format: { type: 'json_object' as const } } : {}),
      },
      { timeout: this.cfg.requestTimeoutMs, maxRetries: 0, signal: controller.signal },
    );

    let content = '';
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();
    let usage = { totalTokens: 0, promptTokens: 0, completionTokens: 0 };

    arm(firstTokenMs, 'first-token');
    try {
      for await (const chunk of stream) {
        arm(idleMs, 'idle');
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
        if (chunk.usage) {
          usage = {
            totalTokens: chunk.usage.total_tokens ?? 0,
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
          };
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    const toolCalls: LlmToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id || newToolCallId(), name: v.name, arguments: v.args || '{}' }))
      .filter((t) => t.name);

    return { content, toolCalls, usage };
  }
}

function toOpenAiMessage(m: ChatMessage): OpenAI.Chat.ChatCompletionMessageParam {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      return { role: 'user', content: m.content };
    case 'tool':
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
  }
}

/**
 * Deterministic, network-free client used for testing orchestration logic.
 * It produces a believable org chart and synthesized results based on the
 * {@link MockHint} attached to each request.
 */
export class MockLlmClient implements LlmClient {
  readonly mode = 'mock' as const;

  constructor(private readonly failRate = 0) {}

  async chat(req: ChatRequest): Promise<ChatResult> {
    await sleep(30 + Math.random() * 120);
    if (this.failRate > 0 && Math.random() < this.failRate) {
      throw new Error('mock upstream failure (chaos)');
    }
    const hint = req.mockHint ?? { kind: 'execute', depth: 0, name: 'node' };
    const content = this.synthesize(hint);
    return {
      content,
      toolCalls: [],
      usage: { totalTokens: 80 + hint.depth * 15, promptTokens: 50, completionTokens: 30 },
    };
  }

  private synthesize(hint: MockHint): string {
    if (hint.kind === 'plan') return JSON.stringify(this.mockPlan(hint));
    if (hint.kind === 'review') return JSON.stringify({ pass: true, reason: 'mock approved' });
    if (hint.kind === 'aggregate') {
      return `[synthesis · ${hint.name}] Combined ${hint.childResults ?? 0} sub-results into a coherent deliverable for "${hint.name}".`;
    }
    return `[work · ${hint.name}] Completed the assigned mission with a concrete deliverable (mock output).`;
  }

  private mockPlan(hint: MockHint) {
    const fanout = Math.max(2, Math.min(hint.fanout ?? 3, 6));
    const rem = hint.remainingDepth ?? (hint.depth === 0 ? 3 : 0);
    if (rem <= 0) return { reasoning: 'Atomic — execute directly.', strategy: 'execute', subtasks: [] };

    // rem >= 2 → children are sub-teams that recurse; rem === 1 → leaf workers.
    const kind = rem >= 2 ? 'team' : 'worker';
    const subtasks = Array.from({ length: fanout }, (_, i) => ({
      name: hint.depth === 0 ? `分部${i + 1}` : `${hint.name}-${i + 1}`,
      mission: `负责「${hint.name}」的第 ${i + 1} 部分。`,
      kind,
      mode: 'async' as const,
      dependsOn: [] as number[],
      collaborateWith: i > 0 ? [i - 1] : [],
    }));
    return { reasoning: `Split into ${fanout} ${kind}(s).`, strategy: 'delegate', subtasks };
  }
}

export function createLlmClient(cfg: ThanatosConfig): LlmClient {
  return cfg.llmMode === 'mock' ? new MockLlmClient(cfg.mockFailRate) : new LiveLlmClient(cfg);
}

export function newToolCallId(): string {
  return `call_${nanoid(10)}`;
}
