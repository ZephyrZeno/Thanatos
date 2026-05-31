import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import type { ThanatosConfig } from './config.js';
import type { EventBus } from './events.js';
import type { ToolSchema } from './llm.js';
import { truncate } from './util.js';

export interface ToolContext {
  runId: string;
  nodeId: string;
  bus: EventBus;
  cfg: ThanatosConfig;
  /** Per-run ephemeral sandbox for scratch file tools. */
  scratchDir: string;
  /** Per-project durable workspace directory for workspace tools. */
  workspaceDir: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export interface ToolInvocation {
  ok: boolean;
  output: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** OpenAI-style tool schemas for function-calling. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async invoke(name: string, argsJson: string, ctx: ToolContext): Promise<ToolInvocation> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Unknown tool "${name}".` };
    }
    let args: Record<string, unknown> = {};
    try {
      args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
    } catch {
      return { ok: false, output: `Invalid JSON arguments for "${name}": ${truncate(argsJson, 120)}` };
    }
    try {
      const output = await tool.run(args, ctx);
      ctx.bus.emit({
        type: 'tool:call',
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        tool: name,
        args: truncate(JSON.stringify(args), 200),
        ok: true,
        preview: truncate(output, 200),
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.bus.emit({
        type: 'tool:call',
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        tool: name,
        args: truncate(argsJson, 200),
        ok: false,
        preview: message,
      });
      return { ok: false, output: `Tool "${name}" failed: ${message}` };
    }
  }
}

function resolveInDir(baseDir: string, p: string, label: string): string {
  const abs = isAbsolute(p) ? p : resolve(baseDir, p);
  const rel = relative(baseDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes the ${label} sandbox`);
  }
  return abs;
}

function workspaceRoot(cfg: ThanatosConfig): string {
  return isAbsolute(cfg.workspaceDir) ? cfg.workspaceDir : resolve(process.cwd(), cfg.workspaceDir);
}

/** Sanitize a project/conversation id into a safe folder name. */
export function sanitizeProjectId(id: string): string {
  const clean = (id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return clean || 'default';
}

/** Per-project subdirectory of the workspace, e.g. workspace/<projectId>. */
export function resolveProjectWorkspace(cfg: ThanatosConfig, projectId: string): string {
  return resolve(workspaceRoot(cfg), sanitizeProjectId(projectId));
}

export async function listWorkspaceDir(root: string): Promise<WorkspaceEntry[]> {
  return listFilesRecursive(root, root, 0);
}

export function resolvePathInWorkspaceDir(root: string, p: string): string {
  return resolveInDir(root, p, 'workspace');
}

interface WorkspaceEntry {
  path: string;
  size: number;
}

async function listFilesRecursive(dir: string, root: string, depth: number): Promise<WorkspaceEntry[]> {
  const out: WorkspaceEntry[] = [];
  if (depth > 6) return out;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const abs = resolve(dir, name);
    const s = await stat(abs);
    if (s.isDirectory()) {
      out.push(...(await listFilesRecursive(abs, root, depth + 1)));
    } else if (s.isFile()) {
      out.push({ path: relative(root, abs).split(sep).join('/'), size: s.size });
    }
  }
  return out;
}

function execPython(bin: string, file: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, [file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`python timed out after ${timeoutMs}ms`));
      const out = truncate(stdout.trim(), 4000);
      if (code !== 0) {
        resolvePromise(`exit ${code}\nstdout:\n${out}\nstderr:\n${truncate(stderr.trim(), 2000)}`);
      } else {
        resolvePromise(out || '(no stdout)');
      }
    });
  });
}

export const pythonTool: Tool = {
  name: 'run_python',
  description:
    'Execute a Python 3 snippet for calculation, data wrangling, or simulation. ' +
    'Print results to stdout — only stdout/stderr are returned.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'Python 3 source. Use print() for any output you need back.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (!ctx.cfg.enablePythonTool) return 'The Python tool is disabled by configuration.';
    const code = String(args.code ?? '');
    if (!code.trim()) return 'No code provided.';
    await mkdir(ctx.scratchDir, { recursive: true });
    const file = resolve(ctx.scratchDir, `snippet_${ctx.nodeId}_${Date.now()}.py`);
    await writeFile(file, code, 'utf8');
    return execPython(ctx.cfg.pythonBin, file, 30_000);
  },
};

/** Force-kill a process and its whole subtree (so a detached gradle daemon dies too). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* ignore */
  }
}

