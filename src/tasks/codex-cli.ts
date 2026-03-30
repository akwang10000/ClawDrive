import * as path from "path";
import type { TaskRuntimeSignal } from "./types";

export interface CodexCliCapabilities {
  supportsAskForApproval: boolean;
  supportsOutputSchema: boolean;
  supportsOutputLastMessage: boolean;
  supportsResumeOutputLastMessage: boolean;
}

export interface CodexCliFailure {
  code: string;
  message: string;
}

export interface BuildExecArgsOptions {
  workspacePath: string | null;
  prompt: string;
  model?: string;
  schemaPath?: string;
  outputPath?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  capabilities: CodexCliCapabilities;
  disabledFeatures?: readonly string[];
}

export interface BuildResumeArgsOptions {
  workspacePath: string | null;
  sessionId: string;
  prompt: string;
  model?: string;
  outputPath?: string;
  capabilities: CodexCliCapabilities;
  disabledFeatures?: readonly string[];
}

const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+(?:\.exe|\.cmd|\.bat)?$/;
const TASK_DISABLED_FEATURES = ["multi_agent", "plugins", "apps", "shell_snapshot"] as const;

function isTransportContentTypeIssue(normalized: string): boolean {
  return normalized.includes("unexpectedcontenttype") || normalized.includes("missing-content-type");
}

function isTransportChannelClosedIssue(normalized: string): boolean {
  return normalized.includes("transport channel closed") || normalized.includes("stream closed before response.completed");
}

function isTransportBodyDecodeIssue(normalized: string): boolean {
  return normalized.includes("stream disconnected before completion") || normalized.includes("error decoding response body");
}

export function validateCodexExecutablePath(configuredPath: string): void {
  const trimmed = configuredPath.trim();
  if (!trimmed) {
    throw new Error("Codex executable path is empty.");
  }
  if (!path.isAbsolute(trimmed) && !BARE_EXECUTABLE.test(trimmed)) {
    throw new Error("Codex executable must be a bare executable name or an absolute path.");
  }
}

export function detectCodexCliCapabilities(rootHelp: string, execHelp: string, resumeHelp: string): CodexCliCapabilities {
  return {
    supportsAskForApproval: /--ask-for-approval/.test(rootHelp),
    supportsOutputSchema: /--output-schema/.test(execHelp),
    supportsOutputLastMessage: /--output-last-message/.test(execHelp),
    supportsResumeOutputLastMessage: /--output-last-message/.test(resumeHelp),
  };
}

export function buildCodexExecArgs(options: BuildExecArgsOptions): string[] {
  const args = buildBaseArgs(options.workspacePath, options.model, options.capabilities, options.disabledFeatures);
  const sandboxMode = options.sandboxMode ?? "read-only";
  args.push("exec", "--json", "--sandbox", sandboxMode);
  args.push("--skip-git-repo-check");
  if (options.schemaPath) {
    args.push("--output-schema", options.schemaPath);
  } else if (options.outputPath && options.capabilities.supportsOutputLastMessage) {
    args.push("--output-last-message", options.outputPath);
  }
  args.push(options.prompt);
  return args;
}

export function buildCodexResumeArgs(options: BuildResumeArgsOptions): string[] {
  const args = buildBaseArgs(options.workspacePath, options.model, options.capabilities, options.disabledFeatures);
  args.push("exec", "resume", "--json");
  args.push("--skip-git-repo-check");
  if (options.outputPath && options.capabilities.supportsResumeOutputLastMessage) {
    args.push("--output-last-message", options.outputPath);
  }
  args.push(options.sessionId, options.prompt);
  return args;
}

