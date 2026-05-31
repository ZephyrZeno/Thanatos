import type { AgentNode } from './types.js';

export interface PlanContext {
  goal: string;
  node: AgentNode;
  /** Levels of delegation still permitted below this node. */
  remainingDepth: number;
  maxFanout: number;
  /** Approximate number of additional agents the run can still afford. */
  agentBudgetLeft: number;
  /** Prior conversation, shown only to the central agent. */
  conversation?: string;
  /** When true, the node must delegate and fan out to fill the org. */
  forceScale?: boolean;
}

/** Tier label for a node by its depth (the org's 5 levels). */
export function tierName(depth: number, role: AgentNode['role']): string {
  if (role === 'central') return '中心agent';
  if (role === 'worker') return '工人agent';
  if (depth === 1) return '指挥员';
  if (depth === 2) return '部门主管';
  if (depth === 3) return '小组组长';
  return '负责人';
}

function conversationBlock(node: AgentNode, conversation?: string): string {
  if (node.role !== 'central' || !conversation) return '';
  return `CONVERSATION SO FAR (earlier turns with this user — use for continuity):\n${conversation}\n\n`;
}

function collaborationBlock(node: AgentNode): string {
  if (!node.collaborationNotes) return '';
  return `COORDINATION CONTEXT:\n${node.collaborationNotes}\n\n`;
}

const ROLE_BLURB: Record<AgentNode['role'], string> = {
  central:
    'You are the CENTRAL agent of a large AI organization. You translate the user goal into an org chart of departments and coordinate the whole effort.',
  lead: 'You are a LEAD agent. You own a mission and either split it into a focused sub-team or do it yourself.',
  worker: 'You are a WORKER agent. You do concrete, hands-on work and may call tools.',
};

export function planMessages(ctx: PlanContext): { system: string; user: string } {
  const { node, goal, remainingDepth, maxFanout, agentBudgetLeft } = ctx;
  const mustExecute = remainingDepth <= 0 || agentBudgetLeft < 2 || node.role === 'worker';
  const forceDelegate = ctx.forceScale === true && !mustExecute;

  const system = [
    ROLE_BLURB[node.role],
    '',
    forceDelegate
      ? `SCALE MODE: lean toward DELEGATING and splitting work across multiple parallel units WHEN the mission genuinely has separable parts. BUT if the mission is atomic or quick — e.g. run one command, clone a repo, set a single config, write one small file — just EXECUTE it yourself. NEVER split trivial/handy work across multiple agents; that is wasteful. Only create as many sub-units as the work truly needs.`
      : '',
    'Decide whether to DELEGATE (split your mission across a team you create) or EXECUTE (do it yourself).',
    'Size the organization to the mission. A large, multi-part mission should be split into several units;',
    'a small, atomic mission should just be executed.',
    'Use kind:"team" for any sub-area that itself contains multiple parts — it will recursively split into',
    'sub-teams and workers. Use kind:"worker" ONLY for an atomic piece a single agent can finish alone.',
    'For a large project, build a real multi-level organization (departments → sub-teams → workers);',
    'do NOT collapse a big area (e.g. "implementation" or "tests") into one worker — make it a team that splits further.',
    'PARALLELISM: default every subtask to mode:"async" so independent units run at the same time.',
    'Only set mode:"sync" or add dependsOn when a unit genuinely needs another unit\'s output first.',
    'Maximize concurrency — never serialize work that could run in parallel.',
    'COOPERATION: use collaborateWith for non-blocking peer collaboration. A unit may collaborate with sibling departments/workers',
    'when sharing findings, interfaces, assumptions, test results, or research notes would improve quality. Collaborations do NOT',
    'block execution; use dependsOn only for true ordering. Prefer explicit collaboration over isolated work on broad missions.',
    'LANGUAGE: write every "name" and "mission" in the SAME LANGUAGE as the OVERALL GOAL below.',
    'STAY ON TOPIC: every subtask must serve the OVERALL GOAL\'s EXACT subject. Never switch to a different problem, system, or example.',
    'NEVER DELEGATE UNDERSTANDING: do not hand a child a vague topic and hope it figures things out. Each "mission" must be precise and immediately actionable — name the specific files / modules / subsystems to touch and the concrete code change or artifact expected. The child cannot see this conversation, so give it everything it needs to start coding right away.',
    'FOR SOFTWARE / DEVELOPMENT GOALS: create sub-units that each OWN specific source files or subsystems and write REAL code there, plus exactly ONE build/integration unit that runs the build & tests for everyone (so parallel coders never fight over the build). Do NOT create units whose only job is to write analysis/design/research documents — that is wasted work.',
    'PARALLEL-BUILD ISOLATION (when several units build the SAME repo at once): instruct each such unit to work in its own git worktree (e.g. `git worktree add ../wt-<unit> -b <unit>` via run_command) so their builds never collide, and have the integration unit merge those branches back. If only one unit builds, skip this.',
    '',
    'Reply with ONE JSON object, no prose, matching exactly:',
    '{',
    '  "reasoning": string,',
    '  "strategy": "delegate" | "execute",',
    '  "subtasks": [',
    '    {',
    '      "name": string,            // short unit/worker label',
    '      "mission": string,         // self-contained; the child cannot see this conversation',
    '      "kind": "team" | "worker", // team => may split further; worker => does the work directly',
    '      "mode": "sync" | "async",  // async => may run in parallel with async siblings; sync => runs after earlier sync siblings',
    '      "dependsOn": number[],     // indices of subtasks that must finish first (for cross-unit ordering)',
    '      "collaborateWith": number[] // indices of sibling subtasks to coordinate with while working',
    '    }',
    '  ]',
    '}',
    'If "strategy" is "execute", return "subtasks": [].',
    `Fan out into at most ${maxFanout} subtasks.`,
    mustExecute
      ? 'IMPORTANT: You have reached the delegation limit — you MUST choose "execute".'
      : `You may delegate ${remainingDepth} more level(s) deep.`,
  ].join('\n');

  const user = [
    conversationBlock(node, ctx.conversation) + collaborationBlock(node) + `OVERALL GOAL:\n${goal}`,
    '',
    `YOUR MISSION (${node.role}, depth ${node.depth}):\n${node.mission}`,
    '',
    node.role === 'central'
      ? 'Think in terms of departments (e.g. Research, Design, Implementation, Validation). Use dependsOn so dependent departments wait for their inputs, while independent ones run in parallel.'
      : 'Keep the team minimal and the missions crisp.',
  ].join('\n');

  return { system, user };
}

