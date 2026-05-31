import type { AgentRole, NodeStatus, TaskMode } from './types';

export const STATUS_CN: Record<NodeStatus, string> = {
  pending: '待启动',
  blocked: '等待重试',
  planning: '规划中',
  delegating: '分派中',
  working: '执行中',
  aggregating: '汇总中',
  done: '完成',
  failed: '失败',
};

export const MODE_CN: Record<TaskMode, string> = {
  sync: '同步',
  async: '异步',
};

export const ROLE_CN: Record<AgentRole, string> = {
  central: '中心',
  lead: '组长',
  worker: '工人',
};

export const RUN_STATUS_CN: Record<string, string> = {
  idle: '空闲',
  running: '运行中',
  done: '完成',
  failed: '失败',
};

/** The org's 5 tiers, by depth + role. */
export function tierLabel(depth: number, role: AgentRole): string {
  if (role === 'central') return '中心agent';
  if (role === 'worker') return '工人agent';
  if (depth === 1) return '指挥员';
  if (depth === 2) return '部门主管';
  if (depth === 3) return '小组组长';
  return '负责人';
}
