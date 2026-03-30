import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { ClawDriveConfig } from "../config";
import { commandFailure } from "../guards/errors";
import { log, logError } from "../logger";
import { taskResumePrompt } from "./text";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  classifyCodexCliFailure,
  classifyCodexRuntimeSignal,
  detectCodexCliCapabilities,
  sanitizeCodexConfig,
  validateCodexExecutablePath,
  type CodexCliCapabilities,
} from "./codex-cli";
import type { ProviderProbeResult, ProviderRunCallbacks, ProviderRunContext, TaskProvider } from "./provider";
import { commandFailure as commandFailureTypeGuard } from "../guards/errors";
import type {
  ApplyOperation,
  TaskApprovalRequest,
  TaskDecisionOption,
  TaskDecisionRequest,
  TaskMode,
  TaskRuntimeSignal,
  TaskProviderEvidence,
  TaskResponseInput,
  TaskRunResult,
} from "./types";

interface AnalyzeSchemaResponse {
  summary: string;
  details: string;
}

interface PlanSchemaResponse {
  summary: string;
  options: Array<{
    id: string;
    title: string;
    summary: string;
    recommended: boolean;
  }>;
}

interface ApplyDecisionSchemaResponse extends PlanSchemaResponse {
  stage: "decision";
}

interface ApplyApprovalSchemaResponse {
  stage: "approval";
  summary: string;
  operations: Array<
    | {
        type: "write_file";
        path: string;
        content: string;
      }
    | {
        type: "replace_text";
        path: string;
        oldText: string;
        newText: string;
      }
  >;
}

interface ApplyCompletedSchemaResponse {
  stage: "completed";
  summary: string;
  details: string;
}

type ApplySchemaResponse = ApplyDecisionSchemaResponse | ApplyApprovalSchemaResponse | ApplyCompletedSchemaResponse;

interface CodexRunCapture {
  sawTurnStarted: boolean;
  sawTurnCompleted: boolean;
  sawPostTurnItemActivity: boolean;
  turnStartedAt: number | null;
  lastProgressAt: number | null;
  lastOutputAt: number | null;
  lastActivityAt: number;
  lastSessionAt: number | null;
  lastAgentMessage: string | null;
  outputFileReady: boolean;
  stdoutEventTail: string[];
}

interface CodexCommandResult {
  stdout: string;
  stderr: string;
  capture: CodexRunCapture;
}

interface MessageCandidate {
  source: TaskProviderEvidence["finalMessageSource"];
  text: string;
}

interface ParsedPayload<T> {
  value: T;
  finalMessageSource: TaskProviderEvidence["finalMessageSource"];
}

interface OutputFileResult {
  message: string | null;
  status: TaskProviderEvidence["outputFileStatus"];
}

interface MessageResolution {
  message: string;
  source: TaskProviderEvidence["finalMessageSource"];
}

interface LocalWorkspaceSnapshot {
  lines: string[];
}

export class CodexCliProvider implements TaskProvider {
  readonly kind = "codex";
  private readonly capabilityCache = new Map<string, CodexCliCapabilities>();
  private readonly isolatedCodexHome = path.join(os.homedir(), ".clawdrive", "codex-home");
  private readonly extendedTaskCodexHome = path.join(os.homedir(), ".clawdrive", "codex-home-extended");
  private hasLoggedEnvironment = false;

  constructor(private readonly config: ClawDriveConfig) {}

  async probe(): Promise<ProviderProbeResult> {
    if (!this.config.providerEnabled || this.config.providerKind !== "codex") {
      return { ready: false, state: "disabled", detail: "Codex provider is disabled." };
    }

    try {
      const executable = await this.resolveExecutable();
      await this.getCapabilities(executable);
      return { ready: true, state: "ready", detail: `Using ${executable}.` };
    } catch (error) {
      const failure = classifyCodexCliFailure(error);
      return {
        ready: false,
        state: failure.code === "PROVIDER_EXECUTABLE_MISSING" ? "missing" : "error",
        detail: failure.message,
      };
    }
  }

  async startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult> {
    this.throwIfAborted(signal);
    const executable = await this.resolveExecutable();
    const env = await this.prepareCodexEnvironment();
    const capabilities = await this.getCapabilities(executable);
    const schemaPath =
      capabilities.supportsOutputSchema && context.mode
        ? await this.writeSchema(
            context.mode === "plan"
              ? this.planSchema()
              : context.mode === "apply"
                ? this.applyDecisionSchema()
                : this.analyzeSchema()
          )
        : null;
    const outputPath =
      !schemaPath && capabilities.supportsOutputLastMessage ? this.createTempFilePath("clawdrive-output", "json") : null;
    try {
      this.throwIfAborted(signal);
      const localWorkspaceSnapshot =
        context.mode === "plan" || context.mode === "analyze" ? await this.buildLocalWorkspaceSnapshot(context) : null;
      const prompt =
        context.mode === "plan"
          ? this.buildPlanPrompt(context, !schemaPath, localWorkspaceSnapshot)
          : context.mode === "apply"
            ? this.buildApplyDecisionPrompt(context, !schemaPath)
            : this.buildAnalyzePrompt(context, !schemaPath, localWorkspaceSnapshot);
      const raw = await this.runCommand(
        executable,
        buildCodexExecArgs({
          workspacePath: context.workspacePath,
          model: this.config.providerCodexModel,
          sandboxMode: this.config.providerSandboxMode,
          disabledFeatures: this.config.providerDisableFeatures,
          prompt,
          schemaPath: schemaPath ?? undefined,
          outputPath: outputPath ?? undefined,
          capabilities,
        }),
        context.workspacePath,
        signal,
        true,
        callbacks,
        env,
        outputPath,
        context.mode
      );
      const outputFile = outputPath
        ? await this.readOutputMessageWithRetry(outputPath)
        : { message: null, status: "not_used" as const };
      callbacks.onEvidence(this.buildRunEvidence(raw.capture, outputFile.status));
      if (context.mode === "plan") {
        return this.parsePlanResult(raw, outputFile.message, callbacks);
      }
      if (context.mode === "apply") {
        return this.parseApplyResult(raw, outputFile.message, callbacks);
      }
      return this.parseAnalyzeResult(raw, outputFile.message, callbacks);
    } catch (error) {
      const failure = classifyCodexCliFailure(error);
      throw commandFailure(failure.code, failure.message);
    } finally {
      await this.removeTempFile(schemaPath);
      await this.removeTempFile(outputPath);
    }
  }

