import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool, ToolRegistry } from './tools.js';
import { truncate } from './util.js';

/** A single external MCP server launched over stdio. */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

export interface McpConnection {
  servers: string[];
  toolNames: string[];
  close(): Promise<void>;
}

export type McpLogger = (message: string) => void;

/** Resolve the MCP config path (env override, else repo-root mcp.config.json). */
export function findMcpConfigPath(): string {
  const fromEnv = process.env.THANATOS_MCP_CONFIG;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(process.cwd(), 'mcp.config.json');
}

export async function loadMcpConfig(path = findMcpConfigPath()): Promise<McpConfig> {
  if (!existsSync(path)) return { servers: {} };
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<McpConfig>;
    return { servers: parsed.servers ?? {} };
  } catch {
    return { servers: {} };
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function extractText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((c): c is { type: 'text'; text: string } => (c as { type?: string })?.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return truncate(text || JSON.stringify(content), 6000);
  }
  return truncate(JSON.stringify(result ?? null), 6000);
}

/**
 * Connect to each configured MCP server, discover its tools, and register them
 * into the shared {@link ToolRegistry} so agents can auto-select them via
 * function-calling. Failures are logged and skipped — one broken server never
 * blocks startup.
 */
export async function connectMcpServers(
  config: McpConfig,
  registry: ToolRegistry,
  log: McpLogger = () => {},
): Promise<McpConnection> {
  const clients: Client[] = [];
  const servers: string[] = [];
  const toolNames: string[] = [];

  for (const [serverName, sc] of Object.entries(config.servers ?? {})) {
    if (sc.disabled) continue;
    try {
      const transport = new StdioClientTransport({
        command: sc.command,
        args: sc.args ?? [],
        ...(sc.env ? { env: sc.env } : {}),
      });
      const client = new Client({ name: 'thanatos', version: '0.1.0' });
      await withTimeout(client.connect(transport), 30_000, `connect "${serverName}"`);

      const { tools } = await withTimeout(client.listTools(), 15_000, `listTools "${serverName}"`);
      for (const t of tools) {
        const toolName = `${sanitize(serverName)}__${sanitize(t.name)}`;
        const parameters =
          t.inputSchema && typeof t.inputSchema === 'object'
            ? (t.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} };
        const tool: Tool = {
          name: toolName,
          description: `[MCP:${serverName}] ${t.description ?? t.name}`.slice(0, 1000),
          parameters,
          async run(args) {
            const result = await client.callTool({ name: t.name, arguments: args });
            return extractText(result);
          },
        };
        registry.register(tool);
        toolNames.push(toolName);
      }

      clients.push(client);
      servers.push(serverName);
      log(`connected "${serverName}" — ${tools.length} tool(s)`);
    } catch (err) {
      log(`server "${serverName}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    servers,
    toolNames,
    async close() {
      for (const c of clients) {
        try {
          await c.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