export function classifyCodexCliFailure(error: unknown): CodexCliFailure {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("401 unauthorized") ||
    normalized.includes("403 forbidden") ||
    normalized.includes("missing bearer") ||
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("invalid api key")
  ) {
    return {
      code: "PROVIDER_AUTH_FAILED",
      message: "Codex could not authenticate with the configured upstream model provider.",
    };
  }

  if (
    normalized.includes("500 internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("currently experiencing high demand")
  ) {
    return {
      code: "PROVIDER_UPSTREAM_UNAVAILABLE",
      message: "The upstream model provider is currently unavailable or unstable.",
    };
  }

  if (normalized.includes("blocked by policy") || normalized.includes("rejected: blocked by policy")) {
    return {
      code: "PROVIDER_COMMAND_POLICY_BLOCKED",
      message:
        "Codex tried to run a shell probe, but its execution policy blocked the command. Retry with a narrower prompt or continue without shell exploration.",
    };
  }

  if (
    normalized.includes("enoent") ||
    normalized.includes("not found") ||
    normalized.includes("not exist") ||
    normalized.includes("not recognized")
  ) {
    return {
      code: "PROVIDER_EXECUTABLE_MISSING",
      message: "Codex executable was not found. Check clawdrive.provider.codex.path and local installation.",
    };
  }

  if (
    normalized.includes("unexpected argument") ||
    normalized.includes("unknown option") ||
    normalized.includes("unrecognized option")
  ) {
    return {
      code: "PROVIDER_CLI_ARGS_UNSUPPORTED",
      message: "The installed Codex CLI does not support one or more arguments required by this provider.",
    };
  }

  if (normalized.includes("did not return a final agent message") || normalized.includes("resume did not return")) {
    return {
      code: "PROVIDER_OUTPUT_EMPTY",
      message: "Codex finished without returning a final message.",
    };
  }

  if (normalized.includes("no final result arrived before provider finalization timeout")) {
    return {
      code: "PROVIDER_FINALIZATION_STALLED",
      message: "Codex finished its turn but never delivered the final result payload.",
    };
  }

  if (isTransportContentTypeIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport received an invalid downstream response (missing content-type or empty body). Check downstream MCP, relay, or model-provider compatibility.",
    };
  }

  if (isTransportChannelClosedIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while talking to a downstream service. Check external MCP or model-provider compatibility.",
    };
  }

  if (isTransportBodyDecodeIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while decoding a downstream streaming response. Check the configured relay, proxy, or model-provider compatibility.",
    };
  }

  if (normalized.includes("stalled after turn start without producing a usable result")) {
    return {
      code: "PROVIDER_RESULT_STALLED",
      message: "Codex started the task but stopped making usable progress before producing a result.",
    };
  }

  if (normalized.includes("turn did not complete")) {
    return {
      code: "PROVIDER_TURN_STALLED",
      message: "Codex started a turn but never reached completion within the expected window.",
    };
  }

  if (normalized.includes("did not return a usable") || normalized.includes("returned an unusable")) {
    return {
      code: "PROVIDER_OUTPUT_INVALID",
      message: "Codex returned output that could not be parsed as the expected JSON result.",
    };
  }

  if (normalized.includes("unexpected token") || normalized.includes("json")) {
    return {
      code: "PROVIDER_OUTPUT_INVALID",
      message: "Codex returned output that could not be parsed as the expected JSON result.",
    };
  }

  if (normalized.includes("session") && normalized.includes("resume")) {
    return {
      code: "TASK_RESUME_UNAVAILABLE",
      message: "This task cannot be resumed because the provider session is unavailable.",
    };
  }

  return {
    code: "PROVIDER_EXECUTION_FAILED",
    message: message.trim() || "Codex execution failed.",
  };
}

