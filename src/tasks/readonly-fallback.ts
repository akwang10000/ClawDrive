import { getCurrentLocale } from "../i18n";
import { inspectExtensionWiring, type ExtensionAuditResult } from "../routing/extension-audit";
import {
  inspectGroundedFiles,
  inspectGroundedRepository,
  type GroundedRepositorySummaryResult,
  type GroundedSummaryResult,
} from "../routing/grounded-summary";
import { inspectRuntimeFlow, type RuntimeFlowAuditResult } from "../routing/runtime-flow-audit";
import { createWorkspaceInspector } from "../routing/workspace-inspector";
import type { TaskDecisionOption, TaskMode, TaskRunResult } from "./types";

export interface ReadonlyTaskFallbackContext {
  mode: Extract<TaskMode, "analyze" | "plan">;
  prompt: string;
  paths: string[];
  workspacePath: string | null;
}

export function shouldAttemptReadonlyTaskFallback(
  context: { mode: TaskMode; prompt: string; paths: string[]; workspacePath: string | null }
): boolean {
  if (!context.workspacePath || context.mode === "apply") {
    return false;
  }
  if (context.mode === "analyze") {
    return true;
  }
  const prompt = context.prompt.toLowerCase();
  return (
    context.paths.length > 0 ||
    /\b(read-?only|analysis only|analyze only|analyse only|do not modify|don't modify|without modifying|without changing)\b/i.test(
      context.prompt
    ) ||
    /\b(repo|repository|project|workspace|module|entry point|routing|route|task pipeline|provider|debug|diagnos|read(?:ing)? order|top-level)\b/i.test(
      context.prompt
    ) ||
    /仓库|项目|工作区|模块|入口|路由|任务链路|provider|调试|排查|阅读顺序|顶层/.test(prompt)
  );
}

export async function buildReadonlyTaskFallback(context: ReadonlyTaskFallbackContext): Promise<TaskRunResult | null> {
  if (!context.workspacePath) {
    return null;
  }

  const inspector = createWorkspaceInspector();
  const [repository, runtimeFlow, extensionAudit, focusSummary] = await Promise.all([
    inspectGroundedRepository(inspector, context.prompt).catch(() => null),
    inspectRuntimeFlow(inspector).catch(() => null),
    inspectExtensionWiring(inspector).catch(() => null),
    context.paths.length ? inspectGroundedFiles(inspector, context.paths, context.prompt).catch(() => null) : Promise.resolve(null),
  ]);

  if (!repository && !runtimeFlow && !extensionAudit && !focusSummary) {
    return null;
  }

  const readOrder = buildReadOrder(context.paths, extensionAudit, runtimeFlow);
  const report = buildFallbackReport(context, repository, runtimeFlow, extensionAudit, focusSummary, readOrder);
  if (context.mode === "analyze") {
    return {
      summary: text(
        "Provider did not finish cleanly, so this result was completed with bounded local workspace analysis.",
        "Provider 没有正常收尾，因此这次结果改为受限的本地工作区分析。"
      ),
      output: report,
      decision: null,
    };
  }

  const decision = buildFallbackDecision(context, repository, runtimeFlow, readOrder);
  return {
    summary: decision.summary,
    output: report,
    decision,
  };
}

