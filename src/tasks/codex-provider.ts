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
import type { ApplyOperation, TaskApprovalRequest, TaskDecisionRequest, TaskProviderEvidence, TaskResponseInput, TaskRunResult } from "./types";

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
  lastProgressAt: number | null;
  lastOutputAt: number | null;
  lastActivityAt: number;
  lastSessionAt: number | null;
  lastAgentMessage: string | null;
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

export class CodexCliProvider implements TaskProvider {
  readonly kind = "codex";
  private readonly capabilityCache = new Map<string, CodexCliCapabilities>();
  private readonly isolatedCodexHome = path.join(os.homedir(), ".clawdrive", "codex-home");
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
      const prompt =
        context.mode === "plan"
          ? this.buildPlanPrompt(context, !schemaPath)
          : context.mode === "apply"
            ? this.buildApplyDecisionPrompt(context, !schemaPath)
            : this.buildAnalyzePrompt(context, !schemaPath);
      const raw = await this.runCommand(
        executable,
        buildCodexExecArgs({
          workspacePath: context.workspacePath,
          model: this.config.providerCodexModel,
          prompt,
          schemaPath: schemaPath ?? undefined,
          outputPath: outputPath ?? undefined,
          capabilities,
        }),
        context.workspacePath,
        signal,
        true,
        callbacks,
        env
      );
      const outputFile = outputPath ? await this.readOutputMessage(outputPath) : { message: null, status: "not_used" as const };
      callbacks.onEvidence(this.buildRunEvidence(raw.capture, outputFile.status));
      if (context.mode === "plan") {
        return this.parsePlanResult(raw, outputFile.message);
      }
      if (context.mode === "apply") {
        return this.parseApplyResult(raw, outputFile.message);
      }
      return this.parseAnalyzeResult(raw, outputFile.message);
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

