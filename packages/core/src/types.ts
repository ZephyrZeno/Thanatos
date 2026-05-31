/**
 * Core domain types for the Thanatos multi-agent organization.
 *
 * The organization is a tree of {@link AgentNode}s rooted at a single central
 * agent. Groupings (departments and sub-teams) are modeled as {@link Team}s for
 * visualization and coordination. Work is expressed as a dependency DAG of
 * subtasks produced by each node's planning step.
 */

/** Where a node sits in the org. */
export type AgentRole = 'central' | 'lead' | 'worker';

/** Lifecycle of a single node. */
export type NodeStatus =
  | 'pending' // created, not yet scheduled
  | 'blocked' // waiting on dependency tasks to finish
  | 'planning' // deciding whether to delegate or execute
  | 'delegating' // spawned children, waiting on them
  | 'working' // executing leaf work (LLM + tools)
  | 'aggregating' // synthesizing children's results
  | 'done'
  | 'failed';

/** sync = serialized w.r.t. other sync siblings; async = may run in parallel. */
export type TaskMode = 'sync' | 'async';

/** A node in the agent org tree. */
export interface AgentNode {
  id: string;
  /** Human-friendly label, e.g. "Research Dept" or "Worker · web-scrape". */
  name: string;
  role: AgentRole;
  /** 0 = central. */
  depth: number;
  parentId: string | null;
  /** Team (department / sub-team) this node belongs to. */
  teamId: string | null;
  /** The mission/task this node is responsible for. */
  mission: string;
  status: NodeStatus;
  childrenIds: string[];
  /** Final synthesized text produced by this node. */
  result?: string;
  error?: string;
  /** How this node behaves relative to its siblings. */
  mode: TaskMode;
  /** Sibling node ids that must finish before this one starts. */
  dependsOn: string[];
  /** Non-blocking peers this node chose to coordinate with. */
  collaboratesWith: string[];
  /** Extra coordination context shown to this node in its execution prompt. */
  collaborationNotes?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  tokensUsed: number;
  toolCalls: number;
  /** How many times this node was re-run after an error. */
  retries: number;
  /** How many times this node was sent back for rework after a failed review. */
  reworks: number;
}

/** A department or sub-team — a grouping headed by a lead node. */
export interface Team {
  id: string;
  name: string;
  mission: string;
  /** The lead {@link AgentNode} id that heads this team. */
  leadId: string;
  parentTeamId: string | null;
  /** Other team ids whose output this team depends on. */
  dependsOn: string[];
  /** Stable color for visualization. */
  color: string;
  depth: number;
}

/** A short-lived collaboration edge between two agents or department leads. */
export interface CollaborationLink {
  id: string;
  from: string;
  to: string;
  /** Human-readable reason or shared topic for the collaboration. */
  reason: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * The structured plan a node returns when asked to decompose its mission.
 * `execute` => do the work itself (leaf). `delegate` => spawn the children.
 */
export interface DecompositionPlan {
  reasoning: string;
  strategy: 'execute' | 'delegate';
  subtasks: SubtaskSpec[];
}

export interface SubtaskSpec {
  /** Short label for the child unit/worker. */
  name: string;
  /** Self-contained mission for the child. */
  mission: string;
  /** `team` => the child may further decompose; `worker` => leaf executor. */
  kind: 'team' | 'worker';
  mode: TaskMode;
  /** Indices into the sibling subtasks array that must finish first. */
  dependsOn: number[];
  /** Indices of sibling subtasks this unit should coordinate with without blocking on them. */
  collaborateWith: number[];
}

/** Result returned by a node after it finishes (success or failure). */
export interface NodeResult {
  nodeId: string;
  ok: boolean;
  text: string;
  error?: string;
}

/** One prior exchange in a multi-turn conversation with the central agent. */
export interface ConversationTurn {
  task: string;
  result: string;
}

/** A full snapshot of a run's graph — what the visualization renders. */
export interface RunSnapshot {
  runId: string;
  task: string;
  status: 'running' | 'done' | 'failed';
  rootId: string | null;
  nodes: AgentNode[];
  teams: Team[];
  collaborations: CollaborationLink[];
  finalResult?: string;
  startedAt: number;
  finishedAt?: number;
  totals: {
    nodes: number;
    tokens: number;
    toolCalls: number;
  };
}