  async resumeTask(
    context: ProviderRunContext,
    response: TaskResponseInput,
    callbacks: ProviderRunCallbacks,
    signal: AbortSignal
  ): Promise<TaskRunResult> {
    if (!context.sessionId) {
      throw commandFailure("TASK_RESUME_UNAVAILABLE", "This task has no provider session to resume.");
    }

    this.throwIfAborted(signal);
    const executable = await this.resolveExecutable();
    const env = await this.prepareCodexEnvironment();
    const capabilities = await this.getCapabilities(executable);
    const outputPath = capabilities.supportsResumeOutputLastMessage
      ? this.createTempFilePath("clawdrive-resume-output", "json")
      : null;
    try {
      this.throwIfAborted(signal);
      const prompt =
        context.mode === "apply"
          ? this.buildApplyResumePrompt(context, response, true)
          : this.buildResumePrompt(taskResumePrompt(undefined, response.message));
      const raw = await this.runCommand(
        executable,
        buildCodexResumeArgs({
          workspacePath: context.workspacePath,
          outputPath: outputPath ?? undefined,
          sessionId: context.sessionId,
          prompt,
          model: this.config.providerCodexModel,
          disabledFeatures: this.config.providerDisableFeatures,
          capabilities,
        }),
        context.workspacePath,
        signal,
        true,
        callbacks,
        env,
        outputPath,
        context.mode
      );
      const outputFile = outputPath
        ? await this.readOutputMessageWithRetry(outputPath)
        : { message: null, status: "not_used" as const };
      callbacks.onEvidence(this.buildRunEvidence(raw.capture, outputFile.status));
      const resolved = this.resolvePrimaryMessage(raw, outputFile.message);
      if (context.mode === "apply") {
        return this.parseApplyResult(raw, resolved.message, callbacks, resolved.source);
      }
      return this.parseAnalyzeMessage(resolved.message, callbacks, resolved.source);
    } catch (error) {
      const failure = classifyCodexCliFailure(error);
      throw commandFailure(failure.code, failure.message);
    } finally {
      await this.removeTempFile(outputPath);
    }
  }

  private async resolveExecutable(): Promise<string> {
    const configured = (this.config.providerCodexPath || "codex").trim();
    validateCodexExecutablePath(configured);
    if (path.isAbsolute(configured)) {
      await fs.access(configured);
      return configured;
    }

    const resolvedFromPath = await this.resolveFromPath(configured);
    if (resolvedFromPath) {
      return resolvedFromPath;
    }

    const resolvedFromKnownLocations = await this.resolveFromKnownLocations(configured);
    if (resolvedFromKnownLocations) {
      return resolvedFromKnownLocations;
    }

    throw new Error(
      `Codex executable was not found. Checked PATH and known VS Code extension locations for ${configured}.`
    );
  }

  private async resolveFromPath(configured: string): Promise<string | null> {
    const pathValue = process.env.PATH || process.env.Path || "";
    const segments = pathValue
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    const candidates = this.expandExecutableCandidates(configured);
    for (const segment of segments) {
      for (const candidate of candidates) {
        const fullPath = path.join(segment, candidate);
        try {
          await fs.access(fullPath);
          return fullPath;
        } catch {
          continue;
        }
      }
    }

    return null;
  }

