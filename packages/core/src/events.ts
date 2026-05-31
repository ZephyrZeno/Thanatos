import type { AgentNode, CollaborationLink, Team } from './types.js';

interface BaseEvent {
  runId: string;
  /** epoch ms */
  ts: number;
  /** monotonically increasing per-bus sequence number */
  seq: number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Direction/meaning of an animated edge in the visualization. */
export type FlowKind = 'dispatch' | 'result' | 'message' | 'collaboration';

/** Everything that happens during a run is one of these events. */
export type ThanatosEvent =
  | (BaseEvent & { type: 'run:started'; task: string })
  | (BaseEvent & {
      type: 'run:finished';
      status: 'done' | 'failed';
      finalResult?: string;
      totals: { nodes: number; tokens: number; toolCalls: number };
    })
  | (BaseEvent & { type: 'team:created'; team: Team })
  | (BaseEvent & { type: 'node:created'; node: AgentNode })
  | (BaseEvent & { type: 'node:updated'; nodeId: string; patch: Partial<AgentNode> })
  | (BaseEvent & {
      type: 'edge:flow';
      from: string;
      to: string;
      kind: FlowKind;
      label?: string;
    })
  | (BaseEvent & {
      type: 'collaboration:started';
      link: CollaborationLink;
    })
  | (BaseEvent & {
      type: 'collaboration:ended';
      linkId: string;
      endedAt: number;
    })
  | (BaseEvent & {
      type: 'log';
      level: LogLevel;
      scope: string;
      nodeId?: string;
      message: string;
    })
  | (BaseEvent & {
      type: 'tool:call';
      nodeId: string;
      tool: string;
      args: string;
      ok: boolean;
      preview: string;
    });

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** What callers pass to {@link EventBus.emit} — `ts`/`seq` are filled in by the bus. */
export type EmitInput = DistributiveOmit<ThanatosEvent, 'ts' | 'seq'>;

export type EventListener = (event: ThanatosEvent) => void;

/**
 * A tiny synchronous pub/sub bus. Every emitted event is stamped with a
 * monotonic sequence number and timestamp, buffered for replay, and fanned out
 * to all listeners. The server subscribes and relays events to WebSocket
 * clients; the visualization replays the buffer on connect.
 */
export class EventBus {
  private seq = 0;
  private readonly listeners = new Set<EventListener>();
  private readonly buffer: ThanatosEvent[] = [];
  private readonly maxBuffer: number;

  constructor(maxBuffer = 50_000) {
    this.maxBuffer = maxBuffer;
  }

  emit(input: EmitInput): ThanatosEvent {
    const event = { ...input, ts: Date.now(), seq: this.seq++ } as ThanatosEvent;
    this.buffer.push(event);
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A bad listener must never break the engine.
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events emitted so far (for replaying to a late-joining client). */
  history(): ThanatosEvent[] {
    return [...this.buffer];
  }
}