export function executeSystem(node: AgentNode, goal: string, conversation?: string): string {
  return [
    ROLE_BLURB[node.role],
    '',
    conversationBlock(node, conversation) + collaborationBlock(node) + `OVERALL GOAL (for context):\n${goal}`,
    '',
    `YOUR MISSION:\n${node.mission}`,
    '',
    'Accomplish the mission with REAL, WORKING OUTPUT — not a description of what could be done.',
    'TOOLS: run_command for builds/tests/CLI (runs inside the workspace, returns stdout/stderr); workspace_write_file / workspace_edit_file / workspace_read_file / workspace_list to create and revise REAL source files; run_python for calculations or benchmark data; web_search / http_fetch for lookups. For any build/toolchain task call detect_environment FIRST (it finds JDK/git/Gradle + proxy and applies them).',
    'IF YOUR MISSION IS TO DEVELOP / OPTIMIZE / FIX SOFTWARE: this is a hands-on coding job. Edit the ACTUAL source files in the workspace, then BUILD and run TESTS with run_command, READ the errors, FIX the code, and BUILD/TEST AGAIN. Repeat this develop → build → test → optimize → build → test loop until it compiles and tests pass, or you hit a concrete blocker you state plainly. Use as many run_command iterations as your budget allows — real iteration IS the job.',
    'LAND A SMALL CHANGE FIRST: never attempt a huge rewrite in one shot. Make the SMALLEST concrete edit that COMPILES, build it, confirm it is green, THEN iterate to expand. One real compiling change beats a grand, half-finished one — get to a green build early and often.',
    'BUILD THE SMALLEST RELEVANT TARGET, not the whole repo: compile/test a single module or a single test (e.g. `./gradlew --no-daemon :module:compileJava` or one test class) so each loop takes seconds, not many minutes. Run a full build only when integrating.',
    'DO NOT WRITE ANALYSIS / DESIGN / RESEARCH MARKDOWN AS YOUR DELIVERABLE. A long .md write-up with no working code and no real build/test output is a FAILURE and a waste of the run. Keep any notes terse and inline. Your value is WORKING CODE + REAL build/test results, not documents. Reuse source already present in the workspace — do NOT re-clone or re-analyze what is already there.',
    'EXECUTE, never just document: if the mission needs a command run (build, test, git), you MUST call run_command and report its REAL output. If it fails, fix the code and retry — never give up and write a doc instead.',
    'READ BEFORE YOU EDIT: to change existing code, workspace_read_file the file FIRST, then workspace_edit_file a small unique snippet. Prefer editing existing files over creating new ones (editing a pre-existing file you have not read is rejected).',
    'When you change a source file, mention its path. COLLABORATE BY EDITING THE SHARED CODE and reading teammates\' actual files — never by exchanging analysis documents. Any note to a peer is at most one or two concrete lines (an interface signature, a benchmark number).',
    'Respond in the SAME LANGUAGE as the OVERALL GOAL.',
    'STAY STRICTLY ON TOPIC: work only on the OVERALL GOAL\'s exact subject and the specific system it names. NEVER substitute a different example, model, or domain.',
    'Assume the user only sees your text, not your tool calls — but keep that text minimal: ≤1 short sentence between tool calls.',
    'FINISH with a SHORT report ONLY (≤120 words): which files you changed, the exact build/test command(s) you ran, and their REAL result (pass/fail + key numbers). No long prose, no essays, no design write-ups.',
    'Do not ask questions — make reasonable assumptions and deliver.',
  ].join('\n');
}

