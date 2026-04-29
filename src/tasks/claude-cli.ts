import * as path from "path";
import type { TaskRuntimeSignal } from "./types";

export interface ClaudeCliCapabilities {
  supportsBare: boolean;
  supportsPrint: boolean;
  supportsOutputFormat: boolean;
  supportsJsonSchema: boolean;
  supportsResume: boolean;
  supportsModel: boolean;
  supportsPermissionMode: boolean;
}

export interface ClaudeCliFailure {
  code: string;
  message: string;
}

export interface BuildClaudeExecArgsOptions {
  prompt: string;
  model?: string;
  schema?: string;
  capabilities: ClaudeCliCapabilities;
  outputFormatJson?: boolean;
  permissionModePlan?: boolean;
  printPrompt?: boolean;
}

export interface BuildClaudeResumeArgsOptions extends BuildClaudeExecArgsOptions {
  sessionId: string;
}

const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+(?:\.exe|\.cmd|\.bat)?$/;

function isAuthIssue(normalized: string): boolean {
  return (
    normalized.includes("401 unauthorized") ||
    normalized.includes("403 forbidden") ||
    normalized.includes("invalid api key") ||
    normalized.includes("authentication") ||
    normalized.includes("auth login") ||
    normalized.includes("not logged in") ||
    normalized.includes("no authentication found") ||
    normalized.includes("no api key available")
  );
}

function isModelIssue(normalized: string): boolean {
  return (
    normalized.includes("invalid model") ||
    normalized.includes("unsupported model") ||
    normalized.includes("unknown model") ||
    (/\bmodel\b/.test(normalized) && normalized.includes("not found"))
  );
}

function isMcpCompatibilityIssue(normalized: string): boolean {
  return (
    (normalized.includes("mcp") && normalized.includes("failed to fetch tools")) ||
    normalized.includes("mcp error -32601") ||
    (normalized.includes("mcp") && normalized.includes("method not found"))
  );
}

function isTransportIssue(normalized: string): boolean {
  return (
    normalized.includes("transport channel closed") ||
    normalized.includes("missing-content-type") ||
    normalized.includes("unexpectedcontenttype") ||
    normalized.includes("stream closed") ||
    normalized.includes("socket hang up") ||
    normalized.includes("error decoding response body")
  );
}

export function validateClaudeExecutablePath(configuredPath: string): void {
  const trimmed = configuredPath.trim();
  if (!trimmed) {
    throw new Error("Claude executable path is empty.");
  }
  if (!path.isAbsolute(trimmed) && !BARE_EXECUTABLE.test(trimmed)) {
    throw new Error("Claude executable must be a bare executable name or an absolute path.");
  }
}

export function detectClaudeCliCapabilities(helpOutput: string): ClaudeCliCapabilities {
  return {
    supportsBare: /--bare\b/.test(helpOutput),
    supportsPrint: /--print\b|-p\b/.test(helpOutput),
    supportsOutputFormat: /--output-format\b/.test(helpOutput),
    supportsJsonSchema: /--json-schema\b/.test(helpOutput),
    supportsResume: /--resume\b|-r\b/.test(helpOutput),
    supportsModel: /--model\b/.test(helpOutput),
    supportsPermissionMode: /--permission-mode\b/.test(helpOutput),
  };
}

export function buildClaudeExecArgs(options: BuildClaudeExecArgsOptions): string[] {
  const args: string[] = [];
  if (options.capabilities.supportsBare) {
    args.push("--bare");
  }
  if ((options.permissionModePlan ?? true) && options.capabilities.supportsPermissionMode) {
    args.push("--permission-mode", "plan");
  }
  if (options.capabilities.supportsModel && options.model?.trim()) {
    args.push("--model", options.model.trim());
  }
  if ((options.printPrompt ?? true) && options.capabilities.supportsPrint) {
    args.push("-p");
  }
  if ((options.outputFormatJson ?? true) && options.capabilities.supportsOutputFormat) {
    args.push("--output-format", "json");
  }
  if (options.schema && options.capabilities.supportsJsonSchema) {
    args.push("--json-schema", options.schema);
  }
  args.push(options.prompt);
  return args;
}

export function buildClaudeResumeArgs(options: BuildClaudeResumeArgsOptions): string[] {
  const args = buildClaudeExecArgs(options);
  if (options.capabilities.supportsResume) {
    args.unshift(options.sessionId);
    args.unshift("--resume");
  }
  return args;
}