function buildFallbackReport(
  context: ReadonlyTaskFallbackContext,
  repository: GroundedRepositorySummaryResult | null,
  runtimeFlow: RuntimeFlowAuditResult | null,
  extensionAudit: ExtensionAuditResult | null,
  focusSummary: GroundedSummaryResult | null,
  readOrder: string[]
): string {
  const lines: string[] = [
    heading("Fallback Note", "降级说明"),
    text(
      "Provider did not deliver a final result, so this report is based on bounded local workspace inspection only.",
      "Provider 未能返回最终结果，因此这份报告只基于受限的本地工作区检查。"
    ),
  ];

  const purpose = describeRepositoryPurpose(extensionAudit);
  if (purpose) {
    lines.push("", heading("Repository Purpose", "仓库用途"), purpose);
  }

  const moduleLines = describeModuleBreakdown(repository);
  if (moduleLines.length) {
    lines.push("", heading("Module Breakdown", "模块拆分"), ...moduleLines);
  }

  const entryPoints = describeEntryPoints(extensionAudit);
  if (entryPoints.length) {
    lines.push("", heading("Likely Entry Points", "可能的入口"), ...entryPoints.map((value) => `- ${value}`));
  }

  const pipelinePaths = describePipelineLocations(runtimeFlow);
  if (pipelinePaths.length) {
    lines.push("", heading("Task Pipeline Locations", "任务链路位置"), ...pipelinePaths.map((value) => `- ${value}`));
  }

  if (readOrder.length) {
    lines.push(
      "",
      heading("Recommended File Reading Order", "建议阅读顺序"),
      ...readOrder.map((value, index) => `${index + 1}. ${normalizePath(value)}`)
    );
  }

  if (focusSummary?.files.length) {
    lines.push(
      "",
      heading("Focused Paths", "重点路径"),
      ...focusSummary.files.slice(0, 4).map((file) => `- ${file.summary}`)
    );
  }

  const supporting = collectSupportingFindings(repository, runtimeFlow, extensionAudit);
  if (supporting.length) {
    lines.push("", heading("Supporting Findings", "补充证据"), ...supporting.map((value) => `- ${value}`));
  }

  if (!readOrder.length && context.paths.length) {
    lines.push("", heading("Requested Paths", "请求路径"), ...context.paths.map((value, index) => `${index + 1}. ${value}`));
  }

  return lines.join("\n");
}

function buildFallbackDecision(
  context: ReadonlyTaskFallbackContext,
  repository: GroundedRepositorySummaryResult | null,
  runtimeFlow: RuntimeFlowAuditResult | null,
  readOrder: string[]
): {
  summary: string;
  recommendedOptionId: string | null;
  options: TaskDecisionOption[];
} {
  const runtimePathSummary = summarizePathSet(readOrder.slice(0, 6));
  const repoTopDirectories = repository?.root.directory.topDirectories ?? [];
  const srcModules = findSrcModules(repository);
  const options: TaskDecisionOption[] = [];

  if (runtimePathSummary || runtimeFlow) {
    options.push({
      id: "option_pipeline_first",
      title: text("Trace Runtime Pipeline", "沿运行链路排查"),
      summary: text(
        `Start with ${runtimePathSummary || "the extension entry and task pipeline files"} to follow route -> task service -> provider finalization.`,
        `先看 ${runtimePathSummary || "扩展入口和任务链路文件"}，沿 route -> task service -> provider finalization 继续排查。`
      ),
      recommended: true,
    });
  }

  options.push({
    id: "option_structure_first",
    title: text("Survey Repo Structure", "先看仓库结构"),
    summary: text(
      `Start from top-level directories ${summarizeNames(repoTopDirectories)}${srcModules.length ? `, then narrow into src/${srcModules.join(", src/")}` : ""}.`,
      `先看顶层目录 ${summarizeNames(repoTopDirectories)}${srcModules.length ? `，再收敛到 src/${srcModules.join(", src/")}` : ""}。`
    ),
    recommended: options.length === 0,
  });

  if (context.paths.length) {
    options.push({
      id: "option_focus_paths_first",
      title: text("Start From Requested Paths", "先从请求路径入手"),
      summary: text(
        `Inspect the requested paths first (${summarizePathSet(context.paths.slice(0, 4))}), then reconnect them to the main task pipeline.`,
        `先检查请求路径（${summarizePathSet(context.paths.slice(0, 4))}），再把它们和主任务链路对上。`
      ),
      recommended: false,
    });
  }

  const recommendedOptionId = options.find((option) => option.recommended)?.id ?? null;
  return {
    summary: text(
      "Provider did not finish cleanly, so I prepared a bounded local read-only plan for the current workspace.",
      "Provider 没有正常收尾，因此我基于本地证据整理了一版受限的只读计划。"
    ),
    recommendedOptionId,
    options,
  };
}

