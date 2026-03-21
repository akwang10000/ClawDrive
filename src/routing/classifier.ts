import type { TaskContinuationCandidate } from "../tasks/types";

export type RouteIntent =
  | { type: "continue" }
  | { type: "plan" }
  | { type: "diagnose" }
  | { type: "blocked" }
  | { type: "inspect"; action: InspectAction }
  | { type: "analyze" };

export type InspectAction =
  | { type: "workspace" }
  | { type: "editor" }
  | { type: "diagnostics"; path?: string }
  | { type: "file"; path: string }
  | { type: "directory"; path: string };

export function classifyIntent(prompt: string, paths: string[]): RouteIntent {
  if (matchesAny(prompt, continuePatterns)) {
    return { type: "continue" };
  }
  if (matchesAny(prompt, planPatterns)) {
    return { type: "plan" };
  }
  if (matchesAny(prompt, diagnosePatterns)) {
    return { type: "diagnose" };
  }
  if (matchesAny(prompt, blockedWritePatterns)) {
    return { type: "blocked" };
  }

  const inspectAction = classifyInspectAction(prompt, paths);
  if (inspectAction) {
    return { type: "inspect", action: inspectAction };
  }

  return { type: "analyze" };
}

export function shouldUseRecommended(prompt: string): boolean {
  return matchesAny(prompt, recommendedPatterns);
}

export function selectHighestPriorityCandidates(candidates: TaskContinuationCandidate[]): TaskContinuationCandidate[] {
  if (!candidates.length) {
    return [];
  }
  const firstState = candidates[0].state;
  return candidates.filter((candidate) => candidate.state === firstState);
}

function classifyInspectAction(prompt: string, paths: string[]): InspectAction | null {
  if (!paths.length && matchesAny(prompt, workspacePatterns)) {
    return { type: "workspace" };
  }
  if (!paths.length && matchesAny(prompt, editorPatterns)) {
    return { type: "editor" };
  }
  if (paths.length <= 1 && matchesAny(prompt, diagnosticsPatterns)) {
    return { type: "diagnostics", path: paths[0] };
  }
  if (paths.length === 1 && matchesAny(prompt, fileReadPatterns)) {
    return { type: "file", path: paths[0] };
  }
  if (paths.length === 1 && matchesAny(prompt, directoryPatterns)) {
    return { type: "directory", path: paths[0] };
  }
  return null;
}

function matchesAny(prompt: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(prompt));
}

const continuePatterns = [
  /\b(continue|keep going|resume)\b/i,
  /\buse the recommended (option|one|plan)\b/i,
  /继续/,
  /接着/,
  /用推荐方案/,
  /按推荐方案/,
];

const recommendedPatterns = [/\brecommended\b/i, /推荐/];

const planPatterns = [
  /\b(plan first|give me (two|2|three|3|several)?\s*options?|trade-?offs?|let me decide|do not modify|don't modify|no changes yet)\b/i,
  /先别改/,
  /我来决定/,
  /给我.*方案/,
  /几个方案/,
  /两种方案/,
  /两个方案/,
  /先规划/,
  /先做规划/,
];

const diagnosePatterns = [
  /\b(connection status|provider status|provider ready|not callable|connected but not callable|why .*fail|why .*provider|why .*connect|what status|why .*error)\b/i,
  /\bdiagnose( the)? connection\b/i,
  /连接状态/,
  /可调用/,
  /provider/,
  /节点状态/,
  /为什么.*失败/,
  /为什么.*报错/,
  /为什么.*连/,
  /任务.*报错/,
  /检查.*连接/,
  /检查.*provider/,
  /现在什么状态/,
];

const blockedWritePatterns = [
  /\b(fix|implement|patch|modify|edit|write|change|commit|apply|update)\b/i,
  /修复/,
  /修这个/,
  /实现/,
  /修改/,
  /编辑/,
  /写入/,
  /提交/,
  /应用/,
  /更新代码/,
];

const workspacePatterns = [
  /\b(workspace info|current workspace|which workspace|project root|repo root|root path)\b/i,
  /当前工作区/,
  /工作区信息/,
  /项目根目录/,
  /仓库根目录/,
  /根路径/,
];

const editorPatterns = [/\b(active editor|current editor|current file|active file)\b/i, /当前编辑器/, /活动编辑器/, /当前文件/];

const diagnosticsPatterns = [/\b(diagnostics|problems|warnings?|errors?)\b/i, /当前诊断/, /看.*诊断/, /查看.*诊断/, /问题列表/, /警告/, /错误/];

const fileReadPatterns = [/\b(read|open|show|view|cat|contents of)\b/i, /读取/, /读一个/, /查看/, /打开/, /显示内容/];

const directoryPatterns = [/\b(list|tree|browse|show files|show directory|list files)\b/i, /列出/, /列一个/, /看.*目录/, /查看.*目录/, /列.*文件夹/];