export function classifyCodexRuntimeSignal(line: string): Omit<TaskRuntimeSignal, "count" | "lastSeenAt"> | null {
  const trimmed = line.trim();
  const normalized = trimmed.toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (normalized.includes("shell_snapshot") || normalized.includes("shell snapshot not supported")) {
    return {
      code: "PROVIDER_SHELL_SNAPSHOT_WARNING",
      severity: "noise",
      summary: "Provider shell snapshot support is unavailable for this shell.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("blocked by policy") ||
    normalized.includes("command is not permitted") ||
    normalized.includes("rejected: blocked by policy")
  ) {
    return {
      code: "PROVIDER_COMMAND_POLICY_WARNING",
      severity: "degraded",
      summary: "Provider command execution was restricted and runtime fell back to a narrower path.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("helper_firewall_rule_create_or_add_failed") ||
    (normalized.includes("windows sandbox") && normalized.includes("helper"))
  ) {
    return {
      code: "PROVIDER_WINDOWS_SANDBOX_WARNING",
      severity: "degraded",
      summary: "Windows sandbox helper blocked command execution; provider fell back to best-effort reasoning.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("unknown feature key in config") ||
    (normalized.includes("helper") &&
      !normalized.includes("helper_firewall_rule_create_or_add_failed") &&
      !(normalized.includes("windows sandbox") && normalized.includes("helper")))
  ) {
    return {
      code: "PROVIDER_RUNTIME_HELPER_WARNING",
      severity: "noise",
      summary: "Provider emitted a non-fatal helper or startup warning.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("falling back to http") ||
    normalized.includes("falling back from websockets to https transport") ||
    normalized.includes("startup websocket prewarm setup failed") ||
    normalized.includes("failed to connect to websocket") ||
    normalized.includes("reconnecting...") ||
    normalized.includes("stream disconnected before completion") ||
    normalized.includes("error decoding response body") ||
    normalized.includes("currently experiencing high demand")
  ) {
    return {
      code: "PROVIDER_TRANSPORT_FALLBACK",
      severity: "degraded",
      summary: "Provider transport fell back to a slower or narrower runtime path.",
      detail: trimmed,
    };
  }

  if (isTransportContentTypeIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
      severity: "degraded",
      summary: "Provider transport received an invalid or empty downstream response.",
      detail: trimmed,
    };
  }

  if (isTransportChannelClosedIssue(normalized)) {
    return {
      code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
      severity: "degraded",
      summary: "Provider transport channel closed before the result stream completed.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("401 unauthorized") ||
    normalized.includes("403 forbidden") ||
    normalized.includes("missing bearer") ||
    normalized.includes("missing bearer or basic authentication") ||
    normalized.includes("invalid api key")
  ) {
    return {
      code: "PROVIDER_AUTH_FAILED",
      severity: "fatal",
      summary: "Provider authentication failed while contacting the upstream model service.",
      detail: trimmed,
    };
  }

  if (
    normalized.includes("500 internal server error") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable")
  ) {
    return {
      code: "PROVIDER_UPSTREAM_UNAVAILABLE",
      severity: "fatal",
      summary: "Provider upstream connectivity or availability failed.",
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

export function sanitizeCodexConfig(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  const sanitized: string[] = [];
  let skippingTaskSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeader = /^\[.*\]$/.test(trimmed);

    if (isHeader) {
      skippingTaskSection = /^\[\[?\s*(?:mcp_servers|features)(?:[.\]])/i.test(trimmed);
      if (skippingTaskSection) {
        continue;
      }
    }

    if (skippingTaskSection) {
      continue;
    }

    sanitized.push(line);
  }

  return sanitized.join("\n").trimEnd() + "\n";
}

function buildBaseArgs(
  workspacePath: string | null,
  model: string | undefined,
  capabilities: CodexCliCapabilities,
  disabledFeatures: readonly string[] = TASK_DISABLED_FEATURES
): string[] {
  const args: string[] = [];
  if (capabilities.supportsAskForApproval) {
    args.push("--ask-for-approval", "never");
  }
  args.push("-c", "shell_environment_policy.inherit=all");
  if (process.platform === "win32") {
    // Avoid UAC prompts from the elevated Windows sandbox for unattended task runs.
    args.push("-c", "windows.sandbox=unelevated");
  }
  for (const feature of disabledFeatures) {
    args.push("-c", `features.${feature}=false`);
  }
  if (workspacePath) {
    args.push("-C", workspacePath);
  }
  if (model?.trim()) {
    args.push("-m", model.trim());
  }
  return args;
}
