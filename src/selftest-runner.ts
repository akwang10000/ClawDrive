import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { getOutputChannel, logError } from "./logger";
import type { AgentRouteService } from "./routing/service";
import type { TaskService } from "./tasks/service";
import type { AgentRouteResponse } from "./routing/types";
import type { TaskExecutionHealth, TaskResultPayload, TaskSnapshot, TaskState } from "./tasks/types";

interface SelftestCase {
  name: string;
  prompt: string;
  autoResolve?: boolean;
}

interface SelftestApplyProgress {
  observedStates: TaskState[];
  runningSnapshotSeen: boolean;
  providerEvidenceDuringRunning: boolean;
  decisionSeen: boolean;
  approvalSeen: boolean;
  finalState: TaskState | null;
  finalExecutionHealth: TaskExecutionHealth | null;
}

interface SelftestCaseResult {
  name: string;
  prompt: string;
  route: AgentRouteResponse | null;
  taskId: string | null;
  snapshot: TaskSnapshot | null;
  result: TaskResultPayload | null;
  applyProgress: SelftestApplyProgress | null;
  error: string | null;
}

interface SelftestReport {
  startedAt: string;
  finishedAt: string;
  workspacePath: string | null;
  summary: SelftestReportSummary;
  cases: SelftestCaseResult[];
}

interface SelftestReportSummary {
  total: number;
  passed: number;
  warnings: number;
  failed: number;
  pending: number;
}

const DEFAULT_CASES: SelftestCase[] = [
  { name: "inspect", prompt: "列出 src 目录" },
  { name: "analyze", prompt: "解释这个仓库做什么" },
  { name: "plan", prompt: "给我两个方案，先别改" },
  { name: "plan_complex", prompt: "给我三个可行方案，说明影响范围和主要风险，先别改" },
  { name: "apply", prompt: "先给出一个最小改动方案供我确认；确认后再执行，不要直接结束。", autoResolve: true },
];

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

export async function runSelftest(routeService: AgentRouteService, taskService: TaskService): Promise<void> {
  const output = getOutputChannel();
  output.show(true);
  output.appendLine("");
  output.appendLine("ClawDrive selftest started.");

  const startedAt = new Date().toISOString();
  const cases = await runCases(routeService, taskService);
  const report: SelftestReport = {
    startedAt,
    finishedAt: new Date().toISOString(),
    workspacePath: getWorkspaceRoot(),
    summary: buildSummary(cases),
    cases,
  };
  const reportPath = await writeReport(report);

  output.appendLine("");
  output.appendLine("Selftest summary:");
  output.appendLine(
    `- total: ${report.summary.total}, passed: ${report.summary.passed}, warnings: ${report.summary.warnings}, failed: ${report.summary.failed}, pending: ${report.summary.pending}`,
  );
  for (const entry of report.cases) {
    const line = formatCaseStatus(entry);
    output.appendLine(`- ${entry.name}: ${line}`);
  }
  output.appendLine(`Report: ${reportPath}`);
  await vscode.window.showInformationMessage("ClawDrive selftest finished. See output for details.");
}

async function runCases(routeService: AgentRouteService, taskService: TaskService): Promise<SelftestCaseResult[]> {
  const results: SelftestCaseResult[] = [];
  for (const entry of DEFAULT_CASES) {
    const caseResult: SelftestCaseResult = {
      name: entry.name,
      prompt: entry.prompt,
      route: null,
      taskId: null,
      snapshot: null,
      result: null,
      applyProgress: null,
      error: null,
    };
    try {
      const route = await routeService.route({ prompt: entry.prompt });
      caseResult.route = route;
      if (route.kind === "task" || route.kind === "task_result") {
        const taskId =
          (route.kind === "task" ? route.data?.taskId : route.data?.snapshot?.taskId) ?? null;
        if (taskId) {
          caseResult.taskId = taskId;
          const tracker = createApplyProgressTracker();
          let snapshot = await waitForTask(taskService, taskId, tracker);
          if (snapshot && entry.autoResolve) {
            snapshot = await resolvePendingTask(taskService, snapshot, tracker);
          }
          caseResult.snapshot = snapshot;
          caseResult.applyProgress = finalizeApplyProgress(tracker, snapshot);
          if (snapshot) {
            caseResult.result = await taskService.getTaskResult(taskId);
          }
        }
      }
    } catch (error) {
      caseResult.error = error instanceof Error ? error.message : String(error);
    }
    results.push(caseResult);
  }
  return results;
}

