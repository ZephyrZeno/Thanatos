import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this file to find the repo root `.env` (works from dist or src). */
function findEnvFile(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

loadDotenv({ path: findEnvFile() });

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export type LlmMode = 'live' | 'mock';

export interface ThanatosConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  maxConcurrency: number;
  requestTimeoutMs: number;
  /** Per-request retry attempts inside the LLM client. */
  maxRetries: number;
  maxAgents: number;
  llmMode: LlmMode;
  port: number;
  enablePythonTool: boolean;
  pythonBin: string;
  /** Allow agents to run arbitrary shell commands (build/test/package) in the workspace. */
  enableShellTool: boolean;
  /** Persistent shared directory agents create/edit/read durable files in. */
  workspaceDir: string;
  /** How many times the orchestrator re-runs a whole node that errored out. */
  maxNodeRetries: number;
  /** Base backoff (ms) between node retries; grows exponentially with jitter. */
  nodeRetryBaseMs: number;
  /** Soft token budget for a run; 0 = unlimited. Past it, new agents are short-circuited. */
  maxRunTokens: number;
  /** Mock-only: probability [0,1] that a call throws, to exercise retry paths. */
  mockFailRate: number;
  /** Max assistant/tool exchange loops before a leaf is considered incomplete. */
  maxToolIterations: number;
  /** Allow agents to use the built-in web search helper when MCP search is absent. */
  enableWebSearchTool: boolean;
  /** Search endpoint. The default DuckDuckGo Lite endpoint does not need a key. */
  webSearchUrl: string;
  /** Review each result and send it back for rework if it fails. */
  enableReview: boolean;
  /** Max times a node is sent back for rework after a failed review. */
  maxReworks: number;
}

export function loadConfig(overrides: Partial<ThanatosConfig> = {}): ThanatosConfig {
  const llmModeRaw = str('THANATOS_LLM_MODE', 'live').toLowerCase();
  const base: ThanatosConfig = {
    apiBaseUrl: str('THANATOS_API_BASE_URL', 'https://api.openai.com/v1'),
    apiKey: str('THANATOS_API_KEY', ''),
    model: str('THANATOS_MODEL', 'gpt-5.5'),
    maxConcurrency: int('THANATOS_MAX_CONCURRENCY', 8),
    requestTimeoutMs: int('THANATOS_REQUEST_TIMEOUT_MS', 120_000),
    maxRetries: int('THANATOS_MAX_RETRIES', 5),
    maxAgents: int('THANATOS_MAX_AGENTS', 1200),
    llmMode: llmModeRaw === 'mock' ? 'mock' : 'live',
    port: int('THANATOS_PORT', 8787),
    enablePythonTool: bool('THANATOS_ENABLE_PYTHON_TOOL', true),
    pythonBin: str('PYTHON_BIN', 'python'),
    enableShellTool: bool('THANATOS_ENABLE_SHELL_TOOL', true),
    workspaceDir: str('THANATOS_WORKSPACE_DIR', './workspace'),
    maxNodeRetries: int('THANATOS_MAX_NODE_RETRIES', 5),
    nodeRetryBaseMs: int('THANATOS_NODE_RETRY_BASE_MS', 1500),
    maxRunTokens: int('THANATOS_MAX_RUN_TOKENS', 0),
    mockFailRate: Number.parseFloat(str('THANATOS_MOCK_FAIL_RATE', '0')) || 0,
    maxToolIterations: int('THANATOS_MAX_TOOL_ITERATIONS', 12),
    enableWebSearchTool: bool('THANATOS_ENABLE_WEB_SEARCH_TOOL', true),
    webSearchUrl: str('THANATOS_WEB_SEARCH_URL', 'https://duckduckgo.com/html/'),
    enableReview: bool('THANATOS_ENABLE_REVIEW', true),
    maxReworks: int('THANATOS_MAX_REWORKS', 1),
  };
  return { ...base, ...overrides };
}

export const config = loadConfig();