function buildReadOrder(paths: string[], extensionAudit: ExtensionAuditResult | null, runtimeFlow: RuntimeFlowAuditResult | null): string[] {
  const ordered = [
    ...paths,
    extensionAudit?.packageJson?.path ?? null,
    extensionAudit?.sourceEntry?.path ?? null,
    extensionAudit?.buildEntry?.exists ? extensionAudit.buildEntry.path : null,
    runtimeFlow?.components.registry?.path ?? null,
    runtimeFlow?.components.routeService?.path ?? null,
    runtimeFlow?.components.taskService?.path ?? null,
    runtimeFlow?.components.providerContract?.path ?? null,
    runtimeFlow?.components.providerImplementation?.path ?? null,
  ].filter((value): value is string => Boolean(value));

  return [...new Set(ordered.map((value) => normalizePath(value)))];
}

function describeRepositoryPurpose(extensionAudit: ExtensionAuditResult | null): string | null {
  if (!extensionAudit?.packageJson) {
    return null;
  }
  return text(
    `This workspace looks like a VS Code extension: main = ${extensionAudit.packageJson.main ?? "(missing)"}, activationEvents = ${extensionAudit.packageJson.activationEvents.length}, contributes.commands = ${extensionAudit.packageJson.commandIds.length}.`,
    `这个工作区看起来是一个 VS Code 扩展：main = ${extensionAudit.packageJson.main ?? "（缺失）"}，activationEvents = ${extensionAudit.packageJson.activationEvents.length}，contributes.commands = ${extensionAudit.packageJson.commandIds.length}。`
  );
}

function describeModuleBreakdown(repository: GroundedRepositorySummaryResult | null): string[] {
  if (!repository) {
    return [];
  }
  const lines: string[] = [];
  const rootDirectories = repository.root.directory.topDirectories;
  if (rootDirectories.length) {
    lines.push(
      text(
        `Top-level directories: ${rootDirectories.join(", ")}.`,
        `顶层目录：${rootDirectories.join("、")}。`
      )
    );
  }
  const srcModules = findSrcModules(repository);
  if (srcModules.length) {
    lines.push(
      text(
        `The src subtree is centered around: ${srcModules.join(", ")}.`,
        `src 子树主要集中在：${srcModules.join("、")}。`
      )
    );
  }
  return lines;
}

function describeEntryPoints(extensionAudit: ExtensionAuditResult | null): string[] {
  if (!extensionAudit) {
    return [];
  }
  const entries = [
    extensionAudit.packageJson?.path ?? null,
    extensionAudit.sourceEntry?.path ?? null,
    extensionAudit.buildEntry?.exists ? extensionAudit.buildEntry.path : null,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(entries.map((value) => normalizePath(value)))];
}

function describePipelineLocations(runtimeFlow: RuntimeFlowAuditResult | null): string[] {
  if (!runtimeFlow) {
    return [];
  }
  const entries = [
    runtimeFlow.components.registry?.path ?? null,
    runtimeFlow.components.routeService?.path ?? null,
    runtimeFlow.components.taskService?.path ?? null,
    runtimeFlow.components.providerContract?.path ?? null,
    runtimeFlow.components.providerImplementation?.path ?? null,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(entries.map((value) => normalizePath(value)))];
}

function collectSupportingFindings(
  repository: GroundedRepositorySummaryResult | null,
  runtimeFlow: RuntimeFlowAuditResult | null,
  extensionAudit: ExtensionAuditResult | null
): string[] {
  return [
    extensionAudit?.findings[0] ?? null,
    extensionAudit?.findings[1] ?? null,
    runtimeFlow?.findings[0] ?? null,
    repository?.root.findings[0] ?? null,
  ]
    .filter((value): value is string => Boolean(value))
    .slice(0, 4);
}

function findSrcModules(repository: GroundedRepositorySummaryResult | null): string[] {
  if (!repository) {
    return [];
  }
  const srcChild = repository.children.find((child) => /(?:^|[\\/])src$/i.test(child.directory.path));
  return srcChild?.directory.topDirectories ?? [];
}

function summarizePathSet(paths: string[]): string {
  if (!paths.length) {
    return text("the main workspace files", "主工作区文件");
  }
  return paths.map((value) => normalizePath(value)).join(", ");
}

function summarizeNames(values: string[]): string {
  if (!values.length) {
    return text("the main workspace directories", "主要工作区目录");
  }
  return values.join(", ");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function heading(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? `${en}:` : `${zh}：`;
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}