function execShell(command: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // POSIX: own process group so killTree can take down the whole subtree.
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(text);
    };
    const timer = setTimeout(() => {
      // Kill the whole tree AND force-resolve immediately. We do NOT wait for
      // 'close': a detached child (e.g. a gradle daemon) can keep the stdout
      // pipe open, which would otherwise hang this promise forever.
      killTree(child.pid);
      const out = truncate(stdout.trim(), 6000);
      const errPart = stderr.trim() ? `\nstderr:\n${truncate(stderr.trim(), 3000)}` : '';
      finish(
        `(命令超时：${Math.round(timeoutMs / 1000)}s 内未结束，已强制终止整个进程树)\nstdout:\n${out || '(none)'}${errPart}`,
      );
    }, timeoutMs);

    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => finish(`命令启动失败：${err instanceof Error ? err.message : String(err)}`));
    child.on('close', (code) => {
      const out = truncate(stdout.trim(), 6000);
      const errPart = stderr.trim() ? `\nstderr:\n${truncate(stderr.trim(), 3000)}` : '';
      finish(`exit ${code}\nstdout:\n${out || '(none)'}${errPart}`);
    });
  });
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command inside the workspace directory: install dependencies, build, package/zip, run tests, lint, run a script, etc. Returns the exit code plus stdout/stderr. Use this for any build/test/packaging or CLI step. For Gradle/long builds pass --no-daemon (e.g. "./gradlew --no-daemon build") so no background daemon is left running; builds are killed if they exceed 10 minutes.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Full shell command line, e.g. "./gradlew --no-daemon build", "npm install", "python -m pytest -q".',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (!ctx.cfg.enableShellTool) return 'The command tool is disabled by configuration.';
    const command = String(args.command ?? '').trim();
    if (!command) return 'No command provided.';
    await mkdir(ctx.workspaceDir, { recursive: true });
    return execShell(command, ctx.workspaceDir, 600_000);
  },
};

function spawnCapture(command: string, cwd: string, timeoutMs = 8000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      resolvePromise({ code: null, out: buf });
    }, timeoutMs);
    child.stdout?.on('data', (d) => (buf += d.toString()));
    child.stderr?.on('data', (d) => (buf += d.toString()));
    child.on('error', () => {
      if (settled) return;
      clearTimeout(timer);
      resolvePromise({ code: -1, out: buf });
    });
    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      resolvePromise({ code, out: buf });
    });
  });
}

export const detectEnvironmentTool: Tool = {
  name: 'detect_environment',
  description:
    'Detect the local toolchain (Java/JDK, git, Gradle, Maven, Node, Python) and the system proxy, then AUTO-APPLY the proxy + JAVA_HOME so subsequent run_command/git calls inherit them. Call this FIRST before cloning a repo or building.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    if (!ctx.cfg.enableShellTool) return 'detect_environment 需要 shell 工具，但它被配置禁用了。';
    const cwd = ctx.workspaceDir;
    await mkdir(cwd, { recursive: true });
    const win = process.platform === 'win32';
    const firstLine = (s: string) => (s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim();

    const probes: Record<string, string> = {
      java: 'java -version',
      javac: 'javac -version',
      git: 'git --version',
      gradle: 'gradle -v',
      maven: 'mvn -v',
      node: 'node -v',
      python: `${ctx.cfg.pythonBin} --version`,
    };
    const results: Record<string, string> = {};
    await Promise.all(
      Object.entries(probes).map(async ([k, cmd]) => {
        const r = await spawnCapture(cmd, cwd);
        results[k] = r.code === 0 ? firstLine(r.out) || 'ok' : '未找到';
      }),
    );

    const actions: string[] = [];
    const whereJava = await spawnCapture(win ? 'where java' : 'which java', cwd);
    const javaPath = whereJava.code === 0 ? firstLine(whereJava.out) : '';
    if (javaPath && !process.env.JAVA_HOME) {
      const home = dirname(dirname(javaPath));
      process.env.JAVA_HOME = home;
      actions.push(`已设置 JAVA_HOME=${home}`);
    }

    let proxy =
      process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
    if (!proxy && win) {
      const reg = await spawnCapture(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
        cwd,
      );
      const en = await spawnCapture(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        cwd,
      );
      const ps = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(reg.out)?.[1];
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(en.out)?.[1];
      if (ps && enabled && Number.parseInt(enabled, 16) === 1) proxy = ps.includes('://') ? ps : `http://${ps}`;
    }
    if (!proxy && win) {
      const ns = await spawnCapture('netsh winhttp show proxy', cwd);
      const m = /Proxy Server\(s\)\s*:\s*(\S+)/i.exec(ns.out)?.[1];
      if (m && !/Direct access/i.test(ns.out)) proxy = m.includes('://') ? m : `http://${m}`;
    }
    if (proxy) {
      process.env.HTTP_PROXY = proxy;
      process.env.HTTPS_PROXY = proxy;
      process.env.http_proxy = proxy;
      process.env.https_proxy = proxy;
      // Also configure git so clones over https use the proxy.
      await spawnCapture(`git config --global http.proxy ${proxy}`, cwd);
      await spawnCapture(`git config --global https.proxy ${proxy}`, cwd);
      actions.push(`已应用代理 ${proxy}（已写入环境变量并配置 git http(s).proxy，run_command/git clone 都走此代理）`);
    } else {
      actions.push('未检测到系统代理（直连）');
    }

    return [
      '## 本机环境检测',
      `- Java: ${results.java}`,
      `- JDK(javac): ${results.javac}`,
      `- JAVA_HOME: ${process.env.JAVA_HOME ?? '(未设置)'}`,
      `- java 路径: ${javaPath || '未找到'}`,
      `- git: ${results.git}`,
      `- Gradle: ${results.gradle}`,
      `- Maven: ${results.maven}`,
      `- Node: ${results.node}`,
      `- Python: ${results.python}`,
      `- 平台: ${process.platform}`,
      '',
      '已执行：',
      ...actions.map((a) => `- ${a}`),
    ].join('\n');
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write a UTF-8 text file inside the run scratch directory (creates parent dirs).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the scratch sandbox.' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const abs = resolveInDir(ctx.scratchDir, String(args.path ?? ''), 'scratch');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, String(args.content ?? ''), 'utf8');
    return `Wrote ${Buffer.byteLength(String(args.content ?? ''))} bytes to ${args.path}.`;
  },
};

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read a UTF-8 text file from the run scratch directory.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Relative path within the scratch sandbox.' } },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const abs = resolveInDir(ctx.scratchDir, String(args.path ?? ''), 'scratch');
    const content = await readFile(abs, 'utf8');
    return truncate(content, 4000);
  },
};

