/**
 * CLI demo: spins up an org for a task and prints a live feed + the org tree.
 *
 *   THANATOS_LLM_MODE=mock npm run demo            # offline, deterministic
 *   npm run demo -- "Design a tiny URL shortener"  # live, against the model
 */
import { loadConfig } from './config.js';
import type { ThanatosEvent } from './events.js';
import { Orchestrator } from './orchestrator.js';
import type { AgentNode, RunSnapshot } from './types.js';

const STATUS_ICON: Record<string, string> = {
  pending: '·',
  blocked: '⏸',
  planning: '◔',
  delegating: '◑',
  working: '◕',
  aggregating: '◗',
  done: '✓',
  failed: '✗',
};

function logEvent(e: ThanatosEvent): void {
  switch (e.type) {
    case 'node:created':
      console.log(`  + [${e.node.role}] ${e.node.name}  (depth ${e.node.depth})`);
      break;
    case 'log':
      if (e.level !== 'debug') console.log(`  · (${e.scope}) ${e.message}`);
      break;
    case 'tool:call':
      console.log(`  🔧 ${e.tool} ${e.ok ? 'ok' : 'ERR'} :: ${e.preview}`);
      break;
    case 'run:finished':
      console.log(`\n=== run ${e.status} — ${e.totals.nodes} agents, ${e.totals.tokens} tokens ===`);
      break;
    default:
      break;
  }
}

function printTree(snap: RunSnapshot): void {
  const byId = new Map(snap.nodes.map((n) => [n.id, n] as const));
  const childrenOf = (id: string | null) => snap.nodes.filter((n) => n.parentId === id);
  const walk = (node: AgentNode, prefix: string): void => {
    const icon = STATUS_ICON[node.status] ?? '?';
    const deps = node.dependsOn.map((d) => byId.get(d)?.name).filter(Boolean);
    const depStr = deps.length ? `  ⟸ ${deps.join(', ')}` : '';
    console.log(`${prefix}${icon} ${node.name} [${node.role}/${node.mode}]${depStr}`);
    for (const child of childrenOf(node.id)) walk(child, `${prefix}   `);
  };
  console.log('\n── Org chart ──');
  const root = snap.rootId ? byId.get(snap.rootId) : undefined;
  if (root) walk(root, '');
}

async function main(): Promise<void> {
  const task =
    process.argv.slice(2).join(' ').trim() ||
    'Produce a concise market-entry brief for a new privacy-first note-taking app: positioning, 3 target segments, a pricing model, and the top 5 risks.';

  const cfg = loadConfig();
  console.log(`Thanatos demo — mode=${cfg.llmMode}, model=${cfg.model}, maxAgents=${cfg.maxAgents}`);
  console.log(`Task: ${task}\n`);

  const orchestrator = new Orchestrator({ cfg });
  orchestrator.bus.subscribe(logEvent);

  const snapshot = await orchestrator.run({ task, maxDepth: 3, maxFanout: 4 });

  printTree(snapshot);
  console.log('\n── Final result ──\n');
  console.log(snapshot.finalResult ?? '(none)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