export function classifyClaudeCliFailure(error: unknown): ClaudeCliFailure {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (isAuthIssue(normalized)) {
    return {
      code: "PROVIDER_AUTH_FAILED",
      message: "Claude Code could not authenticate with the configured upstream model provider.",
    };
  }

  if (isModelIssue(normalized)) {
    return {
      code: "PROVIDER_MODEL_INVALID",
      message: "The configured Claude model is invalid or unavailable. Check clawdrive.provider.claude.model.",
    };
  }

  if (
    normalized.includes("500 internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("overloaded") ||
    normalized.includes("high demand")
  ) {
    return {
      code: "PROVIDER_UPSTREAM_UNAVAILABLE",
      message: "The upstream model provider is currently unavailable or unstable.",
    };
  }

  if (isMcpCompatibilityIssue(normalized)) {
    return {
      code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
      message: "Claude Code could not use the configured MCP tools. Check claude-vscode MCP compatibility and tool registration.",
    };
  }

  if (normalized.includes("enoent") || normalized.includes("not found") || normalized.includes("not recognized")) {
    return {
      code: "PROVIDER_EXECUTABLE_MISSING",
      message:
        "Claude Code CLI executable was not found. Check clawdrive.provider.claude.path and local installation. Claude Code for VS Code alone does not satisfy background provider tasks.",
    };
  }

  if (
    normalized.includes("unexpected argument") ||
    normalized.includes("unknown option") ||
    normalized.includes("unrecognized option")
  ) {
    return {
      code: "PROVIDER_CLI_ARGS_UNSUPPORTED",
      message: "The installed Claude Code CLI does not support one or more arguments required by this provider.",
    };
  }

  if (normalized.includes("resume") && normalized.includes("session") && normalized.includes("not")) {
    return {
      code: "TASK_RESUME_UNAVAILABLE",
      message: "This task cannot be resumed because the Claude provider session is unavailable.",
    };
  }

  if (normalized.includes("error_max_structured_output_retries") || normalized.includes("structured output retries")) {
    return {
      code: "PROVIDER_OUTPUT_INVALID",
      message: "Claude Code could not satisfy the required structured output contract for this task.",
    };
  }

  if (normalized.includes("did not return a usable") || normalized.includes("returned an unusable")) {
    return {
      code: "PROVIDER_OUTPUT_INVALID",
      message: "Claude Code returned output that could not be parsed as the expected JSON result.",
    };
  }

  if (normalized.includes("did not return a final message") || normalized.includes("without returning a final message") || normalized.includes("empty stdout") || normalized.includes("no result") || normalized.includes("empty result payload")) {
    return {
      code: "PROVIDER_OUTPUT_EMPTY",
      message: "Claude Code finished without returning a final message.",
    };
  }

  if (
    normalized.includes("stalled after turn start without producing a usable result") ||
    normalized.includes("stalled after turn start without producing provider activity")
  ) {
    return {
      code: "PROVIDER_RESULT_STALLED",
      message: "Claude Code stalled after turn start without producing a usable result.",
    };
  }

  if (isTransportIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Claude Code transport failed while talking to a downstream service. Check relay, MCP, or provider compatibility.",
    };
  }

  if (normalized.includes("json") || normalized.includes("unexpected token")) {
    return {
      code: "PROVIDER_OUTPUT_INVALID",
      message: "Claude Code returned output that could not be parsed as the expected JSON result.",
    };
  }

  return {
    code: "PROVIDER_EXECUTION_FAILED",
    message: message.trim() || "Claude Code execution failed.",
  };
}

export function classifyClaudeRuntimeSignal(line: string): Omit<TaskRuntimeSignal, "count" | "lastSeenAt"> | null {
  const trimmed = line.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (isTransportIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
      severity: "degraded",
      summary: "Provider transport reported a downstream connectivity problem.",
      detail: trimmed,
    };
  }

  if (isAuthIssue(normalized)) {
    return {
      code: "PROVIDER_AUTH_FAILED",
      severity: "fatal",
      summary: "Provider authentication failed while contacting the upstream model service.",
      detail: trimmed,
    };
  }

  if (isModelIssue(normalized)) {
    return {
      code: "PROVIDER_MODEL_INVALID",
      severity: "fatal",
      summary: "Provider model configuration is invalid or unavailable.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("500 internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("overloaded")
  ) {
    return {
      code: "PROVIDER_UPSTREAM_UNAVAILABLE",
      severity: "fatal",
      summary: "Provider upstream connectivity or availability failed.",
      detail: trimmed,
    };
  }

  if (isMcpCompatibilityIssue(normalized)) {
    return {
      code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
      severity: "fatal",
      summary: "Provider MCP compatibility failed while fetching tools or invoking methods.",
      detail: trimmed,
    };
  }

  if (/\bwarn\b|\berror\b/.test(normalized)) {
    return {
      code: "PROVIDER_RUNTIME_STDERR",
      severity: "noise",
      summary: "Provider emitted a runtime warning.",
      detail: trimmed,
    };
  }

  return null;
}