async function waitForTask(
  taskService: TaskService,
  taskId: string,
  tracker?: SelftestApplyProgress
): Promise<TaskSnapshot | null> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = taskService.getTask(taskId);
    recordApplyProgress(tracker, snapshot);
    if (snapshot.state !== "running" && snapshot.state !== "queued") {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

async function resolvePendingTask(
  taskService: TaskService,
  snapshot: TaskSnapshot,
  tracker?: SelftestApplyProgress
): Promise<TaskSnapshot> {
  let current = snapshot;
  const maxSteps = 2;
  for (let step = 0; step < maxSteps; step += 1) {
    recordApplyProgress(tracker, current);
    if (current.state === "waiting_decision") {
      const optionId =
        current.decision?.recommendedOptionId ?? current.decision?.options?.[0]?.id ?? undefined;
      current = await taskService.respondToTask({
        taskId: current.taskId,
        optionId,
        message: optionId ? undefined : "continue",
      });
      recordApplyProgress(tracker, current);
      current = (await waitForTask(taskService, current.taskId, tracker)) ?? current;
      continue;
    }
    if (current.state === "waiting_approval") {
      current = await taskService.respondToTask({
        taskId: current.taskId,
        approval: "approved",
      });
      recordApplyProgress(tracker, current);
      current = (await waitForTask(taskService, current.taskId, tracker)) ?? current;
      continue;
    }
    break;
  }
  recordApplyProgress(tracker, current);
  return current;
}

function createApplyProgressTracker(): SelftestApplyProgress {
  return {
    observedStates: [],
    runningSnapshotSeen: false,
    providerEvidenceDuringRunning: false,
    decisionSeen: false,
    approvalSeen: false,
    finalState: null,
    finalExecutionHealth: null,
  };
}

function recordApplyProgress(tracker: SelftestApplyProgress | undefined, snapshot: TaskSnapshot | null): void {
  if (!tracker || !snapshot) {
    return;
  }
  if (tracker.observedStates.at(-1) !== snapshot.state) {
    tracker.observedStates.push(snapshot.state);
  }
  if (snapshot.state === "running") {
    tracker.runningSnapshotSeen = true;
    if (snapshot.providerEvidence) {
      tracker.providerEvidenceDuringRunning = true;
    }
  }
  if (snapshot.decision) {
    tracker.decisionSeen = true;
  }
  if (snapshot.approval) {
    tracker.approvalSeen = true;
  }
  tracker.finalState = snapshot.state;
  tracker.finalExecutionHealth = snapshot.executionHealth;
}

function finalizeApplyProgress(
  tracker: SelftestApplyProgress,
  snapshot: TaskSnapshot | null
): SelftestApplyProgress | null {
  if (tracker.observedStates.length === 0 && !snapshot) {
    return null;
  }
  if (snapshot) {
    recordApplyProgress(tracker, snapshot);
  }
  return tracker;
}

function getWorkspaceRoot(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
}

function buildSummary(cases: SelftestCaseResult[]): SelftestReportSummary {
  const summary: SelftestReportSummary = {
    total: cases.length,
    passed: 0,
    warnings: 0,
    failed: 0,
    pending: 0,
  };
  for (const entry of cases) {
    const status = classifyCase(entry);
    if (status === "passed") {
      summary.passed += 1;
    } else if (status === "warning") {
      summary.warnings += 1;
    } else if (status === "failed") {
      summary.failed += 1;
    } else {
      summary.pending += 1;
    }
  }
  return summary;
}

function classifyCase(entry: SelftestCaseResult): "passed" | "warning" | "failed" | "pending" {
  if (entry.error) {
    return "failed";
  }
  const snapshot = entry.snapshot;
  if (!snapshot) {
    if (entry.route?.kind === "direct_result") {
      return "passed";
    }
    return "pending";
  }
  if (snapshot.state === "failed" || snapshot.state === "cancelled" || snapshot.state === "interrupted") {
    return "failed";
  }
  if (snapshot.state === "waiting_decision" || snapshot.state === "waiting_approval") {
    return "pending";
  }
  if (snapshot.state === "completed") {
    if (snapshot.executionHealth === "warning" || snapshot.executionHealth === "degraded") {
      return "warning";
    }
    return "passed";
  }
  return "pending";
}

function formatCaseStatus(entry: SelftestCaseResult): string {
  if (entry.error) {
    return `failed (${entry.error})`;
  }
  const snapshot = entry.snapshot;
  if (!snapshot) {
    return entry.route?.kind ?? "pending";
  }
  if (entry.name === "apply" && entry.applyProgress) {
    return formatApplyProgress(entry.applyProgress);
  }
  const health = snapshot.executionHealth ?? "clean";
  if (snapshot.state === "completed") {
    return health === "clean" ? "completed" : `completed (${health})`;
  }
  return snapshot.state;
}

function formatApplyProgress(progress: SelftestApplyProgress): string {
  const parts = [`states=${progress.observedStates.join("->") || "none"}`];
  parts.push(`running=${progress.runningSnapshotSeen ? "yes" : "no"}`);
  parts.push(`evidence@running=${progress.providerEvidenceDuringRunning ? "yes" : "no"}`);
  parts.push(`decision=${progress.decisionSeen ? "yes" : "no"}`);
  parts.push(`approval=${progress.approvalSeen ? "yes" : "no"}`);
  if (progress.finalState) {
    const healthSuffix = progress.finalExecutionHealth ? `/${progress.finalExecutionHealth}` : "";
    parts.push(`final=${progress.finalState}${healthSuffix}`);
  }
  return parts.join(", ");
}

async function writeReport(report: SelftestReport): Promise<string> {
  const root = getWorkspaceRoot();
  const outputPath = root
    ? path.join(root, "selftest-report.json")
    : path.join(process.env.TEMP ?? process.cwd(), "selftest-report.json");
  try {
    await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  } catch (error) {
    logError(`Failed to write selftest report: ${error instanceof Error ? error.message : String(error)}`);
  }
  return outputPath;
}
