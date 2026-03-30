import { taskExecutionHealthLabel, taskStateLabel } from "./tasks/text";
import type { TaskSnapshot, TaskState } from "./tasks/types";

const dashboardTaskStateOrder: TaskState[] = [
  "queued",
  "running",
  "waiting_decision",
  "waiting_approval",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
];

const activeTaskStates = new Set<TaskState>([
  "queued",
  "running",
  "waiting_decision",
  "waiting_approval",
  "interrupted",
]);

const terminalTaskStates = new Set<TaskState>(["completed", "failed", "cancelled"]);

export interface DashboardTaskItem {
  taskId: string;
  title: string;
  state: TaskState;
  stateLabel: string;
  summary: string;
  executionHealth: TaskSnapshot["executionHealth"];
  executionHealthLabel: string;
  updatedAt: string;
  canCancel: boolean;
  canDelete: boolean;
}

export interface DashboardTaskCountEntry {
  state: TaskState;
  label: string;
  count: number;
}

export interface DashboardTaskCounts {
  total: number;
  visible: number;
  active: number;
  terminal: number;
  byState: DashboardTaskCountEntry[];
}

export function buildDashboardTaskSnapshot(
  tasks: TaskSnapshot[],
  limit = 20
): { taskCounts: DashboardTaskCounts; tasks: DashboardTaskItem[] } {
  const safeLimit = Math.max(1, limit);
  const sorted = [...tasks].sort(compareDashboardTasks);
  const visible = sorted.slice(0, safeLimit);

  return {
    taskCounts: {
      total: tasks.length,
      visible: visible.length,
      active: tasks.filter((task) => isActiveDashboardTaskState(task.state)).length,
      terminal: tasks.filter((task) => isTerminalDashboardTaskState(task.state)).length,
      byState: dashboardTaskStateOrder.map((state) => ({
        state,
        label: taskStateLabel(state),
        count: tasks.filter((task) => task.state === state).length,
      })),
    },
    tasks: visible.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      state: task.state,
      stateLabel: taskStateLabel(task.state),
      summary: task.summary,
      executionHealth: task.executionHealth,
      executionHealthLabel: taskExecutionHealthLabel(task.executionHealth),
      updatedAt: task.updatedAt,
      canCancel: isActiveDashboardTaskState(task.state),
      canDelete: isTerminalDashboardTaskState(task.state),
    })),
  };
}

export function isActiveDashboardTaskState(state: TaskState): boolean {
  return activeTaskStates.has(state);
}

export function isTerminalDashboardTaskState(state: TaskState): boolean {
  return terminalTaskStates.has(state);
}

function compareDashboardTasks(left: TaskSnapshot, right: TaskSnapshot): number {
  const leftRank = isActiveDashboardTaskState(left.state) ? 0 : 1;
  const rightRank = isActiveDashboardTaskState(right.state) ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return right.updatedAt.localeCompare(left.updatedAt);
}
