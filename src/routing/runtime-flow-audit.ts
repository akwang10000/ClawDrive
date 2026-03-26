import { getCurrentLocale } from "../i18n";
import type { FileReadPayload, WorkspaceInfoPayload, WorkspaceInspector } from "./workspace-inspector";

export interface RuntimeFlowAuditResult {
  workspace: WorkspaceInfoPayload;
  summary: string;
  findings: string[];
  components: {
    extension: RuntimeFlowComponent | null;
    registry: RuntimeFlowComponent | null;
    routeService: RuntimeFlowComponent | null;
    taskService: RuntimeFlowComponent | null;
    providerContract: RuntimeFlowComponent | null;
    providerImplementation: RuntimeFlowComponent | null;
  };
}

export interface RuntimeFlowComponent {
  path: string;
  summary: string;
}

export async function inspectRuntimeFlow(inspector: WorkspaceInspector): Promise<RuntimeFlowAuditResult> {
  const workspace = await inspector.workspaceInfo();
  const extensionDocument = await findFirstReadable(inspector, ["src/extension.ts", "src/extension.js", "extension.ts", "extension.js"]);
  const registryDocument = await findFirstReadable(inspector, ["src/commands/registry.ts", "src/commands/registry.js"]);
  const routeDocument = await findFirstReadable(inspector, ["src/routing/service.ts", "src/routing/service.js"]);
  const taskServiceDocument = await findFirstReadable(inspector, ["src/tasks/service.ts", "src/tasks/service.js"]);
  const providerContractDocument = await findFirstReadable(inspector, ["src/tasks/provider.ts", "src/tasks/provider.js"]);
  const providerImplementationDocument = await findFirstReadable(inspector, ["src/tasks/codex-provider.ts", "src/tasks/codex-provider.js"]);

  const components = {
    extension: extensionDocument ? summarizeExtensionRuntime(extensionDocument) : null,
    registry: registryDocument ? summarizeCommandRegistry(registryDocument) : null,
    routeService: routeDocument ? summarizeRouteService(routeDocument) : null,
    taskService: taskServiceDocument ? summarizeTaskService(taskServiceDocument) : null,
    providerContract: providerContractDocument ? summarizeProviderContract(providerContractDocument) : null,
    providerImplementation: providerImplementationDocument
      ? summarizeProviderImplementation(providerImplementationDocument)
      : null,
  };

  const findings = [
    summarizeMainFlow(components),
    ...Object.values(components)
      .filter((component): component is RuntimeFlowComponent => Boolean(component))
      .map((component) => component.summary),
  ];

  return {
    workspace,
    summary: findings.join("\n"),
    findings,
    components,
  };
}

function summarizeMainFlow(components: RuntimeFlowAuditResult["components"]): string {
  const segments = [
    "OpenClaw",
    components.registry ? "vscode.agent.route" : null,
    components.routeService ? "AgentRouteService" : null,
    components.taskService ? "TaskService" : null,
    components.providerImplementation ? "CodexCliProvider" : components.providerContract ? "TaskProvider" : null,
  ].filter((segment): segment is string => Boolean(segment));
  return text(
    `Main flow: ${segments.join(" -> ")}.`,
    `主链路：${segments.join(" -> ")}。`
  );
}