/**
 * Files that have been read (by abs path) — used to enforce read-before-edit,
 * the way Claude Code's editor errors unless you Read the file first. Marking
 * on write/edit too means the FIRST touch of a pre-existing file must read it,
 * but subsequent iterative edits don't re-require a read.
 */
const readFilesForEdit = new Set<string>();

export const workspaceWriteTool: Tool = {
  name: 'workspace_write_file',
  description:
    'Create or overwrite a file in the shared workspace. PREFER editing an existing source file (workspace_read_file then workspace_edit_file) over creating a new one. Do NOT create analysis / design / research / "report" markdown as your deliverable — write real code that builds and runs. Reserve new files for genuinely new source/config/tests.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace, e.g. "src/app.py".' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const abs = resolveInDir(ctx.workspaceDir, String(args.path ?? ''), 'workspace');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, String(args.content ?? ''), 'utf8');
    readFilesForEdit.add(abs);
    return `Wrote ${Buffer.byteLength(String(args.content ?? ''))} bytes to workspace/${args.path}.`;
  },
};

export const workspaceReadTool: Tool = {
  name: 'workspace_read_file',
  description: 'Read a text file from the shared workspace. Read a source file with this BEFORE editing it.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const abs = resolveInDir(ctx.workspaceDir, String(args.path ?? ''), 'workspace');
    const text = await readFile(abs, 'utf8');
    readFilesForEdit.add(abs);
    return truncate(text, 8000);
  },
};

export const workspaceEditTool: Tool = {
  name: 'workspace_edit_file',
  description:
    'Make a targeted edit to an EXISTING source file: replaces every occurrence of "find" with "replace" (use a unique-enough snippet). If "find" is empty, appends "replace". You MUST workspace_read_file the file first — editing a pre-existing file you have not read will be rejected (read before you change real code).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      find: { type: 'string', description: 'Exact text to replace; empty string to append.' },
      replace: { type: 'string' },
    },
    required: ['path', 'replace'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const abs = resolveInDir(ctx.workspaceDir, String(args.path ?? ''), 'workspace');
    const find = typeof args.find === 'string' ? args.find : '';
    const replace = String(args.replace ?? '');
    let current = '';
    let existed = false;
    try {
      current = await readFile(abs, 'utf8');
      existed = true;
    } catch {
      /* new file */
    }
    if (existed && !readFilesForEdit.has(abs)) {
      return `先读后改：请先用 workspace_read_file 读取 workspace/${args.path}，再编辑它（不要盲改未读过的源码）。`;
    }
    let next: string;
    let summary: string;
    if (find === '') {
      next = current + replace;
      summary = `Appended ${Buffer.byteLength(replace)} bytes`;
    } else {
      if (!current.includes(find)) return `No occurrence of the given text in workspace/${args.path}.`;
      const count = current.split(find).length - 1;
      next = current.split(find).join(replace);
      summary = `Replaced ${count} occurrence(s)`;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, next, 'utf8');
    readFilesForEdit.add(abs);
    return `${summary} in workspace/${args.path}.`;
  },
};

