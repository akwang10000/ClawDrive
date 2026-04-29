import type { TaskContinuationCandidate } from "../tasks/types";

export type RouteIntent =
  | { type: "claude_vscode" }
  | { type: "continue" }
  | { type: "plan" }
  | { type: "apply" }
  | { type: "diagnose" }
  | { type: "blocked" }
  | { type: "inspect"; action: InspectAction }
  | { type: "analyze" };

export type InspectAction =
  | { type: "workspace" }
  | { type: "editor" }
  | { type: "diagnostics"; path?: string }
  | { type: "file"; path: string }
  | { type: "directory"; path: string }
  | { type: "directory_summary"; path: string }
  | { type: "repository_summary"; focusPath?: string }
  | { type: "grounded_summary"; paths: string[] }
  | { type: "search_lite"; query: string }
  | { type: "runtime_flow_audit" }
  | { type: "extension_audit" };

export function classifyIntent(prompt: string, paths: string[]): RouteIntent {
  if (matchesAny(prompt, claudeVsCodePatterns)) {
    return { type: "claude_vscode" };
  }
  if (matchesAny(prompt, continuePatterns) || matchesAny(prompt, approvalPatterns) || matchesAny(prompt, rejectionPatterns)) {
    return { type: "continue" };
  }
  if (matchesAny(prompt, planPatterns)) {
    return { type: "plan" };
  }
  if (matchesAny(prompt, runtimeFlowPatterns)) {
    return { type: "inspect", action: { type: "runtime_flow_audit" } };
  }
  if (matchesAny(prompt, diagnosePatterns)) {
    return { type: "diagnose" };
  }
  if (matchesAny(prompt, blockedPatterns)) {
    return { type: "blocked" };
  }
  if (matchesAny(prompt, applyPatterns) && !hasReadOnlyNoWriteConstraint(prompt)) {
    return { type: "apply" };
  }
  if (matchesAny(prompt, extensionAuditPatterns)) {
    return { type: "inspect", action: { type: "extension_audit" } };
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

export function shouldApprove(prompt: string): boolean {
  return matchesAny(prompt, approvalPatterns);
}

export function shouldReject(prompt: string): boolean {
  return matchesAny(prompt, rejectionPatterns);
}

export function selectHighestPriorityCandidates(candidates: TaskContinuationCandidate[]): TaskContinuationCandidate[] {
  if (!candidates.length) {
    return [];
  }
  const firstState = candidates[0].state;
  return candidates.filter((candidate) => candidate.state === firstState);
}

function classifyInspectAction(prompt: string, paths: string[]): InspectAction | null {
  const promptPaths = paths.length ? paths : extractPromptPaths(prompt);
  const promptDirectories = paths.length ? [] : extractPromptDirectories(prompt);
  const summaryPaths = promptPaths.slice(0, 4);
  const searchQuery = extractSearchQuery(prompt);

  if (!paths.length && !promptPaths.length && !promptDirectories.length && matchesAny(prompt, workspacePatterns)) {
    return { type: "workspace" };
  }
  if (!paths.length && !promptPaths.length && !promptDirectories.length && matchesAny(prompt, editorPatterns)) {
    return { type: "editor" };
  }
  if (matchesAny(prompt, repositorySummaryPatterns)) {
    return { type: "repository_summary", focusPath: promptDirectories[0] };
  }
  if (!paths.length && searchQuery && matchesAny(prompt, searchPatterns)) {
    return { type: "search_lite", query: searchQuery };
  }
  if (summaryPaths.length >= 1 && matchesAny(prompt, groundedSummaryPatterns)) {
    return { type: "grounded_summary", paths: summaryPaths };
  }
  if (promptPaths.length <= 1 && matchesAny(prompt, diagnosticsPatterns)) {
    return { type: "diagnostics", path: promptPaths[0] };
  }
  if (promptPaths.length === 1 && matchesAny(prompt, fileReadPatterns)) {
    return { type: "file", path: promptPaths[0] };
  }
  if (promptDirectories.length === 1 && matchesAny(prompt, groundedSummaryPatterns)) {
    return { type: "directory_summary", path: promptDirectories[0] };
  }
  if (promptDirectories.length === 1 && matchesAny(prompt, directoryPatterns)) {
    return { type: "directory", path: promptDirectories[0] };
  }
  if (promptPaths.length === 1 && matchesAny(prompt, directoryPatterns) && !looksLikeFilePath(promptPaths[0])) {
    return { type: "directory", path: promptPaths[0] };
  }
  return null;
}

function extractPromptPaths(prompt: string): string[] {
  const candidates = collectPathCandidates(prompt);
  return candidates.filter((candidate) => looksLikeFilePath(candidate));
}

function extractSearchQuery(prompt: string): string | null {
  const fenced = prompt.match(/[`'"]([^`'"]+)[`'"]/);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate) {
      return candidate;
    }
  }

  const commandLike = prompt.match(/\b[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+){1,}\b/);
  if (commandLike?.[0]) {
    return commandLike[0];
  }

  const symbolLike = prompt.match(/\b[A-Z][A-Za-z0-9_]{2,}\b/);
  if (symbolLike?.[0]) {
    return symbolLike[0];
  }

  return null;
}

function extractPromptDirectories(prompt: string): string[] {
  const candidates = collectPathCandidates(prompt);
  const directories = candidates.filter((candidate) => explicitDirectoryNames.has(candidate.toLowerCase()) || /[\\/]/.test(candidate));
  if (directories.length) {
    return directories;
  }

  const bareMatches = prompt.match(/\b(src|docs|out|test|media|client|server|extension)\b/gi) ?? [];
  return [...new Set(bareMatches.map((value) => value.trim()))];
}

function collectPathCandidates(prompt: string): string[] {
  const matches = prompt.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+/g) ?? [];
  return [
    ...new Set(
      matches
        .map((value) => value.replace(/^['"`]+|['"`]+$/g, ""))
        .map((value) => value.replace(/[.,!?;:，。！？；：]+$/g, ""))
        .filter(Boolean)
    ),
  ];
}

function looksLikeFilePath(value: string): boolean {
  const knownBareExtensions = new Set(["md", "txt", "json", "ts", "tsx", "js", "jsx", "cjs", "mjs", "css", "scss", "html", "yml", "yaml"]);
  if (/[\\/]/.test(value)) {
    const leaf = value.split(/[\\/]/).pop() ?? value;
    return leaf.includes(".");
  }
  if (!value.includes(".")) {
    return false;
  }
  const extension = value.split(".").pop()?.toLowerCase() ?? "";
  return knownBareExtensions.has(extension);
}

function matchesAny(prompt: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(prompt));
}

function hasReadOnlyNoWriteConstraint(prompt: string): boolean {
  return matchesAny(prompt, readOnlyNoWritePatterns);
}

const continuePatterns = [
  /\b(continue|keep going|resume)\b/i,
  /\buse the recommended (option|one|plan)\b/i,
  /\u7ee7\u7eed/,
  /\u63a5\u7740/,
  /\u7528\u63a8\u8350\u65b9\u6848/,
  /\u6309\u63a8\u8350\u65b9\u6848/,
];

const claudeVsCodePatterns = [
  /\b(open|send|handoff|hand off|continue|move)\b.*\b(claude code(?: for vs code)?|claude for vs code|claude-vscode)\b/i,
  /\b(claude code(?: for vs code)?|claude for vs code|claude-vscode)\b.*\b(open|continue|handle|review|analy[sz]e|plan)\b/i,
  /\u5728\s*claude(?:\s*code)?(?:\s*for\s*vs\s*code)?\s*.*(\u6253\u5f00|\u7ee7\u7eed|\u5904\u7406|\u5206\u6790|\u89c4\u5212)/i,
  /\u7528\s*claude(?:\s*code)?(?:\s*for\s*vs\s*code)?\s*(\u6253\u5f00|\u7ee7\u7eed|\u5904\u7406|\u5206\u6790|\u89c4\u5212)/i,
  /\u8f6c\u7ed9\s*claude(?:\s*code)?(?:\s*for\s*vs\s*code)?/i,
];

const recommendedPatterns = [/\brecommended\b/i, /\u63a8\u8350/];

const approvalPatterns = [
  /\b(approve|approved|apply it|go ahead|start applying|execute the changes)\b/i,
  /\u6279\u51c6/,
  /\u540c\u610f\u4fee\u6539/,
  /\u6267\u884c\u4fee\u6539/,
  /\u5f00\u59cb\u6539/,
  /\u5f00\u59cb\u6267\u884c/,
];

const rejectionPatterns = [
  /\b(reject|cancel the apply|do not apply|don't apply|stop the apply)\b/i,
  /\u4e0d\u8981\u6539\u4e86/,
  /\u62d2\u7edd/,
  /\u522b\u6539\u4e86/,
  /\u53d6\u6d88\u4fee\u6539/,
];

const planPatterns = [
  /\b(plan first|trade-?offs\?|let me decide)\b/i,
  /\bgive me\s+(?:two|2|three|3|several)\b[\w\s-]{0,48}\boptions?\b/i,
  /\b(?:safe|feasible|meaningful)\b[\w\s-]{0,24}\boptions?\b/i,
  /\bnext-?step\s+options?\b/i,
  /\bimplementation\s+options?\b/i,
  /\bwhat are (?:the\s+)?options\b/i,
  /\bcompare\b[\w\s-]{0,32}\boptions\b/i,
  /\u6211\u6765\u51b3\u5b9a/,
  /\u7ed9\u6211.*\u65b9\u6848/,
  /\u51e0\u4e2a\u65b9\u6848/,
  /\u4e24\u79cd\u65b9\u6848/,
  /\u4e24\u4e2a\u65b9\u6848/,
  /\u5148\u89c4\u5212/,
  /\u5148\u505a\u89c4\u5212/,
];

const diagnosePatterns = [
  /\b(connection status|provider status|provider readiness|provider ready|provider not ready|task status|runtime health|not callable|connected but not callable|what status)\b/i,
  /\bdiagnose( the)? connection\b/i,
  /\b(debug|diagnose)\b.*\b(provider|task|connection|status|readiness|callable|failure|error)\b/i,
  /\b(check|inspect)\b.*\b(connection|status|readiness|callable)\b/i,
  /\bwhy .*\b(fail|failed|failure|connect|connected|disconnect|disconnected|error|errors|not callable|not ready)\b/i,
  /\u8fde\u63a5\u72b6\u6001/,
  /\u53ef\u8c03\u7528/,
  /\u8282\u70b9\u72b6\u6001/,
  /\u4e3a\u4ec0\u4e48.*\u5931\u8d25/,
  /\u4e3a\u4ec0\u4e48.*\u62a5\u9519/,
  /\u4e3a\u4ec0\u4e48.*\u8fde/,
  /\u4efb\u52a1.*\u62a5\u9519/,
  /\u68c0\u67e5.*\u8fde\u63a5/,
  /\u68c0\u67e5.*(\u72b6\u6001|\u5c31\u7eea|\u53ef\u8c03\u7528)/,
  /provider.*(\u72b6\u6001|\u5c31\u7eea|\u53ef\u8c03\u7528)/i,
  /\u73b0\u5728\u4ec0\u4e48\u72b6\u6001/,
];

const blockedPatterns = [/\b(delete|remove|rename)\b/i, /\u5220\u9664/, /\u79fb\u9664/, /\u91cd\u547d\u540d/];

const applyPatterns = [
  /\b(fix|implement|patch|modify|edit|write|change|apply|update)\b/i,
  /\u4fee\u590d/,
  /\u4fee\u8fd9\u4e2a/,
  /\u5b9e\u73b0/,
  /\u4fee\u6539/,
  /\u7f16\u8f91/,
  /\u5199\u5165/,
  /\u5e94\u7528/,
  /\u66f4\u65b0\u4ee3\u7801/,
];

const readOnlyNoWritePatterns = [
  /\b(read-?only|analysis only|analyze only|analyse only|keep this as analysis only|do not modify|don't modify|no changes? yet|without modifying|without changing)\b/i,
  /\u5148\u522b\u6539/,
  /\u522b\u6539/,
  /\u4e0d\u8981\u6539/,
];

const workspacePatterns = [
  /\b(workspace info|current workspace|which workspace|project root|repo root|root path)\b/i,
  /\u5f53\u524d\u5de5\u4f5c\u533a/,
  /\u5de5\u4f5c\u533a\u4fe1\u606f/,
  /\u9879\u76ee\u6839\u76ee\u5f55/,
  /\u4ed3\u5e93\u6839\u76ee\u5f55/,
  /\u6839\u8def\u5f84/,
];

const editorPatterns = [/\b(active editor|current editor|current file|active file)\b/i, /\u5f53\u524d\u7f16\u8f91\u5668/, /\u6d3b\u52a8\u7f16\u8f91\u5668/, /\u5f53\u524d\u6587\u4ef6/];

const diagnosticsPatterns = [/\b(diagnostics|problems|warnings?|errors?)\b/i, /\u5f53\u524d\u8bca\u65ad/, /\u770b.*\u8bca\u65ad/, /\u67e5\u770b.*\u8bca\u65ad/, /\u95ee\u9898\u5217\u8868/, /\u8b66\u544a/, /\u9519\u8bef/];

const fileReadPatterns = [/\b(read|open|show|view|cat|contents of)\b/i, /\u8bfb\u53d6/, /\u67e5\u770b/, /\u6253\u5f00/, /\u663e\u793a\u5185\u5bb9/];

const directoryPatterns = [/\b(list|tree|browse|show files|show directory|list files)\b/i, /\u5217\u51fa/, /\u770b.*\u76ee\u5f55/, /\u67e5\u770b.*\u76ee\u5f55/, /\u5217.*\u6587\u4ef6/];

const extensionAuditPatterns = [
  /\b(activationevents|activation events|contributes\.commands|registercommand|main field|command registration|extension entry)\b/i,
  /\b(package\.json|src\/extension\.ts|out\/extension\.js)\b.*\b(main|activationevents|contributes\.commands|registercommand|activate|deactivate)\b/i,
  /\u63d2\u4ef6.*(\u5165\u53e3|\u547d\u4ee4\u6ce8\u518c|\u6fc0\u6d3b|\u6784\u5efa\u4ea7\u7269)/,
  /package\.json.*(main|activationEvents|contributes\.commands|registerCommand)/i,
  /(\u8bfb\u53d6|\u68c0\u67e5).*((package\.json).*(main|activationEvents|contributes\.commands|registerCommand)|src\/extension\.ts|out\/extension\.js)/i,
];

const runtimeFlowPatterns = [
  /\b(main )?(runtime|request|call)\s+flow\b/i,
  /\bhow .*route.*task service.*provider\b/i,
  /\bhow .*task service.*provider.*fit together\b/i,
  /\bexplain .*route.*provider\b/i,
  /\b(route|routing).*(task service|task orchestration).*(provider|codex)\b/i,
  /\b(task service|provider).*(route|routing)\b/i,
  /\u4e3b\u94fe\u8def/,
  /\u5165\u53e3\u94fe\u8def/,
  /\u8def\u7531.*\u4efb\u52a1.*provider/,
  /\u8def\u7531.*\u4efb\u52a1.*\u63d0\u4f9b\u8005/,
  /\u4efb\u52a1.*provider.*\u5173\u7cfb/,
];

const explicitDirectoryNames = new Set(["src", "docs", "out", "test", "media", ".vscode", "client", "server", "extension"]);

const groundedSummaryPatterns = [
  /\b(summarize|summary|explain|compare|confirm|verify|check|tell me the real|what does)\b/i,
  /\u603b\u7ed3/,
  /\u89e3\u91ca/,
  /\u6bd4\u8f83/,
  /\u786e\u8ba4/,
  /\u68c0\u67e5/,
  /\u771f\u5b9e\u503c/,
  /\u662f\u5426\u4e00\u81f4/,
];

const searchPatterns = [
  /\b(where is|where does|which file|wired up|registered in|defined in|declared in|implemented in|hooked up)\b/i,
  /\u5728\u54ea/,
  /\u54ea\u91cc/,
  /\u63a5\u7ebf/,
  /\u6ce8\u518c\u5728/,
  /\u5b9a\u4e49\u5728/,
  /\u58f0\u660e\u5728/,
  /\u5b9e\u73b0\u5728/,
];

const repositorySummaryPatterns = [
  /\b(repository structure|project structure|repo structure|main modules|module layout|code layout)\b/i,
  /\b(look at|explain|summarize)\s+(the\s+)?(repository|project)\b/i,
  /\b(look at|explain)\s+src\b.*\b(main modules|module layout)\b/i,
  /\u4ed3\u5e93\u7ed3\u6784/,
  /\u9879\u76ee\u7ed3\u6784/,
  /\u4e3b\u8981\u6a21\u5757/,
  /\u6a21\u5757\u7ed3\u6784/,
  /\u603b\u7ed3.*(src|\u4ed3\u5e93|\u9879\u76ee)/,
  /\u770b.*(src|\u4ed3\u5e93|\u9879\u76ee).*(\u6a21\u5757|\u7ed3\u6784)/,
];