function summarizeExtensionRuntime(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const signals = [
    has(content, /\bnew\s+TaskService\s*\(/) ? "TaskService" : null,
    has(content, /\bnew\s+AgentRouteService\s*\(/) ? "AgentRouteService" : null,
    has(content, /\binitializeCommandRegistry\s*\(/) ? "command registry init" : null,
    has(content, /\bonInvoke\s*:\s*dispatchCommand\b/) ? "gateway dispatch" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    path: document.path,
    summary: text(
      `${document.path}: activation wires ${signals.join(", ") || "the extension runtime"}.`,
      `${document.path}：激活阶段接线了 ${signals.join("、") || "扩展运行时"}。`
    ),
  };
}

function summarizeCommandRegistry(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const commands = extractMatches(content, /command:\s*["'`]([^"'`]+)["'`]/g);
  const routePresent = commands.includes("vscode.agent.route");
  const taskCommands = commands.filter((command) => command.startsWith("vscode.agent.task."));
  return {
    path: document.path,
    summary: text(
      `${document.path}: route command = ${boolLabel(routePresent, "en")}; task commands = ${taskCommands.length}.`,
      `${document.path}：route 命令 = ${boolLabel(routePresent, "zh")}；task 命令 = ${taskCommands.length} 个。`
    ),
  };
}

function summarizeRouteService(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const routes = ["inspect", "analyze", "plan", "apply", "continue", "diagnose"].filter((route) =>
    new RegExp(`route\\s*:\\s*["'\`]${escapeRegex(route)}["'\`]`).test(content)
  );
  const startsTasks = has(content, /\brouteTask\s*\(/);
  return {
    path: document.path,
    summary: text(
      `${document.path}: route service covers ${routes.join(", ") || "no obvious routes"}; starts task-backed work = ${boolLabel(startsTasks, "en")}.`,
      `${document.path}：route service 覆盖 ${routes.join("、") || "未识别到明确路由"}；会启动任务链路 = ${boolLabel(startsTasks, "zh")}。`
    ),
  };
}

function summarizeTaskService(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const signals = [
    has(content, /\bprovider\.startTask\s*\(/) ? "provider.startTask" : null,
    has(content, /\bprovider\.resumeTask\s*\(/) ? "provider.resumeTask" : null,
    has(content, /\bStructuredApplyExecutor\b/) ? "StructuredApplyExecutor" : null,
    has(content, /\bpumpQueue\s*\(/) ? "single queue pump" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    path: document.path,
    summary: text(
      `${document.path}: task orchestration includes ${signals.join(", ") || "core task handling"}.`,
      `${document.path}：任务编排包含 ${signals.join("、") || "核心任务处理"}。`
    ),
  };
}

function summarizeProviderContract(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const methods = [
    has(content, /\bprobe\s*\(/) ? "probe" : null,
    has(content, /\bstartTask\s*\(/) ? "startTask" : null,
    has(content, /\bresumeTask\s*\(/) ? "resumeTask" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    path: document.path,
    summary: text(
      `${document.path}: provider contract defines ${methods.join(", ") || "no obvious lifecycle methods"}.`,
      `${document.path}：provider 契约定义了 ${methods.join("、") || "未识别到明确生命周期方法"}。`
    ),
  };
}

function summarizeProviderImplementation(document: FileReadPayload): RuntimeFlowComponent {
  const content = document.content;
  const kindMatch = content.match(/\breadonly\s+kind\s*=\s*["'`]([^"'`]+)["'`]/);
  const kind = kindMatch?.[1] ?? "unknown";
  const supports = [
    has(content, /\basync\s+startTask\s*\(/) ? "startTask" : null,
    has(content, /\basync\s+resumeTask\s*\(/) ? "resumeTask" : null,
    has(content, /\bprobe\s*\(/) ? "probe" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    path: document.path,
    summary: text(
      `${document.path}: concrete provider kind = ${kind}; implements ${supports.join(", ") || "provider hooks"}.`,
      `${document.path}：具体 provider 类型 = ${kind}；实现了 ${supports.join("、") || "provider 接口"}。`
    ),
  };
}

async function findFirstReadable(inspector: WorkspaceInspector, candidates: string[]): Promise<FileReadPayload | null> {
  for (const candidate of candidates) {
    try {
      return await inspector.fileRead({ path: candidate });
    } catch {
      continue;
    }
  }
  return null;
}

function extractMatches(content: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    matches.add(match[1]);
    match = pattern.exec(content);
  }
  return [...matches];
}

function has(content: string, pattern: RegExp): boolean {
  return pattern.test(content);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}

function boolLabel(value: boolean, locale: "en" | "zh"): string {
  if (locale === "en") {
    return value ? "yes" : "no";
  }
  return value ? "是" : "否";
}
