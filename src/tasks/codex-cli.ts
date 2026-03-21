import * as path from "path";

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
  capabilities: CodexCliCapabilities;
}

export interface BuildResumeArgsOptions {
  workspacePath: string | null;
  sessionId: string;
  prompt: string;
  model?: string;
  outputPath?: string;
  capabilities: CodexCliCapabilities;
}

const BARE_EXECUTABLE = /^[A-Za-z0-9._-]+(?:\.exe|\.cmd|\.bat)?$/;

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
  const args = buildBaseArgs(options.workspacePath, options.model, options.capabilities);
  args.push("exec", "--json", "--sandbox", "read-only");
  if (!options.workspacePath) {
    args.push("--skip-git-repo-check");
  }
  if (options.schemaPath) {
    args.push("--output-schema", options.schemaPath);
  } else if (options.outputPath && options.capabilities.supportsOutputLastMessage) {
    args.push("--output-last-message", options.outputPath);
  }
  args.push(options.prompt);
  return args;
}

export function buildCodexResumeArgs(options: BuildResumeArgsOptions): string[] {
  const args = buildBaseArgs(options.workspacePath, options.model, options.capabilities);
  args.push("exec", "resume", "--json");
  if (!options.workspacePath) {
    args.push("--skip-git-repo-check");
  }
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

function buildBaseArgs(workspacePath: string | null, model: string | undefined, capabilities: CodexCliCapabilities): string[] {
  const args: string[] = [];
  if (capabilities.supportsAskForApproval) {
    args.push("--ask-for-approval", "never");
  }
  args.push("-c", "shell_environment_policy.inherit=all");
  if (workspacePath) {
    args.push("-C", workspacePath);
  }
  if (model?.trim()) {
    args.push("-m", model.trim());
  }
  return args;
}