  private async resolveFromKnownLocations(configured: string): Promise<string | null> {
    const home = os.homedir();
    const extensionRoots = [
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions"),
    ];

    const baseName = path.parse(configured).name.toLowerCase();
    for (const root of extensionRoots) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const chatgptExtensions = entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
          .sort((left, right) => right.name.localeCompare(left.name));

        for (const extension of chatgptExtensions) {
          const candidate = this.codexPathInsideExtension(root, extension.name);
          if (!candidate) {
            continue;
          }
          try {
            await fs.access(candidate);
            if (path.parse(candidate).name.toLowerCase() === baseName) {
              return candidate;
            }
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private codexPathInsideExtension(root: string, extensionName: string): string | null {
    const base = path.join(root, extensionName, "bin");
    if (process.platform === "win32") {
      return path.join(base, "windows-x86_64", "codex.exe");
    }
    if (process.platform === "darwin") {
      return path.join(base, process.arch === "arm64" ? "darwin-arm64" : "darwin-x86_64", "codex");
    }
    if (process.platform === "linux") {
      return path.join(base, process.arch === "arm64" ? "linux-arm64" : "linux-x86_64", "codex");
    }
    return null;
  }

  private expandExecutableCandidates(configured: string): string[] {
    if (process.platform !== "win32") {
      return [configured];
    }

    const lower = configured.toLowerCase();
    if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      return [configured];
    }

    return [configured, `${configured}.exe`, `${configured}.cmd`, `${configured}.bat`];
  }

  private async getCapabilities(executable: string): Promise<CodexCliCapabilities> {
    const cached = this.capabilityCache.get(executable);
    if (cached) {
      return cached;
    }

    const signal = new AbortController().signal;
    const env = await this.prepareCodexEnvironment();
    const [rootHelp, execHelp, resumeHelp] = await Promise.all([
      this.runCommand(executable, ["--help"], process.cwd(), signal, false, undefined, env, undefined, null),
      this.runCommand(executable, ["exec", "--help"], process.cwd(), signal, false, undefined, env, undefined, null),
      this.runCommand(executable, ["exec", "resume", "--help"], process.cwd(), signal, false, undefined, env, undefined, null),
    ]);
    const capabilities = detectCodexCliCapabilities(rootHelp.stdout, execHelp.stdout, resumeHelp.stdout);
    this.capabilityCache.set(executable, capabilities);
    return capabilities;
  }

  private async runCommand(
    executable: string,
    args: string[],
    cwd: string | null,
    signal: AbortSignal,
    parseEvents: boolean,
    callbacks?: ProviderRunCallbacks,
    env?: NodeJS.ProcessEnv,
    outputPath?: string | null,
    stallMode?: TaskMode | null
  ): Promise<CodexCommandResult> {
    this.throwIfAborted(signal);
    return await new Promise<CodexCommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: cwd ?? undefined,
        env: env ?? process.env,
        windowsHide: true,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      const capture: CodexRunCapture = {
        sawTurnStarted: false,
        sawTurnCompleted: false,
        sawPostTurnItemActivity: false,
        turnStartedAt: null,
        lastProgressAt: null,
        lastOutputAt: null,
        lastActivityAt: Date.now(),
        lastSessionAt: null,
        lastAgentMessage: null,
        outputFileReady: false,
        stdoutEventTail: [],
      };
      const finalizationGraceMs = this.getFinalizationGraceMs();
      const stalledWarningMs = this.getStalledWarningMs(stallMode ?? null);
      const stalledFailureMs = this.getStalledFailureMs(stallMode ?? null);
      const turnCompletionTimeoutMs = this.getTurnCompletionTimeoutMs(stallMode ?? null);
      const transportFailureGraceMs = this.getTransportFailureGraceMs();
      const postTurnTransportFailureGraceMs = this.getPostTurnTransportFailureGraceMs();
      const postResultGraceMs = this.getPostResultGraceMs();
      let stallWarningEmitted = false;
      let settled = false;
      let outputProbeInFlight = false;
      let transportWarningAt: number | null = null;
      let transportWarningLine: string | null = null;
      const flushStdoutBuffer = () => {
        if (!stdoutBuffer.trim()) {
          return;
        }
        const buffered = stdoutBuffer;
        stdoutBuffer = "";
        this.handleStdoutLine(buffered, capture, callbacks, handleRuntimeSignal);
      };
      const handleRuntimeSignal = (signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">, rawLine: string) => {
        if (signal.severity === "fatal") {
          child.kill();
          callbacks?.onEvidence({ finalizationPath: "timeout" });
          settle(() => reject(new Error(rawLine)));
          return;
        }
        if (this.isTransportDegradationSignal(signal.code)) {
          if (transportWarningAt === null || this.hasRecoveredSinceTransportWarning(transportWarningAt, capture)) {
            transportWarningAt = Date.now();
          }
          transportWarningLine = rawLine;
        }
      };
      const settle = (handler: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (stallTimer) {
          clearInterval(stallTimer);
        }
        handler();
      };
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
      const stallTimer =
        parseEvents && finalizationGraceMs > 0
          ? setInterval(() => {
              if (outputPath && !outputProbeInFlight && !capture.outputFileReady) {
                outputProbeInFlight = true;
                void fs
                  .readFile(outputPath, "utf8")
                  .then((raw) => {
                    if (raw.trim()) {
                      capture.outputFileReady = true;
                      capture.lastOutputAt = Date.now();
                    }
                  })
                  .catch((error) => {
                    if (!isMissingFileError(error)) {
                      logError(`codex output probe failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                  })
                  .finally(() => {
                    outputProbeInFlight = false;
                  });
              }
              if (
                transportWarningAt &&
                !capture.sawTurnStarted &&
                !capture.lastSessionAt &&
                !capture.lastAgentMessage &&
                !capture.outputFileReady
              ) {
                const transportIdleMs = Date.now() - transportWarningAt;
                if (transportIdleMs >= transportFailureGraceMs) {
                  child.kill();
                  callbacks?.onEvidence({ finalizationPath: "timeout" });
                  settle(() =>
                    reject(
                      new Error(
                        transportWarningLine ??
                          "transport channel closed before the provider turn started."
                      )
                    )
                  );
                  return;
                }
              }
              if (
                transportWarningAt &&
                capture.sawTurnStarted &&
                !capture.sawTurnCompleted &&
                !capture.lastAgentMessage &&
                !capture.outputFileReady &&
                !this.hasRecoveredSinceTransportWarning(transportWarningAt, capture)
              ) {
                const transportIdleMs = Date.now() - transportWarningAt;
                if (transportIdleMs >= postTurnTransportFailureGraceMs) {
                  child.kill();
                  callbacks?.onEvidence({ finalizationPath: "timeout" });
                  settle(() =>
                    reject(
                      new Error(
                        transportWarningLine ??
                          "transport stream disconnected after the provider turn started."
                      )
                    )
                  );
                  return;
                }
              }
              if (!capture.sawTurnCompleted) {
                const pendingTransportFailure = this.getPendingPostTurnTransportFailure(
                  transportWarningAt,
                  transportWarningLine,
                  capture
                );
                if (capture.sawTurnStarted && capture.turnStartedAt) {
                  const turnElapsedMs = Date.now() - capture.turnStartedAt;
                  if (turnElapsedMs >= turnCompletionTimeoutMs) {
                    child.kill();
                    callbacks?.onEvidence({ finalizationPath: "timeout" });
                    settle(() =>
                      reject(
                        new Error(
                          pendingTransportFailure ??
                            `Codex turn did not complete within ${Math.round(turnElapsedMs / 1000)}s after turn start.`
                        )
                      )
                    );
                    return;
                  }
                }
                const quietPlanTurn =
                  stallMode === "plan" && !capture.sawPostTurnItemActivity && !capture.lastOutputAt;
                const semanticAnchor = quietPlanTurn
                  ? capture.turnStartedAt ?? capture.lastSessionAt
                  : capture.lastOutputAt ?? capture.lastProgressAt ?? capture.lastSessionAt;
                if (!capture.sawTurnStarted || capture.lastAgentMessage || !semanticAnchor) {
                  return;
                }
                const idleMs = Date.now() - semanticAnchor;
                const warningThresholdMs = capture.sawPostTurnItemActivity
                  ? this.getActiveWorkStalledWarningMs(stalledFailureMs, stallMode ?? null)
                  : stalledWarningMs;
                if (!stallWarningEmitted && idleMs >= warningThresholdMs) {
                  stallWarningEmitted = true;
                  callbacks?.onRuntimeSignal(
                    {
                      code: "PROVIDER_RESULT_STALL_WARNING",
                      severity: "degraded",
                      summary: "Provider task is still running but has not produced usable output for a while.",
                      detail: capture.sawPostTurnItemActivity
                        ? `No provider-visible progress after earlier task activity for ${Math.round(idleMs / 1000)}s.`
                        : `No provider output after turn start for ${Math.round(idleMs / 1000)}s.`,
                    },
                    capture.sawPostTurnItemActivity
                      ? `No provider-visible progress after earlier task activity for ${Math.round(idleMs / 1000)}s.`
                      : `No provider output after turn start for ${Math.round(idleMs / 1000)}s.`
                  );
                  callbacks?.onProgress(
                    capture.sawPostTurnItemActivity
                      ? "Provider is still running a long step, but no new visible progress has appeared for a while."
                      : "Provider is still running, but result generation appears stalled."
                  );
                }
                if (quietPlanTurn || idleMs < stalledFailureMs) {
                  return;
                }
                child.kill();
                settle(() =>
                  reject(
                    new Error(
                      pendingTransportFailure ?? "Codex task stalled after turn start without producing a usable result."
                    )
                  )
                );
                return;
              }
              const anchor = capture.lastOutputAt ?? capture.lastProgressAt ?? capture.lastActivityAt;
              const idleMs = Date.now() - anchor;
              if ((capture.lastAgentMessage || capture.outputFileReady) && idleMs >= postResultGraceMs) {
                flushStdoutBuffer();
                child.kill();
                settle(() => resolve({ stdout, stderr, capture }));
                return;
              }
              if (idleMs < finalizationGraceMs) {
                return;
              }
              child.kill();
              callbacks?.onEvidence({ finalizationPath: "timeout" });
              settle(() => reject(new Error("Codex turn completed but no final result arrived before provider finalization timeout.")));
            }, Math.min(1_000, Math.max(250, Math.floor(finalizationGraceMs / 4))))
          : null;
      stallTimer?.unref?.();

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        capture.lastActivityAt = Date.now();
        stdout += text;
        if (!parseEvents) {
          return;
        }
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          this.handleStdoutLine(line, capture, callbacks, handleRuntimeSignal);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        capture.lastActivityAt = Date.now();
        stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          logError(`codex: ${line}`);
          const signal = classifyCodexRuntimeSignal(line);
          if (signal) {
            this.forwardRuntimeSignal(signal, line, capture, callbacks, handleRuntimeSignal);
          }
        }
      });

      child.once("error", (error) => {
        settle(() => reject(error));
      });

      child.once("close", (code, closeSignal) => {
        flushStdoutBuffer();
        if (signal.aborted) {
          settle(() => reject(new Error(String(signal.reason ?? "aborted"))));
          return;
        }
        if (code === 0) {
          settle(() => resolve({ stdout, stderr, capture }));
          return;
        }
        void (async () => {
          if (!capture.lastAgentMessage && !capture.outputFileReady && outputPath) {
            const outputFile = await this.readOutputMessageWithRetry(outputPath);
            if (outputFile.message) {
              capture.outputFileReady = true;
              capture.lastOutputAt = capture.lastOutputAt ?? Date.now();
            }
          }
          if (capture.lastAgentMessage || capture.outputFileReady) {
            settle(() => resolve({ stdout, stderr, capture }));
            return;
          }
          const pendingTransportFailure = this.getPendingPostTurnTransportFailure(
            transportWarningAt,
            transportWarningLine,
            capture
          );
          const fallbackMessage =
            pendingTransportFailure ?? stderr.trim() ?? stdout.trim() ?? `codex exited with code ${code ?? "unknown"} (${closeSignal ?? "no-signal"})`;
          settle(() =>
            reject(new Error(fallbackMessage || `codex exited with code ${code ?? "unknown"} (${closeSignal ?? "no-signal"})`))
          );
        })().catch((error) => {
          settle(() => reject(error instanceof Error ? error : new Error(String(error))));
        });
      });
    });
  }

  private handleStdoutLine(
    line: string,
    capture: CodexRunCapture,
    callbacks?: ProviderRunCallbacks,
    onSignal?: (signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">, rawLine: string) => void
  ): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const now = Date.now();
    capture.lastActivityAt = now;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      capture.stdoutEventTail = [...capture.stdoutEventTail, this.describeStdoutEvent(type, parsed)].slice(-8);
      if (type.startsWith("item.")) {
        capture.lastProgressAt = now;
        if (capture.sawTurnStarted) {
          capture.sawPostTurnItemActivity = true;
        }
      }
      if (type === "thread.started" && typeof parsed.thread_id === "string") {
        capture.lastSessionAt = now;
        callbacks?.onEvidence(this.buildRunEvidence(capture, "not_used"));
        callbacks?.onSessionId(parsed.thread_id);
        return;
      }
      if (type === "turn.started") {
        capture.sawTurnStarted = true;
        capture.turnStartedAt = capture.turnStartedAt ?? now;
        capture.lastProgressAt = now;
        callbacks?.onEvidence(this.buildRunEvidence(capture, "not_used"));
        callbacks?.onProgress("Codex task turn started.");
        return;
      }
      if (type === "turn.completed") {
        capture.sawTurnCompleted = true;
        capture.lastProgressAt = now;
        callbacks?.onEvidence(this.buildRunEvidence(capture, "not_used"));
        callbacks?.onProgress("Codex task turn completed. Finalizing result.");
        return;
      }
      if (type === "error" && typeof parsed.message === "string") {
        const signal = classifyCodexRuntimeSignal(parsed.message);
        if (signal) {
          this.forwardRuntimeSignal(signal, parsed.message, capture, callbacks, onSignal);
        }
        return;
      }
      if (type === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          capture.lastAgentMessage = item.text;
          capture.lastOutputAt = now;
          callbacks?.onEvidence({
            lastAgentMessagePreview: previewText(item.text),
            stdoutEventTail: capture.stdoutEventTail,
          });
          callbacks?.onOutput(item.text);
          callbacks?.onProgress("Received Codex output.");
          return;
        }
        if (item?.type === "error" && typeof item.message === "string") {
          const signal = classifyCodexRuntimeSignal(item.message);
          if (signal) {
            this.forwardRuntimeSignal(signal, item.message, capture, callbacks, onSignal);
          }
        }
      }
    } catch {
      log(`codex stdout: ${trimmed}`);
    }
  }

  private parseAnalyzeResult(
    raw: CodexCommandResult,
    finalMessage?: string | null,
    callbacks?: ProviderRunCallbacks
  ): TaskRunResult {
    const parsed = this.parsePayload<AnalyzeSchemaResponse>("analysis result", this.buildMessageCandidates(raw, finalMessage));
    return {
      summary: parsed.value.summary.trim(),
      output: parsed.value.details.trim(),
      decision: null,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
        lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
      },
    };
  }

  private parseAnalyzeMessage(
    message: string,
    callbacks?: ProviderRunCallbacks,
    source: TaskProviderEvidence["finalMessageSource"] = "direct_message"
  ): TaskRunResult {
    const parsed = this.parsePayload<AnalyzeSchemaResponse>("analysis result", [{ source, text: message }]);
    return {
      summary: parsed.value.summary.trim(),
      output: parsed.value.details.trim(),
      decision: null,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
        lastAgentMessagePreview: previewText(message),
      },
    };
  }

  private parsePlanResult(
    raw: CodexCommandResult,
    finalMessage?: string | null,
    callbacks?: ProviderRunCallbacks
  ): TaskRunResult {
    const candidates = this.buildMessageCandidates(raw, finalMessage);
    let parsed: ParsedPayload<PlanSchemaResponse> | null = null;
    try {
      parsed = this.parsePayload<PlanSchemaResponse>("plan result", candidates);
    } catch (error) {
      const fallback = this.parsePlanFromText(candidates);
      if (fallback) {
        callbacks?.onRuntimeSignal(
          {
            code: "PROVIDER_PLAN_DEGRADED_OUTPUT",
            severity: "degraded",
            summary: "Provider returned non-JSON plan output; using degraded option extraction.",
            detail: "Parsed plan options from prose because structured JSON was unavailable.",
          },
          "Parsed plan options from prose because structured JSON was unavailable."
        );
        return {
          summary: fallback.decision.summary,
          output: fallback.decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
          decision: fallback.decision,
          providerEvidence: {
            finalMessageSource: fallback.source,
            finalizationPath: this.toFinalizationPath(fallback.source),
            lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
          },
        };
      }
      throw error;
    }
    const decision: TaskDecisionRequest = {
      summary: parsed.value.summary.trim(),
      options: parsed.value.options.map((option) => ({
        id: option.id.trim(),
        title: option.title.trim(),
        summary: option.summary.trim(),
        recommended: option.recommended,
      })),
      recommendedOptionId: parsed.value.options.find((option) => option.recommended)?.id ?? null,
    };
    return {
      summary: decision.summary,
      output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
      decision,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
        lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
      },
    };
  }

  private parseApplyResult(
    raw: CodexCommandResult,
    finalMessage?: string | null,
    callbacks?: ProviderRunCallbacks,
    sourceOverride?: TaskProviderEvidence["finalMessageSource"]
  ): TaskRunResult {
    const candidates = this.buildMessageCandidates(raw, finalMessage);
    if (sourceOverride && finalMessage) {
      candidates.unshift({ source: sourceOverride, text: finalMessage });
    }
    const parsed = this.parsePayload<ApplySchemaResponse>("apply result", candidates);
    if (parsed.value.stage === "decision") {
      const decision: TaskDecisionRequest = {
        summary: parsed.value.summary.trim(),
        options: parsed.value.options.map((option) => ({
          id: option.id.trim(),
          title: option.title.trim(),
          summary: option.summary.trim(),
          recommended: option.recommended,
        })),
        recommendedOptionId: parsed.value.options.find((option) => option.recommended)?.id ?? null,
      };
      return {
        summary: decision.summary,
        output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
        decision,
        providerEvidence: {
          finalMessageSource: parsed.finalMessageSource,
          finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
          lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
        },
      };
    }

    if (parsed.value.stage === "approval") {
      const approval: TaskApprovalRequest = {
        summary: parsed.value.summary.trim(),
        operations: parsed.value.operations.map((operation) => this.parseApplyOperation(operation)),
      };
      return {
        summary: approval.summary,
        output: approval.operations.map((operation) => this.describeApplyOperation(operation)).join("\n"),
        approval,
        providerEvidence: {
          finalMessageSource: parsed.finalMessageSource,
          finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
          lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
        },
      };
    }

    return {
      summary: parsed.value.summary.trim(),
      output: parsed.value.details.trim(),
      decision: null,
      approval: null,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        finalizationPath: this.toFinalizationPath(parsed.finalMessageSource),
        lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
      },
    };
  }

  private buildMessageCandidates(raw: CodexCommandResult, finalMessage?: string | null): MessageCandidate[] {
    const candidates: MessageCandidate[] = [];
    if (finalMessage?.trim()) {
      candidates.push({ source: "output_file", text: finalMessage });
    }
    if (raw.capture.lastAgentMessage?.trim()) {
      candidates.push({ source: "stream_capture", text: raw.capture.lastAgentMessage });
    }
    try {
      const stdoutMessage = this.extractLastAgentMessage(raw.stdout);
      candidates.push({ source: "stdout_scan", text: stdoutMessage });
    } catch {
      // Ignore and continue with the candidates that were captured earlier.
    }
    return candidates;
  }

  private resolvePrimaryMessage(raw: CodexCommandResult, finalMessage?: string | null): MessageResolution {
    const candidates = this.buildMessageCandidates(raw, finalMessage);
    if (candidates.length === 0) {
      throw new Error("Codex did not return a final agent message.");
    }
    return { message: candidates[0].text, source: candidates[0].source };
  }

  private parsePayload<T>(label: string, candidates: MessageCandidate[]): ParsedPayload<T> {
    const errors: string[] = [];
    for (const candidate of candidates) {
      const normalized = stripMarkdownCodeFence(candidate.text);
      try {
        return { value: JSON.parse(normalized) as T, finalMessageSource: candidate.source };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      const extracted = extractEmbeddedJsonObject(normalized);
      if (!extracted) {
        continue;
      }
      try {
        return { value: JSON.parse(extracted) as T, finalMessageSource: "embedded_json" };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (candidates.length === 0) {
      throw new Error(`Codex did not return a usable ${label}.`);
    }
    throw new Error(`Codex returned an unusable ${label}. ${errors[errors.length - 1] ?? ""}`.trim());
  }

  private parsePlanFromText(
    candidates: MessageCandidate[]
  ): { decision: TaskDecisionRequest; source: TaskProviderEvidence["finalMessageSource"] } | null {
    for (const candidate of candidates) {
      const text = candidate.text;
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const options: TaskDecisionOption[] = [];
      let summary: string | null = null;

      for (const line of lines) {
        if (!summary && !/option|方案|选项/i.test(line)) {
          summary = line;
        }

        const match =
          line.match(/^(?:option[\s_-]*([a-z0-9]+)|Option\s+([A-Z0-9]+)|方案\s*([A-Z0-9一二三四])|选项\s*([A-Z0-9一二三四]))\s*[:：.\-]\s*(.+)$/i);
        if (!match) {
          continue;
        }
        const rawId = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? "").toString();
        const normalizedId = normalizeOptionId(rawId);
        const remainder = match[5]?.trim() ?? "";
        const [title, summaryText] = splitTitleSummary(remainder);
        const recommended = /\brecommended\b|\b推荐\b|\b建议\b/i.test(line);
        options.push({
          id: normalizedId,
          title: title || normalizedId,
          summary: summaryText || title || remainder || normalizedId,
          recommended,
        });
      }

      if (options.length >= 2) {
        const recommendedOptionId = options.find((option) => option.recommended)?.id ?? null;
        return {
          decision: {
            summary: summary ?? "Plan options extracted from provider output.",
            options,
            recommendedOptionId,
          },
          source: candidate.source,
        };
      }
    }
    return null;
  }

  private toFinalizationPath(
    source: TaskProviderEvidence["finalMessageSource"]
  ): TaskProviderEvidence["finalizationPath"] {
    if (source === "embedded_json") {
      return "embedded_json";
    }
    if (source === "output_file") {
      return "output_file";
    }
    if (source === "stream_capture" || source === "direct_message") {
      return "stream_capture";
    }
    if (source === "stdout_scan") {
      return "stdout_scan";
    }
    return "none";
  }

  private extractLastAgentMessage(raw: string): string {
    let lastText = "";
    for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.type !== "item.completed") {
          continue;
        }
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          lastText = item.text;
        }
      } catch {
        continue;
      }
    }
    if (!lastText) {
      throw new Error("Codex did not return a final agent message.");
    }
    return lastText;
  }

  private buildAnalyzePrompt(
    context: ProviderRunContext,
    forceJsonReply: boolean,
    localWorkspaceSnapshot?: LocalWorkspaceSnapshot | null
  ): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files, run mutating commands, or suggest applying changes now.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not call request_user_input, ask the user follow-up questions, or wait for user input. Return the best possible answer in a single response.",
      "Default to reasoning from the prompt, focus paths, and common repository conventions instead of shell exploration.",
      "Use the deterministic local workspace context below before considering shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "Only use a shell command if it is strictly necessary after exhausting the provided local context.",
      "If a shell command is blocked by policy or unavailable, do not retry with more shell commands. Continue with a best-effort answer and state the limitation briefly.",
      "If you need shell commands, keep them minimal, targeted, and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer cmd.exe built-ins (dir, type, findstr) over PowerShell cmdlets like Get-ChildItem.",
      "Avoid PowerShell-based directory scans unless absolutely required.",
      "If the task will take multiple investigation steps, emit a short todo list or progress item before long reasoning so the runtime does not stay silent after turn start.",
      "Produce a concise explanation and a more detailed analysis.",
      `User request: ${context.prompt}`,
    ];
    if (forceJsonReply) {
      lines.push('Return a raw JSON object only in this shape: {"summary":"...","details":"..."}');
      lines.push("Do not wrap the JSON in markdown fences.");
    }
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    if (localWorkspaceSnapshot?.lines.length) {
      lines.push("Deterministic local workspace context:");
      lines.push(...localWorkspaceSnapshot.lines);
    }
    return lines.join("\n");
  }

  private buildPlanPrompt(
    context: ProviderRunContext,
    forceJsonReply: boolean,
    localWorkspaceSnapshot?: LocalWorkspaceSnapshot | null
  ): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not call request_user_input, ask the user to choose, or wait for user input. Return the full option set in this response.",
      "Default to reasoning from the prompt, focus paths, and common repository conventions instead of shell exploration.",
      "Use the deterministic local workspace context below before considering shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "Only use a shell command if it is strictly necessary after exhausting the provided local context.",
      "If a shell command is blocked by policy or unavailable, do not retry with more shell commands. Continue with a best-effort plan and state the limitation briefly.",
      "If you need shell commands, keep them minimal, targeted, and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer cmd.exe built-ins (dir, type, findstr) over PowerShell cmdlets like Get-ChildItem.",
      "Avoid PowerShell-based directory scans unless absolutely required.",
      "If the task will take multiple investigation steps, emit a short todo list or progress item before long reasoning so the runtime does not stay silent after turn start.",
      "Return 2 to 4 meaningful implementation options and mark exactly one option as recommended.",
      "Each option must be distinct and concise.",
      `User request: ${context.prompt}`,
    ];
    if (forceJsonReply) {
      lines.push(
        'Return a raw JSON object only in this shape: {"summary":"...","options":[{"id":"option_a","title":"...","summary":"...","recommended":true}]}'
      );
      lines.push("Do not wrap the JSON in markdown fences.");
    }
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    if (localWorkspaceSnapshot?.lines.length) {
      lines.push("Deterministic local workspace context:");
      lines.push(...localWorkspaceSnapshot.lines);
    }
    return lines.join("\n");
  }

  private buildApplyDecisionPrompt(context: ProviderRunContext, forceJsonReply: boolean): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not call request_user_input, ask the user to choose, or wait for user input. Return decision options directly in this response.",
      "Default to reasoning from the prompt and focus paths instead of shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "If a shell command is blocked by policy or unavailable, continue with a best-effort implementation decision instead of retrying with more shell commands.",
      "Do not execute shell writes, git commands, tests, formatting, or terminal-based edits.",
      "On Windows, prefer cmd.exe built-ins (dir, type, findstr) over PowerShell cmdlets like Get-ChildItem.",
      "Avoid PowerShell-based directory scans unless absolutely required.",
      "First decide on an implementation direction before proposing concrete file operations.",
      "Return 2 to 4 meaningful implementation options and mark exactly one option as recommended.",
      `User request: ${context.prompt}`,
    ];
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    if (forceJsonReply) {
      lines.push(
        'Return a raw JSON object only in this shape: {"stage":"decision","summary":"...","options":[{"id":"option_a","title":"...","summary":"...","recommended":true}]}'
      );
      lines.push("Do not wrap the JSON in markdown fences.");
    }
    return lines.join("\n");
  }

  private buildApplyResumePrompt(context: ProviderRunContext, response: TaskResponseInput, forceJsonReply: boolean): string {
    const selected = response.optionId ? `The user chose option ${response.optionId}.` : response.message?.trim() ?? "Continue the task.";
    const lines = [
      selected,
      "Stay read-only. Do not modify files yourself.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Produce a structured apply proposal using only supported operations: write_file and replace_text.",
      "Do not use delete, rename, shell commands, git, terminal, tests, or formatting steps.",
      "Paths must stay inside the workspace and should be returned as workspace-relative paths when possible.",
    ];

    if (context.resumeFromState === "interrupted" && !context.decision) {
      lines.push("If you still need a user decision, return stage=decision again.");
    } else {
      lines.push("Return stage=approval with a concise summary and the exact file operations needed.");
    }

    if (forceJsonReply) {
      lines.push(
        'Return a raw JSON object only. Use one of: {"stage":"decision","summary":"...","options":[...]}, {"stage":"approval","summary":"...","operations":[{"type":"write_file","path":"...","content":"..."},{"type":"replace_text","path":"...","oldText":"...","newText":"..."}]}, or {"stage":"completed","summary":"...","details":"..."}.'
      );
      lines.push("Do not wrap the JSON in markdown fences.");
    }

    return lines.join("\n");
  }

  private buildResumePrompt(prompt: string): string {
    return [
      prompt,
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not ask follow-up questions or wait for user input. Return the best possible result in one reply.",
      "Return a raw JSON object only.",
      'Use exactly this shape: {"summary":"...","details":"..."}',
      "Do not wrap the JSON in markdown fences.",
    ].join("\n");
  }

  private analyzeSchema(): string {
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          summary: { type: "string" },
          details: { type: "string" },
        },
        required: ["summary", "details"],
        additionalProperties: false,
      },
      null,
      2
    );
  }

  private planSchema(): string {
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          summary: { type: "string" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                summary: { type: "string" },
                recommended: { type: "boolean" },
              },
              required: ["id", "title", "summary", "recommended"],
              additionalProperties: false,
            },
          },
        },
        required: ["summary", "options"],
        additionalProperties: false,
      },
      null,
      2
    );
  }

  private applyDecisionSchema(): string {
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          stage: { const: "decision" },
          summary: { type: "string" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                summary: { type: "string" },
                recommended: { type: "boolean" },
              },
              required: ["id", "title", "summary", "recommended"],
              additionalProperties: false,
            },
          },
        },
        required: ["stage", "summary", "options"],
        additionalProperties: false,
      },
      null,
      2
    );
  }

  private applyApprovalSchema(): string {
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          stage: { const: "approval" },
          summary: { type: "string" },
          operations: {
            type: "array",
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: "object",
                  properties: {
                    type: { const: "write_file" },
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["type", "path", "content"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "replace_text" },
                    path: { type: "string" },
                    oldText: { type: "string" },
                    newText: { type: "string" },
                  },
                  required: ["type", "path", "oldText", "newText"],
                  additionalProperties: false,
                },
              ],
            },
          },
        },
        required: ["stage", "summary", "operations"],
        additionalProperties: false,
      },
      null,
      2
    );
  }

  private applyUnionSchema(): string {
    return JSON.stringify(
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [
          JSON.parse(this.applyDecisionSchema()),
          JSON.parse(this.applyApprovalSchema()),
          {
            type: "object",
            properties: {
              stage: { const: "completed" },
              summary: { type: "string" },
              details: { type: "string" },
            },
            required: ["stage", "summary", "details"],
            additionalProperties: false,
          },
        ],
      },
      null,
      2
    );
  }

  private async writeSchema(content: string): Promise<string> {
    const filePath = this.createTempFilePath("clawdrive-schema", "json");
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }

  private createTempFilePath(prefix: string, extension: string): string {
    return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.${extension}`);
  }

  private async readOutputMessage(
    filePath: string
  ): Promise<OutputFileResult> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const trimmed = raw.trim();
      return {
        message: trimmed ? trimmed : null,
        status: trimmed ? "present" : "empty",
      };
    } catch (error) {
      if (isMissingFileError(error)) {
        return { message: null, status: "missing" };
      }
      throw error;
    }
  }

  private async readOutputMessageWithRetry(filePath: string): Promise<OutputFileResult> {
    const maxAttempts = 5;
    const delayMs = 150;
    let lastRaw: string | null = null;
    let stableReads = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const raw = await fs.readFile(filePath, "utf8");
        if (raw === lastRaw) {
          stableReads += 1;
        } else {
          lastRaw = raw;
          stableReads = 0;
        }
        if (stableReads >= 1 || attempt === maxAttempts - 1) {
          const trimmed = raw.trim();
          return {
            message: trimmed ? trimmed : null,
            status: trimmed ? "present" : "empty",
          };
        }
      } catch (error) {
        if (!isMissingFileError(error)) {
          throw error;
        }
        if (attempt === maxAttempts - 1) {
          return { message: null, status: "missing" };
        }
      }
      await delay(delayMs);
    }

    return { message: null, status: "missing" };
  }

  private getFinalizationGraceMs(): number {
    return Math.max(1_000, Math.min(15_000, Math.floor(this.config.tasksDefaultTimeoutMs / 20) || 0));
  }

  private getStalledWarningMs(mode: TaskMode | null): number {
    const base = Math.max(3_000, Math.min(30_000, Math.floor(this.config.tasksDefaultTimeoutMs / 6) || 0));
    if (mode !== "plan") {
      return base;
    }
    const planQuietTurnBudget = Math.min(60_000, Math.floor(this.config.tasksDefaultTimeoutMs / 4) || 0);
    return Math.max(base, planQuietTurnBudget);
  }

  private getStalledFailureMs(mode: TaskMode | null): number {
    const base = Math.max(
      this.getStalledWarningMs(mode) + 2_000,
      Math.min(90_000, Math.floor(this.config.tasksDefaultTimeoutMs / 3) || 0)
    );
    if (mode !== "plan") {
      return base;
    }
    const planFloor = Math.min(180_000, Math.floor(this.config.tasksDefaultTimeoutMs * 0.6) || 0);
    return Math.max(base, planFloor);
  }

  private getActiveWorkStalledWarningMs(stalledFailureMs: number, mode: TaskMode | null): number {
    const candidate = Math.floor(stalledFailureMs * 0.8) || 0;
    return Math.max(this.getStalledWarningMs(mode), Math.min(stalledFailureMs - 1_000, candidate));
  }

  private getTurnCompletionTimeoutMs(mode: TaskMode | null): number {
    const base = Math.floor(this.config.tasksDefaultTimeoutMs * 0.6) || 0;
    if (mode !== "plan") {
      return Math.max(15_000, Math.min(this.config.tasksDefaultTimeoutMs - 5_000, base));
    }
    const planQuietTurnBudget = Math.min(
      this.config.tasksDefaultTimeoutMs - 5_000,
      Math.floor(this.config.tasksDefaultTimeoutMs * 0.8) || 0
    );
    return Math.max(15_000, Math.max(base, planQuietTurnBudget));
  }

  private getTransportFailureGraceMs(): number {
    const base = Math.floor(this.config.tasksDefaultTimeoutMs / 20) || 0;
    return Math.max(2_000, Math.min(8_000, base));
  }

  private getPostTurnTransportFailureGraceMs(): number {
    const base = Math.floor(this.config.tasksDefaultTimeoutMs / 12) || 0;
    return Math.max(4_000, Math.min(25_000, base));
  }

  private getPostResultGraceMs(): number {
    return Math.max(750, Math.min(5_000, Math.floor(this.config.tasksDefaultTimeoutMs / 40) || 0));
  }

  private isTransportDegradationSignal(code: string): boolean {
    return code === "PROVIDER_TRANSPORT_RUNTIME_WARNING" || code === "PROVIDER_TRANSPORT_FALLBACK";
  }

  private async buildLocalWorkspaceSnapshot(context: ProviderRunContext): Promise<LocalWorkspaceSnapshot | null> {
    if (!context.workspacePath) {
      return null;
    }

    const lines: string[] = [];
    lines.push(`- Workspace root: ${context.workspacePath}`);

    const rootEntries = await this.safeReadDirEntries(context.workspacePath);
    if (rootEntries.length) {
      const visibleDirectories = rootEntries
        .filter((entry) => entry.type === "directory")
        .map((entry) => entry.name)
        .filter((name) => this.isUsefulTopLevelEntry(name))
        .slice(0, 8);
      const visibleFiles = rootEntries
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.name)
        .filter((name) => this.isUsefulTopLevelEntry(name))
        .slice(0, 8);
      if (visibleDirectories.length) {
        lines.push(`- Top-level directories: ${visibleDirectories.join(", ")}`);
      }
      if (visibleFiles.length) {
        lines.push(`- Top-level files: ${visibleFiles.join(", ")}`);
      }
    }

    const packageSummary = await this.readPackageJsonSnapshot(context.workspacePath);
    if (packageSummary) {
      lines.push(`- package.json: ${packageSummary}`);
    }

    for (const relativeDir of ["src/commands", "src/routing", "src/tasks"]) {
      const summary = await this.describeWorkspaceSubdirectory(context.workspacePath, relativeDir);
      if (summary) {
        lines.push(summary);
      }
    }

    if (context.paths.length) {
      const focusLines = await Promise.all(
        context.paths.slice(0, 4).map(async (focusPath) => {
          const resolved = path.isAbsolute(focusPath) ? focusPath : path.join(context.workspacePath ?? "", focusPath);
          try {
            const stat = await fs.stat(resolved);
            return `- Focus path ${focusPath}: ${stat.isDirectory() ? "directory" : "file"} present`;
          } catch {
            return `- Focus path ${focusPath}: not readable from the current workspace snapshot`;
          }
        })
      );
      lines.push(...focusLines);
    }

    return lines.length ? { lines } : null;
  }

  private async safeReadDirEntries(
    directoryPath: string
  ): Promise<Array<{ name: string; type: "file" | "directory" | "other" }>> {
    try {
      const entries = await fs.readdir(directoryPath, { withFileTypes: true });
      return entries
        .map((entry) => ({
          name: entry.name,
          type: (entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other") as
            | "directory"
            | "file"
            | "other",
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return [];
    }
  }

  private isUsefulTopLevelEntry(name: string): boolean {
    const hiddenAllowed = new Set([".vscode"]);
    if (name.startsWith(".") && !hiddenAllowed.has(name)) {
      return false;
    }
    return !["node_modules", "out", "out-test"].includes(name);
  }

  private async readPackageJsonSnapshot(workspacePath: string): Promise<string | null> {
    const packageJsonPath = path.join(workspacePath, "package.json");
    try {
      const raw = await fs.readFile(packageJsonPath, "utf8");
      const parsed = JSON.parse(raw) as {
        name?: string;
        displayName?: string;
        version?: string;
        main?: string;
        activationEvents?: unknown;
      };
      const activationEvents = Array.isArray(parsed.activationEvents)
        ? parsed.activationEvents.filter((value): value is string => typeof value === "string").slice(0, 4)
        : [];
      const parts = [
        parsed.name ? `name=${parsed.name}` : null,
        parsed.displayName ? `displayName=${parsed.displayName}` : null,
        parsed.version ? `version=${parsed.version}` : null,
        parsed.main ? `main=${parsed.main}` : null,
        activationEvents.length ? `activationEvents=${activationEvents.join("|")}` : null,
      ].filter((value): value is string => Boolean(value));
      return parts.length ? parts.join(", ") : null;
    } catch {
      return null;
    }
  }

  private async describeWorkspaceSubdirectory(workspacePath: string, relativeDir: string): Promise<string | null> {
    const absoluteDir = path.join(workspacePath, relativeDir);
    const entries = await this.safeReadDirEntries(absoluteDir);
    const files = entries
      .filter((entry) => entry.type === "file")
      .map((entry) => entry.name)
      .slice(0, 8);
    if (!files.length) {
      return null;
    }
    return `- ${relativeDir} files: ${files.join(", ")}`;
  }

  private getPendingPostTurnTransportFailure(
    transportWarningAt: number | null,
    transportWarningLine: string | null,
    capture: CodexRunCapture
  ): string | null {
    if (
      !transportWarningAt ||
      !capture.sawTurnStarted ||
      capture.sawTurnCompleted ||
      capture.lastAgentMessage ||
      capture.outputFileReady
    ) {
      return null;
    }
    if (this.hasSemanticRecoverySinceTransportWarning(transportWarningAt, capture)) {
      return null;
    }
    return transportWarningLine ?? "transport stream disconnected after the provider turn started.";
  }

  private hasRecoveredSinceTransportWarning(at: number, capture: CodexRunCapture): boolean {
    if (!capture.sawTurnStarted) {
      return Boolean(
        (capture.lastOutputAt && capture.lastOutputAt > at) ||
          (capture.lastProgressAt && capture.lastProgressAt > at) ||
          (capture.lastSessionAt && capture.lastSessionAt > at)
      );
    }
    return this.hasSemanticRecoverySinceTransportWarning(at, capture);
  }

  private hasSemanticRecoverySinceTransportWarning(at: number, capture: CodexRunCapture): boolean {
    return Boolean(
      (capture.lastOutputAt && capture.lastOutputAt > at) ||
        (capture.lastProgressAt && capture.lastProgressAt > at && capture.sawTurnCompleted)
    );
  }

  private buildRunEvidence(
    capture: CodexRunCapture,
    outputFileStatus: TaskProviderEvidence["outputFileStatus"]
  ): Partial<TaskProviderEvidence> {
    return {
      sawTurnStarted: capture.sawTurnStarted,
      sawTurnCompleted: capture.sawTurnCompleted,
      outputFileStatus,
      finalizationPath: "none",
      lastAgentMessagePreview: previewText(capture.lastAgentMessage),
      stdoutEventTail: capture.stdoutEventTail,
    };
  }

  private forwardRuntimeSignal(
    signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">,
    rawLine: string,
    capture: CodexRunCapture,
    callbacks?: ProviderRunCallbacks,
    onSignal?: (signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">, rawLine: string) => void
  ): void {
    if (this.shouldIgnoreLateRuntimeNoise(signal, capture)) {
      return;
    }
    callbacks?.onRuntimeSignal(signal, rawLine);
    onSignal?.(signal, rawLine);
  }

  private shouldIgnoreLateRuntimeNoise(
    signal: Omit<TaskRuntimeSignal, "count" | "lastSeenAt">,
    capture: CodexRunCapture
  ): boolean {
    if (signal.code !== "PROVIDER_RUNTIME_STDERR" || signal.severity !== "noise") {
      return false;
    }
    if (!capture.sawTurnCompleted) {
      return false;
    }
    return Boolean(capture.lastAgentMessage?.trim() || capture.outputFileReady);
  }

  private describeStdoutEvent(type: string, parsed: Record<string, unknown>): string {
    if (type.startsWith("item.")) {
      const item = parsed.item as Record<string, unknown> | undefined;
      const itemType = typeof item?.type === "string" ? item.type : "unknown";
      return `${type}:${itemType}`;
    }
    return type || "unknown";
  }

  private async removeTempFile(filePath: string | null): Promise<void> {
    if (!filePath) {
      return;
    }
    await fs.rm(filePath, { force: true });
  }

  private parseApplyOperation(operation: ApplyApprovalSchemaResponse["operations"][number]): ApplyOperation {
    if (operation.type === "write_file") {
      return {
        type: "write_file",
        path: operation.path.trim(),
        content: operation.content,
      };
    }
    if (operation.type === "replace_text") {
      return {
        type: "replace_text",
        path: operation.path.trim(),
        oldText: operation.oldText,
        newText: operation.newText,
      };
    }
    throw commandFailureTypeGuard("PROVIDER_OUTPUT_INVALID", `Unsupported apply operation type returned by provider: ${(operation as { type?: string }).type ?? "unknown"}`);
  }

  private describeApplyOperation(operation: ApplyOperation): string {
    return operation.type === "write_file" ? `write_file ${operation.path}` : `replace_text ${operation.path}`;
  }

  private async prepareCodexEnvironment(): Promise<NodeJS.ProcessEnv> {
    const sourceHome = this.resolveSourceCodexHome();
    if (this.config.providerPolicyLevel === "raw") {
      if (!this.hasLoggedEnvironment) {
        this.hasLoggedEnvironment = true;
        log(`[codex] using raw source CODEX_HOME: ${sourceHome}`);
      }

      return {
        ...process.env,
        CODEX_HOME: sourceHome,
      };
    }

    const targetHome =
      this.config.providerPolicyLevel === "extended" ? this.extendedTaskCodexHome : this.isolatedCodexHome;

    await this.materializeTaskCodexHome(sourceHome, targetHome);

    if (!this.hasLoggedEnvironment) {
      this.hasLoggedEnvironment = true;
      if (this.config.providerPolicyLevel === "extended") {
        log(`[codex] using derived extended task CODEX_HOME: ${targetHome}`);
        log(`[codex] source config home: ${sourceHome}`);
      } else {
        log(`[codex] using isolated CODEX_HOME: ${targetHome}`);
        log(`[codex] source config home: ${sourceHome}`);
      }
    }

    return {
      ...process.env,
      CODEX_HOME: targetHome,
    };
  }

  private async materializeTaskCodexHome(sourceHome: string, targetHome: string): Promise<void> {
    await fs.mkdir(targetHome, { recursive: true });

    const sourceAuthPath = path.join(sourceHome, "auth.json");
    const targetAuthPath = path.join(targetHome, "auth.json");
    try {
      await fs.copyFile(sourceAuthPath, targetAuthPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await fs.rm(targetAuthPath, { force: true });
    }

    const sourceConfigPath = path.join(sourceHome, "config.toml");
    const targetConfigPath = path.join(targetHome, "config.toml");
    try {
      const rawConfig = await fs.readFile(sourceConfigPath, "utf8");
      const sanitizedConfig = sanitizeCodexConfig(rawConfig);
      await fs.writeFile(targetConfigPath, sanitizedConfig, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await fs.rm(targetConfigPath, { force: true });
    }
  }

  private resolveSourceCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim();
    return configured || path.join(os.homedir(), ".codex");
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error(String(signal.reason ?? "aborted"));
    }
  }
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function previewText(value: string | null | undefined, maxLength = 160): string | null {
  if (!value?.trim()) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function extractEmbeddedJsonObject(value: string): string | null {
  const normalized = stripMarkdownCodeFence(value);
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] !== "{") {
      continue;
    }
    const candidate = trySliceBalancedJson(normalized, index);
    if (!candidate) {
      continue;
    }
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function trySliceBalancedJson(value: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return value.slice(startIndex, index + 1);
    }
  }

  return null;
}

function normalizeOptionId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "option_a";
  }
  const normalized = trimmed
    .replace(/^[^a-z0-9一二三四_]+/i, "")
    .replace(/[^a-z0-9一二三四_]+$/i, "")
    .toLowerCase();
  if (/^[a-d]$/.test(normalized)) {
    return `option_${normalized}`;
  }
  const chineseMap: Record<string, string> = { 一: "a", 二: "b", 三: "c", 四: "d" };
  if (normalized in chineseMap) {
    return `option_${chineseMap[normalized]}`;
  }
  if (/^\d+$/.test(normalized)) {
    return `option_${normalized}`;
  }
  if (normalized.startsWith("option_")) {
    return normalized;
  }
  return `option_${normalized}`;
}

function splitTitleSummary(value: string): [string, string] {
  const separators = [" - ", " — ", " – ", "—", "–"];
  for (const separator of separators) {
    const parts = value.split(separator);
    if (parts.length >= 2) {
      const title = parts[0]?.trim() ?? "";
      const summary = parts.slice(1).join(separator).trim();
      return [title, summary];
    }
  }
  return [value.trim(), value.trim()];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