export function reviewMessages(
  node: AgentNode,
  goal: string,
  result: string,
): { system: string; user: string } {
  const system = [
    'You are a STRICT quality reviewer / red team for a hands-on engineering org. Judge whether a result is acceptable.',
    'Reject (pass=false) if ANY of these hold:',
    '- It drifts off the OVERALL GOAL\'s exact topic, or substitutes a different example/model/problem.',
    '- The mission was to develop/optimize/fix/build code, but the result shows NO real code change and NO real build/test output — i.e. it delivered analysis/design/research prose instead of working software. Writing documents in place of development is an AUTOMATIC FAIL (reason: "只写文档没真正开发/构建/测试").',
    '- It only describes/specs what should be done instead of actually doing it (promises code or tests but shows none).',
    '- It is empty, a stub, or fails the stated MISSION.',
    'Pass (true) only when the unit produced real, on-topic work: concrete code changes PLUS actual build/test results, or another genuinely executed artifact. A purely research mission may pass with real, specific findings. Be demanding but fair.',
    'Reply with ONE JSON object: {"pass": boolean, "reason": string (short, in the goal\'s language)}.',
  ].join('\n');
  const user = [
    `OVERALL GOAL:\n${goal}`,
    '',
    `MISSION UNDER REVIEW:\n${node.mission}`,
    '',
    `RESULT TO JUDGE:\n${result}`,
  ].join('\n');
  return { system, user };
}

export function aggregateMessages(
  node: AgentNode,
  goal: string,
  children: { name: string; ok: boolean; text: string }[],
  conversation?: string,
): { system: string; user: string } {
  const system = [
    ROLE_BLURB[node.role],
    '',
    'Your team has finished. Synthesize their outputs into a SINGLE coherent deliverable that fulfills your mission.',
    'Reconcile conflicts, remove duplication, and fill obvious gaps. Do not merely list what each member said.',
    'CRITICAL: stay strictly on the OVERALL GOAL\'s exact topic. Base the synthesis ONLY on the children\'s actual outputs below — NEVER invent or switch to a different example, model, or problem. If a child drifted off-topic, ignore that drift and pull back to the goal.',
    node.role === 'central'
      ? 'This is the final answer the user will see. Keep it SHORT and concrete: what was actually built/changed (key files), the build result, the test result, performance numbers if any, and the single next concrete step. NO long analysis prose and NO walls of design text — the user explicitly does NOT want a pile of reports.'
      : 'Return a clean, concise result your parent can build on — concrete outcomes and numbers, not essays.',
    'Write the result in the SAME LANGUAGE as the OVERALL GOAL.',
  ].join('\n');

  const body = children
    .map((c, i) => `### Sub-result ${i + 1} — ${c.name}${c.ok ? '' : ' (FAILED)'}\n${c.text}`)
    .join('\n\n');

  const user = [
    conversationBlock(node, conversation) + collaborationBlock(node) + `OVERALL GOAL:\n${goal}`,
    '',
    `YOUR MISSION:\n${node.mission}`,
    '',
    `TEAM OUTPUTS (${children.length}):`,
    body,
  ].join('\n');

  return { system, user };
}