export const workspaceListTool: Tool = {
  name: 'workspace_list',
  description: 'List files in the shared workspace (recursive) with byte sizes.',
  parameters: {
    type: 'object',
    properties: { dir: { type: 'string', description: 'Optional sub-directory to list.' } },
    required: [],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const root = ctx.workspaceDir;
    const start = args.dir ? resolveInDir(root, String(args.dir), 'workspace') : root;
    const entries = await listFilesRecursive(start, root, 0);
    if (entries.length === 0) return 'Workspace is empty.';
    return entries
      .slice(0, 200)
      .map((e) => `${e.path} (${e.size}B)`)
      .join('\n');
  },
};

export const httpFetchTool: Tool = {
  name: 'http_fetch',
  description: 'HTTP GET a URL and return the response body as text (truncated).',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      max_chars: { type: 'number', description: 'Max characters to return (default 4000).' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async run(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
    const max = typeof args.max_chars === 'number' ? args.max_chars : 4000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      const text = await res.text();
      return `HTTP ${res.status}\n${truncate(text, max)}`;
    } finally {
      clearTimeout(timer);
    }
  },
};

function decodeHtml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripTags(input: string): string {
  return decodeHtml(input.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function normalizeDuckDuckGoUrl(href: string): string {
  const decoded = decodeHtml(href);
  try {
    const u = new URL(decoded, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : u.href;
  } catch {
    return decoded;
  }
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Search the public web and return concise result titles, URLs, and snippets. Use for current information, source discovery, docs, papers, GitHub issues, or background research before fetching specific pages.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      max_results: { type: 'number', description: 'Maximum results to return, 1-10. Default 6.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (!ctx.cfg.enableWebSearchTool) return 'The web_search tool is disabled by configuration.';
    const query = String(args.query ?? '').trim();
    if (!query) return 'No query provided.';
    const max = Math.max(1, Math.min(10, typeof args.max_results === 'number' ? Math.floor(args.max_results) : 6));
    const base = ctx.cfg.webSearchUrl || 'https://duckduckgo.com/html/';
    const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Thanatos/0.1 (+https://localhost)' },
      });
      const html = await res.text();
      const blocks = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/gi)];
      const results = blocks.slice(0, max).map((m, i) => ({
        rank: i + 1,
        title: stripTags(m[2] ?? ''),
        url: normalizeDuckDuckGoUrl(m[1] ?? ''),
        snippet: stripTags(m[3] ?? m[4] ?? ''),
      }));
      if (results.length === 0) {
        return `Search completed but no structured results were parsed for "${query}". Fetch URL: ${url}`;
      }
      return results.map((r) => `${r.rank}. ${r.title}\n${r.url}\n${r.snippet}`).join('\n\n');
    } finally {
      clearTimeout(timer);
    }
  },
};

/** List + read helpers the server reuses to expose the workspace to the UI. */
export function resolveWorkspaceRoot(cfg: ThanatosConfig): string {
  return workspaceRoot(cfg);
}

export async function listWorkspace(cfg: ThanatosConfig): Promise<WorkspaceEntry[]> {
  const root = workspaceRoot(cfg);
  return listFilesRecursive(root, root, 0);
}

export function resolveWorkspacePath(cfg: ThanatosConfig, p: string): string {
  return resolveInDir(workspaceRoot(cfg), p, 'workspace');
}

/** Default tool registry derived from config (Python tool is gated by env). */
export function defaultToolRegistry(cfg: ThanatosConfig): ToolRegistry {
  const registry = new ToolRegistry();
  if (cfg.enablePythonTool) registry.register(pythonTool);
  if (cfg.enableShellTool) registry.register(runCommandTool);
  if (cfg.enableShellTool) registry.register(detectEnvironmentTool);
  if (cfg.enableWebSearchTool) registry.register(webSearchTool);
  registry.register(writeFileTool);
  registry.register(readFileTool);
  registry.register(httpFetchTool);
  registry.register(workspaceWriteTool);
  registry.register(workspaceReadTool);
  registry.register(workspaceEditTool);
  registry.register(workspaceListTool);
  return registry;
}