    const executable = await this.resolveExecutable();
    const env = await this.prepareCodexEnvironment();
    const capabilities = await this.getCapabilities(executable);
    const outputPath = capabilities.supportsResumeOutputLastMessage
      ? this.createTempFilePath("clawdrive-resume-output", "json")
      : null;
    try {
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
          capabilities,
        }),
        context.workspacePath,
        signal,
        true,
        callbacks,
        env
      );
      const outputFile = outputPath ? await this.readOutputMessage(outputPath) : { message: null, status: "not_used" as const };
      callbacks.onEvidence(this.buildRunEvidence(raw.capture, outputFile.status));
      const message = this.resolvePrimaryMessage(raw, outputFile.message);
      if (context.mode === "apply") {
        return this.parseApplyResult(raw, message);
      }
      return this.parseAnalyzeMessage(message);
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
      this.runCommand(executable, ["--help"], process.cwd(), signal, false, undefined, env),
      this.runCommand(executable, ["exec", "--help"], process.cwd(), signal, false, undefined, env),
      this.runCommand(executable, ["exec", "resume", "--help"], process.cwd(), signal, false, undefined, env),
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
    env?: NodeJS.ProcessEnv
  ): Promise<CodexCommandResult> {
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
        lastProgressAt: null,
        lastOutputAt: null,
        lastActivityAt: Date.now(),
        lastSessionAt: null,
        lastAgentMessage: null,
        stdoutEventTail: [],
      };
      const finalizationGraceMs = this.getFinalizationGraceMs();
      const stalledWarningMs = this.getStalledWarningMs();
      const stalledFailureMs = this.getStalledFailureMs();
      const postResultGraceMs = this.getPostResultGraceMs();
      let stallWarningEmitted = false;
      let settled = false;
      const flushStdoutBuffer = () => {
        if (!stdoutBuffer.trim()) {
          return;
        }
        const buffered = stdoutBuffer;
        stdoutBuffer = "";
        this.handleStdoutLine(buffered, capture, callbacks);
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
      const stallTimer =
        parseEvents && finalizationGraceMs > 0
          ? setInterval(() => {
              if (!capture.sawTurnCompleted) {
                const semanticAnchor = capture.lastOutputAt ?? capture.lastProgressAt ?? capture.lastSessionAt;
                if (!capture.sawTurnStarted || capture.lastAgentMessage || !semanticAnchor) {
                  return;
                }
                const idleMs = Date.now() - semanticAnchor;
                if (!stallWarningEmitted && idleMs >= stalledWarningMs) {
                  stallWarningEmitted = true;
                  callbacks?.onRuntimeSignal(
                    {
                      code: "PROVIDER_RESULT_STALL_WARNING",
                      severity: "degraded",
                      summary: "Provider task is still running but has not produced usable output for a while.",
                      detail: `No provider output after turn start for ${Math.round(idleMs / 1000)}s.`,
                    },
                    `No provider output after turn start for ${Math.round(idleMs / 1000)}s.`
                  );
                  callbacks?.onProgress("Provider is still running, but result generation appears stalled.");
                }
                if (idleMs < stalledFailureMs) {
                  return;
                }
                child.kill();
                settle(() => reject(new Error("Codex task stalled after turn start without producing a usable result.")));
                return;
              }
              const anchor = capture.lastOutputAt ?? capture.lastProgressAt ?? capture.lastActivityAt;
              const idleMs = Date.now() - anchor;
              if (capture.lastAgentMessage && idleMs >= postResultGraceMs) {
                flushStdoutBuffer();
                child.kill();
                settle(() => resolve({ stdout, stderr, capture }));
                return;
              }
              if (idleMs < finalizationGraceMs) {
                return;
              }
              child.kill();
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
          this.handleStdoutLine(line, capture, callbacks);
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
            callbacks?.onRuntimeSignal(signal, line);
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
        settle(() =>
          reject(new Error(stderr.trim() || stdout.trim() || `codex exited with code ${code ?? "unknown"} (${closeSignal ?? "no-signal"})`))
        );
      });
    });
  }

  private handleStdoutLine(line: string, capture: CodexRunCapture, callbacks?: ProviderRunCallbacks): void {
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
      }
      if (type === "thread.started" && typeof parsed.thread_id === "string") {
        capture.lastSessionAt = now;
        callbacks?.onEvidence(this.buildRunEvidence(capture, "not_used"));
        callbacks?.onSessionId(parsed.thread_id);
        return;
      }
      if (type === "turn.started") {
        capture.sawTurnStarted = true;
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
          callbacks?.onRuntimeSignal(signal, parsed.message);
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
            callbacks?.onRuntimeSignal(signal, item.message);
          }
        }
      }
    } catch {
      log(`codex stdout: ${trimmed}`);
    }
  }

  private parseAnalyzeResult(raw: CodexCommandResult, finalMessage?: string | null): TaskRunResult {
    const parsed = this.parsePayload<AnalyzeSchemaResponse>("analysis result", this.buildMessageCandidates(raw, finalMessage));
    return {
      summary: parsed.value.summary.trim(),
      output: parsed.value.details.trim(),
      decision: null,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
      },
    };
  }

  private parseAnalyzeMessage(message: string): TaskRunResult {
    const parsed = this.parsePayload<AnalyzeSchemaResponse>("analysis result", [{ source: "direct_message", text: message }]);
    return {
      summary: parsed.value.summary.trim(),
      output: parsed.value.details.trim(),
      decision: null,
      providerEvidence: {
        finalMessageSource: parsed.finalMessageSource,
        lastAgentMessagePreview: previewText(message),
      },
    };
  }

  private parsePlanResult(raw: CodexCommandResult, finalMessage?: string | null): TaskRunResult {
    const parsed = this.parsePayload<PlanSchemaResponse>("plan result", this.buildMessageCandidates(raw, finalMessage));
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
        lastAgentMessagePreview: previewText(raw.capture.lastAgentMessage),
      },
    };
  }

  private parseApplyResult(raw: CodexCommandResult, finalMessage?: string | null): TaskRunResult {
    const parsed = this.parsePayload<ApplySchemaResponse>("apply result", this.buildMessageCandidates(raw, finalMessage));
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

  private resolvePrimaryMessage(raw: CodexCommandResult, finalMessage?: string | null): string {
    const candidates = this.buildMessageCandidates(raw, finalMessage);
    if (candidates.length === 0) {
      throw new Error("Codex did not return a final agent message.");
    }
    return candidates[0].text;
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

  private buildAnalyzePrompt(context: ProviderRunContext, forceJsonReply: boolean): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files, run mutating commands, or suggest applying changes now.",
      "Default to reasoning from the prompt, focus paths, and common repository conventions instead of shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "Only use a shell command if it is strictly necessary to answer the request.",
      "If a shell command is blocked by policy or unavailable, do not retry with more shell commands. Continue with a best-effort answer and state the limitation briefly.",
      "If you need shell commands, keep them minimal, targeted, and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer narrow built-in commands over rg-heavy or workspace-wide scans.",
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
    return lines.join("\n");
  }

  private buildPlanPrompt(context: ProviderRunContext, forceJsonReply: boolean): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files.",
      "Default to reasoning from the prompt, focus paths, and common repository conventions instead of shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "Only use a shell command if it is strictly necessary to evaluate options.",
      "If a shell command is blocked by policy or unavailable, do not retry with more shell commands. Continue with a best-effort plan and state the limitation briefly.",
      "If you need shell commands, keep them minimal, targeted, and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer narrow built-in commands over rg-heavy or workspace-wide scans.",
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
    return lines.join("\n");
  }

  private buildApplyDecisionPrompt(context: ProviderRunContext, forceJsonReply: boolean): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files.",
      "Default to reasoning from the prompt and focus paths instead of shell exploration.",
      "Do not start with workspace-wide shell probing or broad directory scans.",
      "If a shell command is blocked by policy or unavailable, continue with a best-effort implementation decision instead of retrying with more shell commands.",
      "Do not execute shell writes, git commands, tests, formatting, or terminal-based edits.",
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
  ): Promise<{ message: string | null; status: TaskProviderEvidence["outputFileStatus"] }> {
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

  private getFinalizationGraceMs(): number {
    return Math.max(1_000, Math.min(15_000, Math.floor(this.config.tasksDefaultTimeoutMs / 20) || 0));
  }

  private getStalledWarningMs(): number {
    return Math.max(3_000, Math.min(30_000, Math.floor(this.config.tasksDefaultTimeoutMs / 6) || 0));
  }

  private getStalledFailureMs(): number {
    return Math.max(this.getStalledWarningMs() + 2_000, Math.min(90_000, Math.floor(this.config.tasksDefaultTimeoutMs / 3) || 0));
  }

  private getPostResultGraceMs(): number {
    return Math.max(750, Math.min(5_000, Math.floor(this.config.tasksDefaultTimeoutMs / 40) || 0));
  }

  private buildRunEvidence(
    capture: CodexRunCapture,
    outputFileStatus: TaskProviderEvidence["outputFileStatus"]
  ): Partial<TaskProviderEvidence> {
    return {
      sawTurnStarted: capture.sawTurnStarted,
      sawTurnCompleted: capture.sawTurnCompleted,
      outputFileStatus,
      lastAgentMessagePreview: previewText(capture.lastAgentMessage),
      stdoutEventTail: capture.stdoutEventTail,
    };
  }

  private describeStdoutEvent(type: string, parsed: Record<string, unknown>): string {
    if (type === "item.completed") {
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
    await fs.mkdir(this.isolatedCodexHome, { recursive: true });

    const sourceAuthPath = path.join(sourceHome, "auth.json");
    const targetAuthPath = path.join(this.isolatedCodexHome, "auth.json");
    try {
      await fs.copyFile(sourceAuthPath, targetAuthPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    const sourceConfigPath = path.join(sourceHome, "config.toml");
    const targetConfigPath = path.join(this.isolatedCodexHome, "config.toml");
    try {
      const rawConfig = await fs.readFile(sourceConfigPath, "utf8");
      const sanitizedConfig = sanitizeCodexConfig(rawConfig);
      await fs.writeFile(targetConfigPath, sanitizedConfig, "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    if (!this.hasLoggedEnvironment) {
      this.hasLoggedEnvironment = true;
      log(`[codex] using isolated CODEX_HOME: ${this.isolatedCodexHome}`);
      log(`[codex] source config home: ${sourceHome}`);
    }

    return {
      ...process.env,
      CODEX_HOME: this.isolatedCodexHome,
    };
  }

  private resolveSourceCodexHome(): string {
    const configured = process.env.CODEX_HOME?.trim();
    return configured || path.join(os.homedir(), ".codex");
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
