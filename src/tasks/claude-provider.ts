import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { ClawDriveConfig } from "../config";
import { commandFailure, isCommandFailure } from "../guards/errors";
import {
  buildClaudeExecArgs,
  buildClaudeResumeArgs,
  classifyClaudeCliFailure,
  classifyClaudeRuntimeSignal,
  detectClaudeCliCapabilities,
  validateClaudeExecutablePath,
  type ClaudeCliCapabilities,
} from "./claude-cli";
import type { ProviderProbeResult, ProviderRunCallbacks, ProviderRunContext, TaskProvider } from "./provider";
import { taskResumePrompt } from "./text";
import type {
  ApplyOperation,
  TaskApprovalRequest,
  TaskDecisionOption,
  TaskDecisionRequest,
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
    | { type: "write_file"; path: string; content: string }
    | { type: "replace_text"; path: string; oldText: string; newText: string }
  >;
}

interface ApplyCompletedSchemaResponse {
  stage: "completed";
  summary: string;
  details: string;
}

type ApplySchemaResponse = ApplyDecisionSchemaResponse | ApplyApprovalSchemaResponse | ApplyCompletedSchemaResponse;

interface ClaudeCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ParsedEnvelope<T> {
  payload: T;
  sessionId: string | null;
  source: TaskProviderEvidence["finalMessageSource"];
  rawMessage: string;
}

interface LocalWorkspaceSnapshot {
  lines: string[];
}

interface ClaudeRunStallTimings {
  warningMs: number;
  failureMs: number;
}

interface ClaudeCommandFailure extends Error {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

function attachCapturedCommandResult(error: Error, result: ClaudeCommandResult): ClaudeCommandFailure {
  return Object.assign(error as ClaudeCommandFailure, result);
}

function readCapturedCommandResult(error: unknown): ClaudeCommandResult | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as ClaudeCommandFailure;
  if (typeof candidate.stdout !== "string" || typeof candidate.stderr !== "string") {
    return null;
  }
  return {
    stdout: candidate.stdout,
    stderr: candidate.stderr,
    exitCode: typeof candidate.exitCode === "number" || candidate.exitCode === null ? candidate.exitCode : null,
  };
}

function isInconclusiveProbeFailure(code: string): boolean {
  return [
    "PROVIDER_RESULT_STALLED",
    "PROVIDER_TRANSPORT_FAILED",
    "PROVIDER_OUTPUT_EMPTY",
    "PROVIDER_OUTPUT_INVALID",
    "PROVIDER_UPSTREAM_UNAVAILABLE",
  ].includes(code);
}

function ensureNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`Claude returned a ${label} field with an unexpected type.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Claude returned an empty ${label} field.`);
  }
  return trimmed;
}

function ensureDecisionOptions(
  options: unknown,
  fallbackLabel: string
): Array<{ id: string; title: string; summary: string; recommended: boolean }> {
  if (!Array.isArray(options)) {
    throw new Error(`Claude returned ${fallbackLabel} with an unexpected options shape.`);
  }
  return options.map((option, index) => {
    if (!option || typeof option !== "object") {
      throw new Error(`Claude returned option ${index + 1} with an unexpected shape.`);
    }
    const record = option as Record<string, unknown>;
    return {
      id: ensureNonEmptyString(record.id, `option ${index + 1} id`),
      title: ensureNonEmptyString(record.title, `option ${index + 1} title`),
      summary: ensureNonEmptyString(record.summary, `option ${index + 1} summary`),
      recommended: record.recommended === true,
    };
  });
}

function readOptionalNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function readNestedOptionalNonEmptyString(record: Record<string, unknown>, ...path: string[]): string | null {
  let current: unknown = record;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return readOptionalNonEmptyString(current);
}

export class ClaudeCliProvider implements TaskProvider {
  readonly kind = "claude";
  private readonly capabilityCache = new Map<string, ClaudeCliCapabilities>();

  constructor(private readonly config: ClawDriveConfig) {}

  async probe(): Promise<ProviderProbeResult> {
    if (!this.config.providerEnabled || this.config.providerKind !== "claude") {
      return { ready: false, state: "disabled", detail: "Claude provider is disabled." };
    }

    let executable: string | null = null;
    try {
      executable = await this.resolveExecutable();
      const capabilities = await this.getCapabilities(executable);
      await this.runProbeSmokeTest(executable, capabilities);
      return { ready: true, state: "ready", detail: `Using ${executable}.` };
    } catch (error) {
      const failure = classifyClaudeCliFailure(error);
      if (executable && isInconclusiveProbeFailure(failure.code)) {
        return {
          ready: true,
          state: "ready",
          detail: `Using ${executable}. Probe was inconclusive: ${failure.message} Tasks will validate runtime readiness on execution.`,
        };
      }
      return {
        ready: false,
        state: failure.code === "PROVIDER_EXECUTABLE_MISSING" ? "missing" : "error",
        detail: failure.message,
      };
    }
  }

  async startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult> {
    return await this.runTask(context, null, callbacks, signal);
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
    return await this.runTask(context, response, callbacks, signal);
  }

  private async runTask(
    context: ProviderRunContext,
    response: TaskResponseInput | null,
    callbacks: ProviderRunCallbacks,
    signal: AbortSignal
  ): Promise<TaskRunResult> {
    this.throwIfAborted(signal);
    const executable = await this.resolveExecutable();
    const capabilities = await this.getCapabilities(executable);
    const effectiveMode: "analyze" | "plan" | "apply" = response && context.mode !== "apply" ? "analyze" : context.mode;
    const localWorkspaceSnapshot =
      context.mode === "analyze" || context.mode === "plan" ? await this.buildLocalWorkspaceSnapshot(context) : null;
    const shouldUseRawJsonAnalyzeStart = context.mode === "analyze" && !response;
    const shouldUseRawJsonPlanStart = context.mode === "plan" && !response;
    const shouldUseRawJsonPlanResume = context.mode === "plan" && Boolean(response);
    const shouldUseRawJsonApplyStart = context.mode === "apply" && !response;
    const defaultForceJsonReply =
      shouldUseRawJsonAnalyzeStart || shouldUseRawJsonApplyStart || shouldUseRawJsonPlanStart || shouldUseRawJsonPlanResume
        ? true
        : !capabilities.supportsJsonSchema;
    const buildPrompt = (forceJsonReply: boolean) =>
      response
        ? context.mode === "apply"
          ? this.buildApplyResumePrompt(context, response, forceJsonReply)
          : this.buildResumePrompt(taskResumePrompt(undefined, response.message), forceJsonReply)
        : context.mode === "plan"
          ? this.buildPlanPrompt(context, forceJsonReply, localWorkspaceSnapshot)
          : context.mode === "apply"
            ? this.buildApplyDecisionPrompt(context, forceJsonReply)
            : this.buildAnalyzePrompt(context, forceJsonReply, localWorkspaceSnapshot);
    const buildArgs = (forceJsonReply: boolean, disableSchema: boolean) =>
      response
        ? buildClaudeResumeArgs({
            sessionId: context.sessionId!,
            prompt: buildPrompt(forceJsonReply),
            model: this.config.providerClaudeModel,
            schema: undefined,
            capabilities,
            outputFormatJson: context.mode === "apply" ? Boolean(response) : true,
          })
        : buildClaudeExecArgs({
            prompt: buildPrompt(forceJsonReply),
            model: this.config.providerClaudeModel,
            schema:
              disableSchema
                ? undefined
                : context.mode === "plan"
                  ? this.planSchema()
                  : context.mode === "apply"
                    ? undefined
                    : this.analyzeSchema(),
            capabilities,
            outputFormatJson: true,
            permissionModePlan: true,
            printPrompt: true,
          });

    let turnStarted = false;
    let raw: ClaudeCommandResult | null = null;

    const progressCallbacks: ProviderRunCallbacks = {
      ...callbacks,
      onProgress: (summary) => {
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onProgress(summary);
      },
      onOutput: (output) => {
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onOutput(output);
      },
      onEvidence: (evidence) => {
        if (!turnStarted && evidence.sawTurnStarted) {
          turnStarted = true;
        }
        if (!turnStarted && (evidence.finalMessageSource && evidence.finalMessageSource !== "none")) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onEvidence(evidence);
      },
      onRuntimeSignal: callbacks.onRuntimeSignal,
      onSessionId: callbacks.onSessionId,
    };

    try {
      raw = await this.runCommand(
        executable,
        buildArgs(
          defaultForceJsonReply,
          shouldUseRawJsonAnalyzeStart || shouldUseRawJsonPlanStart || shouldUseRawJsonApplyStart
        ),
        context.workspacePath,
        signal,
        progressCallbacks,
        this.getRunStallTimings(context)
      );
      const commandResult = raw;
      const parsed = this.parseByMode(effectiveMode, commandResult.stdout, commandResult.stderr);
      const resolvedSessionId = parsed.sessionId ?? this.tryExtractEnvelopeSessionId(commandResult.stdout) ?? context.sessionId ?? null;
      if (resolvedSessionId) {
        callbacks.onSessionId(resolvedSessionId);
      }
      if (!turnStarted) {
        turnStarted = true;
        callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
      }
      callbacks.onProgress("Claude task turn completed. Finalizing result.");
      callbacks.onEvidence({
        sawTurnCompleted: true,
        finalMessageSource: parsed.source,
        finalizationPath: this.toFinalizationPath(parsed.source),
        lastAgentMessagePreview: previewText(parsed.rawMessage),
        stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
      });
      const result = this.toTaskRunResult(effectiveMode, parsed, callbacks);
      if (result.output) {
        callbacks.onOutput(result.output);
      }
      return { ...result, sessionId: resolvedSessionId };
    } catch (error) {
      raw = raw ?? readCapturedCommandResult(error);
      const envelopeError = raw ? this.tryExtractEnvelopeError(raw.stdout) : null;
      if (envelopeError) {
        if (envelopeError.sessionId) {
          callbacks.onSessionId(envelopeError.sessionId);
        }
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onEvidence({
          rawStdoutPreview: previewText(raw?.stdout),
          sawTurnCompleted: true,
          finalMessageSource: envelopeError.source,
          finalizationPath: this.toFinalizationPath(envelopeError.source),
          lastAgentMessagePreview: previewText(envelopeError.rawMessage),
          stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
        });
      }
      const classifiedError = envelopeError
        ? commandFailure("PROVIDER_EXECUTION_FAILED", envelopeError.rawMessage)
        : isCommandFailure(error)
          ? error
          : error instanceof Error
            ? commandFailure("PROVIDER_EXECUTION_FAILED", error.message)
            : commandFailure("PROVIDER_EXECUTION_FAILED", String(error));
      if (effectiveMode === "analyze" && raw?.stdout?.trim()) {
        const salvaged = this.trySalvageAnalyzeResult(raw.stdout, callbacks);
        if (salvaged) {
          const resolvedSessionId = salvaged.sessionId ?? this.tryExtractEnvelopeSessionId(raw.stdout) ?? context.sessionId ?? null;
          if (resolvedSessionId) {
            callbacks.onSessionId(resolvedSessionId);
          }
          if (!turnStarted) {
            turnStarted = true;
            callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
          }
          callbacks.onProgress("Claude analyze task recovered from provider output.");
          callbacks.onEvidence({
            rawStdoutPreview: previewText(raw.stdout),
            sawTurnCompleted: true,
            finalMessageSource: salvaged.providerEvidence?.finalMessageSource ?? "direct_message",
            finalizationPath: salvaged.providerEvidence?.finalizationPath ?? "stream_capture",
            lastAgentMessagePreview: salvaged.providerEvidence?.lastAgentMessagePreview ?? previewText(raw.stdout),
            stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
          });
          if (salvaged.output) {
            callbacks.onOutput(salvaged.output);
          }
          return { ...salvaged, sessionId: resolvedSessionId };
        }
      }
      if (context.mode === "plan" && !response && raw?.stdout?.trim()) {
        const salvaged = this.trySalvagePlanResult(raw.stdout);
        if (salvaged) {
          const resolvedSessionId = salvaged.sessionId ?? this.tryExtractEnvelopeSessionId(raw.stdout) ?? context.sessionId ?? null;
          if (resolvedSessionId) {
            callbacks.onSessionId(resolvedSessionId);
          }
          if (!turnStarted) {
            turnStarted = true;
            callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
          }
          callbacks.onProgress("Claude plan task finalized from the first provider response.");
          callbacks.onEvidence({
            rawStdoutPreview: previewText(raw.stdout),
            sawTurnCompleted: true,
            finalMessageSource: salvaged.providerEvidence?.finalMessageSource ?? "direct_message",
            finalizationPath: salvaged.providerEvidence?.finalizationPath ?? "stream_capture",
            lastAgentMessagePreview: salvaged.providerEvidence?.lastAgentMessagePreview ?? previewText(raw.stdout),
            stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
          });
          if (salvaged.output) {
            callbacks.onOutput(salvaged.output);
          }
          return { ...salvaged, sessionId: resolvedSessionId };
        }
      }
      const preserveOutputValidationFailure =
        isCommandFailure(classifiedError) &&
        classifiedError.code === "PROVIDER_OUTPUT_INVALID" &&
        /Claude (approval operation|write_file operation|replace_text operation)/i.test(classifiedError.message);
      const failure = preserveOutputValidationFailure ? classifiedError : classifyClaudeCliFailure(classifiedError);
      const retryResumePlanFinalization =
        context.mode === "plan" &&
        Boolean(response) &&
        (
          failure.code === "PROVIDER_RESULT_STALLED" ||
          failure.code === "PROVIDER_OUTPUT_EMPTY" ||
          (failure.code === "PROVIDER_OUTPUT_INVALID" && Boolean(raw?.stdout?.trim()))
        );
      if (retryResumePlanFinalization) {
        raw = await this.runCommand(
          executable,
          buildArgs(true, true),
          context.workspacePath,
          signal,
          progressCallbacks,
          this.getRunStallTimings(context, true)
        );
        const commandResult = raw;
        let parsed: ReturnType<ClaudeCliProvider["parseByMode"]>;
        try {
          parsed = this.parseByMode(effectiveMode, commandResult.stdout, commandResult.stderr);
        } catch (retryError) {
          const retryEnvelopeError = this.tryExtractEnvelopeError(commandResult.stdout);
          throw commandFailure(
            "PROVIDER_EXECUTION_FAILED",
            retryEnvelopeError?.rawMessage ?? (retryError instanceof Error ? retryError.message : String(retryError))
          );
        }
        const resolvedSessionId =
          parsed.sessionId ?? this.tryExtractEnvelopeSessionId(commandResult.stdout) ?? context.sessionId ?? null;
        if (resolvedSessionId) {
          callbacks.onSessionId(resolvedSessionId);
        }
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onRuntimeSignal(
          {
            code: "PROVIDER_PLAN_RESUME_OUTPUT_RETRY",
            severity: "degraded",
            summary: "Claude resumed plan task did not finalize cleanly; retried once with explicit raw JSON prompting.",
            detail: failure.message,
          },
          failure.message
        );
        callbacks.onProgress("Claude resumed plan task recovered after retrying with explicit raw JSON prompting.");
        callbacks.onEvidence({
          rawStdoutPreview: previewText(commandResult.stdout),
          sawTurnCompleted: true,
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
          stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
        });
        const result = this.toTaskRunResult(effectiveMode, parsed, callbacks);
        if (result.output) {
          callbacks.onOutput(result.output);
        }
        return { ...result, sessionId: resolvedSessionId };
      }
      const retryReadonlyEmptyOutput =
        (context.mode === "analyze" || context.mode === "plan") &&
        !response &&
        (
          (isCommandFailure(error) && (error.code === "PROVIDER_OUTPUT_EMPTY" || error.code === "PROVIDER_RESULT_STALLED")) ||
          failure.code === "PROVIDER_OUTPUT_EMPTY" ||
          failure.code === "PROVIDER_RESULT_STALLED"
        );
      const retryReadonlyInvalidPlanOutput =
        context.mode === "plan" &&
        !response &&
        failure.code === "PROVIDER_OUTPUT_INVALID" &&
        Boolean(raw?.stdout?.trim()) &&
        /expected JSON result|usable plan result/i.test(failure.message);
      if (retryReadonlyEmptyOutput || retryReadonlyInvalidPlanOutput) {
        raw = await this.runCommand(
          executable,
          buildArgs(true, true),
          context.workspacePath,
          signal,
          progressCallbacks,
          this.getRunStallTimings(context, false)
        );
        const commandResult = raw;
        let parsed: ReturnType<ClaudeCliProvider["parseByMode"]>;
        try {
          parsed = this.parseByMode(effectiveMode, commandResult.stdout, commandResult.stderr);
        } catch (retryError) {
          const retryEnvelopeError = this.tryExtractEnvelopeError(commandResult.stdout);
          throw commandFailure(
            "PROVIDER_EXECUTION_FAILED",
            retryEnvelopeError?.rawMessage ?? (retryError instanceof Error ? retryError.message : String(retryError))
          );
        }
        const resolvedSessionId =
          parsed.sessionId ?? this.tryExtractEnvelopeSessionId(commandResult.stdout) ?? context.sessionId ?? null;
        if (resolvedSessionId) {
          callbacks.onSessionId(resolvedSessionId);
        }
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onRuntimeSignal(
          {
            code: context.mode === "analyze" ? "PROVIDER_ANALYZE_OUTPUT_RETRY" : "PROVIDER_PLAN_OUTPUT_RETRY",
            severity: "degraded",
            summary:
              context.mode === "analyze"
                ? "Claude analyze task returned empty output; retried once with explicit raw JSON prompting."
                : "Claude plan task returned empty output; retried once with explicit raw JSON prompting.",
            detail: failure.message,
          },
          failure.message
        );
        callbacks.onProgress(
          context.mode === "analyze"
            ? "Claude analyze task recovered after retrying with explicit raw JSON prompting."
            : "Claude plan task recovered after retrying with explicit raw JSON prompting."
        );
        callbacks.onEvidence({
          rawStdoutPreview: previewText(commandResult.stdout),
          sawTurnCompleted: true,
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
          stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
        });
        const result = this.toTaskRunResult(effectiveMode, parsed, callbacks);
        if (result.output) {
          callbacks.onOutput(result.output);
        }
        return { ...result, sessionId: resolvedSessionId };
      }
      if (
        context.mode === "apply" &&
        !response &&
        ((isCommandFailure(error) && error.code === "PROVIDER_OUTPUT_EMPTY") || failure.code === "PROVIDER_OUTPUT_EMPTY")
      ) {
        raw = await this.runCommand(
          executable,
          buildArgs(true, true),
          context.workspacePath,
          signal,
          progressCallbacks,
          this.getRunStallTimings(context, false)
        );
        const commandResult = raw;
        let parsed: ReturnType<ClaudeCliProvider["parseByMode"]>;
        try {
          parsed = this.parseByMode("apply", commandResult.stdout, commandResult.stderr);
        } catch (retryError) {
          const retryEnvelopeError = this.tryExtractEnvelopeError(commandResult.stdout);
          throw commandFailure("PROVIDER_EXECUTION_FAILED", retryEnvelopeError?.rawMessage ?? (retryError instanceof Error ? retryError.message : String(retryError)));
        }
        const resolvedSessionId = parsed.sessionId ?? this.tryExtractEnvelopeSessionId(commandResult.stdout) ?? context.sessionId ?? null;
        if (resolvedSessionId) {
          callbacks.onSessionId(resolvedSessionId);
        }
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onRuntimeSignal(
          {
            code: "PROVIDER_APPLY_OUTPUT_RETRY",
            severity: "degraded",
            summary: "Claude apply start returned empty output; retried once with explicit raw JSON prompting.",
            detail: failure.message,
          },
          failure.message
        );
        callbacks.onProgress("Claude apply task recovered after retrying with explicit raw JSON prompting.");
        callbacks.onEvidence({
          rawStdoutPreview: previewText(commandResult.stdout),
          sawTurnCompleted: true,
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
          stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
        });
        const result = this.toTaskRunResult("apply", parsed, callbacks);
        if (result.output) {
          callbacks.onOutput(result.output);
        }
        return { ...result, sessionId: resolvedSessionId };
      }
      if (
        context.mode === "apply" &&
        !response &&
        failure.code === "PROVIDER_OUTPUT_INVALID" &&
        /structured output/i.test(failure.message)
      ) {
        raw = await this.runCommand(
          executable,
          buildArgs(true, true),
          context.workspacePath,
          signal,
          progressCallbacks,
          this.getRunStallTimings(context)
        );
        const commandResult = raw;
        let parsed: ReturnType<ClaudeCliProvider["parseByMode"]>;
        try {
          parsed = this.parseByMode("apply", commandResult.stdout, commandResult.stderr);
        } catch (retryError) {
          const retryEnvelopeError = this.tryExtractEnvelopeError(commandResult.stdout);
          throw commandFailure("PROVIDER_EXECUTION_FAILED", retryEnvelopeError?.rawMessage ?? (retryError instanceof Error ? retryError.message : String(retryError)));
        }
        const resolvedSessionId = parsed.sessionId ?? this.tryExtractEnvelopeSessionId(commandResult.stdout) ?? context.sessionId ?? null;
        if (resolvedSessionId) {
          callbacks.onSessionId(resolvedSessionId);
        }
        if (!turnStarted) {
          turnStarted = true;
          callbacks.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["turn.started"] });
        }
        callbacks.onRuntimeSignal(
          {
            code: "PROVIDER_APPLY_SCHEMA_RETRY",
            severity: "degraded",
            summary: "Claude could not satisfy the strict apply schema; retried with raw JSON prompting.",
            detail: failure.message,
          },
          failure.message
        );
        callbacks.onProgress("Claude apply task recovered after retrying with raw JSON prompting.");
        callbacks.onEvidence({
          rawStdoutPreview: previewText(commandResult.stdout),
          sawTurnCompleted: true,
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
          stdoutEventTail: ["turn.started", "result.received", "turn.completed"],
        });
        const result = this.toTaskRunResult("apply", parsed, callbacks);
        if (result.output) {
          callbacks.onOutput(result.output);
        }
        return { ...result, sessionId: resolvedSessionId };
      }

      throw commandFailure(failure.code, envelopeError?.rawMessage ?? failure.message);
    }
  }

  private async resolveExecutable(): Promise<string> {
    const configured = (this.config.providerClaudePath || "claude").trim();
    validateClaudeExecutablePath(configured);
    if (path.isAbsolute(configured)) {
      await fs.access(configured);
      return configured;
    }
    const resolved = await this.resolveFromPath(configured);
    if (resolved) {
      return resolved;
    }
    const resolvedFromKnownLocations = await this.resolveFromKnownLocations(configured);
    if (resolvedFromKnownLocations) {
      return resolvedFromKnownLocations;
    }
    throw new Error(
      `Claude executable was not found. Checked PATH and known VS Code extension locations for ${configured}.`
    );
  }

  private async resolveFromPath(configured: string): Promise<string | null> {
    const pathValue = process.env.PATH || process.env.Path || "";
    const segments = pathValue.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
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

  private expandExecutableCandidates(configured: string): string[] {
    if (process.platform !== "win32" || /\.[A-Za-z0-9]+$/.test(configured)) {
      return [configured];
    }
    return [configured, `${configured}.cmd`, `${configured}.exe`, `${configured}.bat`];
  }

  private async resolveFromKnownLocations(configured: string): Promise<string | null> {
    const baseName = path.parse(configured).name.toLowerCase();
    for (const root of this.getExtensionRoots()) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true });
        const claudeExtensions = entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("anthropic.claude-code-"))
          .sort((left, right) => right.name.localeCompare(left.name));

        for (const extension of claudeExtensions) {
          const candidate = this.claudePathInsideExtension(root, extension.name);
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

  private getExtensionRoots(): string[] {
    const home = os.homedir();
    return [path.join(home, ".vscode", "extensions"), path.join(home, ".vscode-insiders", "extensions")];
  }

  private claudePathInsideExtension(root: string, extensionName: string): string | null {
    const base = path.join(root, extensionName, "resources", "native-binary");
    if (process.platform === "win32") {
      return path.join(base, "claude.exe");
    }
    return path.join(base, "claude");
  }

  private async runProbeSmokeTest(executable: string, capabilities: ClaudeCliCapabilities): Promise<void> {
    const raw = await this.runCommand(
      executable,
      buildClaudeExecArgs({
        prompt: [
          "Return a raw JSON object only.",
          'Use this exact shape: {"summary":"...","details":"..."}.',
          'Set summary to "probe" and details to "ready".',
          "Do not wrap the JSON in markdown fences.",
        ].join("\n"),
        model: this.config.providerClaudeModel,
        schema: this.analyzeSchema(),
        capabilities,
      }),
      null,
      new AbortController().signal
    );
    this.parsePayload<AnalyzeSchemaResponse>("provider probe result", raw.stdout, raw.stderr);
  }

  private async getCapabilities(executable: string): Promise<ClaudeCliCapabilities> {
    const cached = this.capabilityCache.get(executable);
    if (cached) {
      return cached;
    }
    const help = await this.runCommand(executable, ["--help"], null, new AbortController().signal);
    const capabilities = detectClaudeCliCapabilities(help.stdout || help.stderr);
    this.capabilityCache.set(executable, capabilities);
    return capabilities;
  }

  private async runCommand(
    executable: string,
    args: string[],
    workspacePath: string | null,
    signal: AbortSignal,
    callbacks?: ProviderRunCallbacks,
    stallTimings?: ClaudeRunStallTimings
  ): Promise<ClaudeCommandResult> {
    return await new Promise<ClaudeCommandResult>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: workspacePath ?? undefined,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let stderrBuffer = "";
      const startedAt = Date.now();
      let warningEmitted = false;
      let usableOutputObserved = false;
      let sawProviderOutput = false;
      let lastProviderActivityAt = startedAt;

      const markProviderActivity = () => {
        lastProviderActivityAt = Date.now();
      };

      const markUsableProgress = () => {
        markProviderActivity();
        if (usableOutputObserved) {
          return;
        }
        usableOutputObserved = true;
        callbacks?.onProgress("Claude task turn started.");
      };

      const settleResolve = (result: ClaudeCommandResult) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        if (stallTimer) {
          clearInterval(stallTimer);
        }
        resolve(result);
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abortHandler);
        if (stallTimer) {
          clearInterval(stallTimer);
        }
        reject(error);
      };

      const rejectForRuntimeSignal = (runtimeSignal: ReturnType<typeof classifyClaudeRuntimeSignal>) => {
        if (!runtimeSignal || runtimeSignal.severity !== "fatal") {
          return false;
        }
        if (canPreferCapturedResult()) {
          return false;
        }
        callbacks?.onEvidence({ finalizationPath: "timeout" });
        child.kill();
        settleReject(attachCapturedCommandResult(new Error(runtimeSignal.detail ?? runtimeSignal.summary), { stdout, stderr, exitCode: null }));
        return true;
      };

      const flushStderr = () => {
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines.map((item) => item.trim()).filter(Boolean)) {
          markProviderActivity();
          const runtimeSignal = classifyClaudeRuntimeSignal(line);
          if (runtimeSignal) {
            callbacks?.onRuntimeSignal(runtimeSignal, line);
            if (rejectForRuntimeSignal(runtimeSignal)) {
              return;
            }
          }
        }
      };

      const abortHandler = () => {
        child.kill();
        settleReject(attachCapturedCommandResult(new Error("Claude task was aborted."), { stdout, stderr, exitCode: null }));
      };

      if (signal.aborted) {
        abortHandler();
        return;
      }

      signal.addEventListener("abort", abortHandler, { once: true });
      const warningMs = stallTimings?.warningMs ?? this.getStalledWarningMs();
      const failureMs = stallTimings?.failureMs ?? this.getStalledFailureMs();
      const canPreferCapturedResult = () => {
        if (!stdout.trim()) {
          return false;
        }
        try {
          this.parsePayload<unknown>("provider result", stdout, stderr);
          return true;
        } catch {
          return false;
        }
      };
      const stallTimer = setInterval(() => {
        if (settled) {
          return;
        }
        const silentMs = Date.now() - lastProviderActivityAt;
        if (!warningEmitted && silentMs >= warningMs) {
          warningEmitted = true;
          callbacks?.onRuntimeSignal(
            {
              code: "PROVIDER_RESULT_STALL_WARNING",
              severity: "degraded",
              summary: "Claude task has not produced output yet and appears stalled.",
              detail: `No Claude output after ${Math.round(silentMs / 1000)}s.`,
            },
            `No Claude output after ${Math.round(silentMs / 1000)}s.`
          );
          callbacks?.onProgress("Claude task appears stalled while waiting for output.");
        }
        if (silentMs < warningMs) {
          warningEmitted = false;
        }
        if (!sawProviderOutput && silentMs >= failureMs) {
          callbacks?.onEvidence({ finalizationPath: "timeout" });
          child.kill();
          settleReject(
            attachCapturedCommandResult(new Error("Claude stalled after turn start without producing provider activity."), {
              stdout,
              stderr,
              exitCode: null,
            })
          );
          return;
        }
        if (sawProviderOutput && !usableOutputObserved && silentMs >= failureMs) {
          callbacks?.onEvidence({ finalizationPath: "timeout" });
          child.kill();
          settleReject(
            attachCapturedCommandResult(new Error("Claude stalled after turn start without producing a usable result."), {
              stdout,
              stderr,
              exitCode: null,
            })
          );
        }
      }, 250);
      stallTimer.unref?.();
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (chunk.trim()) {
          markProviderActivity();
        }
        if (!sawProviderOutput && chunk.trim()) {
          sawProviderOutput = true;
          callbacks?.onEvidence({ sawTurnStarted: true, stdoutEventTail: ["stdout.received"] });
        }
        if (!usableOutputObserved) {
          try {
            if (this.tryParseEnvelope<unknown>(stdout.trim())) {
              markUsableProgress();
            }
          } catch {
            // ignore partial or unusable payloads during progress detection; final parse reports the real error
          }
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        stderrBuffer += chunk;
        flushStderr();
      });
      child.once("error", (error) =>
        settleReject(
          attachCapturedCommandResult(error instanceof Error ? error : new Error(String(error)), { stdout, stderr, exitCode: null })
        )
      );
      child.once("close", (code) => {
        const trailing = stderrBuffer.trim();
        if (trailing) {
          markProviderActivity();
          const runtimeSignal = classifyClaudeRuntimeSignal(trailing);
          if (runtimeSignal) {
            callbacks?.onRuntimeSignal(runtimeSignal, trailing);
            if (rejectForRuntimeSignal(runtimeSignal)) {
              if (!canPreferCapturedResult()) {
                return;
              }
            }
          }
        }
        if (!usableOutputObserved && stdout.trim()) {
          try {
            this.parsePayload<unknown>("provider progress", stdout, stderr);
            markUsableProgress();
          } catch {
            // ignore parse failures here; final parse path will report the definitive error
          }
        }
        if (code && !stdout.trim()) {
          settleReject(attachCapturedCommandResult(new Error((stderr || stdout || `Claude exited with code ${code}`).trim()), { stdout, stderr, exitCode: code }));
          return;
        }
        settleResolve({ stdout, stderr, exitCode: code });
      });
    });
  }


  private getRunStallTimings(context: ProviderRunContext, preferResumeRetry = false): ClaudeRunStallTimings {
    const warningMs = this.getStalledWarningMs();
    const failureMs = this.getStalledFailureMs();
    if (context.mode === "plan") {
      const extendedFailureMs = Math.max(failureMs, 360_000);
      const extendedWarningMs = Math.max(warningMs, Math.min(180_000, Math.floor(extendedFailureMs / 2)));
      if (preferResumeRetry) {
        return {
          warningMs,
          failureMs,
        };
      }
      return {
        warningMs: extendedWarningMs,
        failureMs: extendedFailureMs,
      };
    }
    return {
      warningMs,
      failureMs,
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new Error("Claude task was aborted.");
    }
  }

  private getStalledWarningMs(): number {
    const base = Math.floor(this.config.tasksDefaultTimeoutMs / 6) || 0;
    return Math.max(3_000, Math.min(45_000, base));
  }

  private getStalledFailureMs(): number {
    const base = Math.floor(this.config.tasksDefaultTimeoutMs / 3) || 0;
    return Math.max(this.getStalledWarningMs() + 2_000, Math.min(90_000, base));
  }

  private parseByMode(
    mode: "analyze" | "plan" | "apply",
    stdout: string,
    stderr: string
  ): ParsedEnvelope<AnalyzeSchemaResponse | PlanSchemaResponse | ApplySchemaResponse> {
    if (mode === "plan") {
      return this.parsePayload<PlanSchemaResponse>("plan result", stdout, stderr);
    }
    if (mode === "apply") {
      return this.parsePayload<ApplySchemaResponse>("apply result", stdout, stderr);
    }
    return this.parsePayload<AnalyzeSchemaResponse>("analyze result", stdout, stderr);
  }

  private toTaskRunResult(
    mode: "analyze" | "plan" | "apply",
    parsed: ParsedEnvelope<AnalyzeSchemaResponse | PlanSchemaResponse | ApplySchemaResponse>,
    callbacks?: ProviderRunCallbacks
  ): TaskRunResult {
    if (mode === "analyze") {
      return this.toAnalyzeTaskRunResult(parsed as ParsedEnvelope<AnalyzeSchemaResponse>, callbacks);
    }

    if (mode === "plan") {
      const payload = parsed.payload as unknown as Record<string, unknown>;
      const structuredOutput =
        payload.structured_output && typeof payload.structured_output === "object"
          ? (payload.structured_output as Record<string, unknown>)
          : null;
      const summary =
        readOptionalNonEmptyString(payload.summary) ??
        readOptionalNonEmptyString(structuredOutput?.summary) ??
        readOptionalNonEmptyString(payload.title) ??
        readOptionalNonEmptyString(payload.headline) ??
        readOptionalNonEmptyString(payload.message);
      const options =
        this.readPlanOptionsFromUnknown(payload.options) ??
        this.readPlanOptionsFromUnknown(payload.choices) ??
        this.readPlanOptionsFromUnknown(payload.candidates) ??
        this.readPlanOptionsFromUnknown(payload.recommendations) ??
        this.readPlanOptionsFromUnknown(structuredOutput?.options);
      if (!summary || !options) {
        const fallback = this.parsePlanFromText(parsed.rawMessage);
        if (!fallback) {
          throw new Error("Claude did not return a usable plan result.");
        }
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
          summary: fallback.summary,
          output: fallback.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
          decision: {
            summary: fallback.summary,
            options: fallback.options,
            recommendedOptionId: fallback.options.find((option) => option.recommended)?.id ?? null,
          },
          providerEvidence: {
            finalMessageSource: parsed.source,
            finalizationPath: this.toFinalizationPath(parsed.source),
            lastAgentMessagePreview: previewText(parsed.rawMessage),
          },
        };
      }
      const normalizedOptions = ensureDecisionOptions(options, "plan result");
      const decision: TaskDecisionRequest = {
        summary,
        options: normalizedOptions,
        recommendedOptionId: normalizedOptions.find((option) => option.recommended)?.id ?? null,
      };
      return {
        summary: decision.summary,
        output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
        decision,
        providerEvidence: {
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
        },
      };
    }

    const value = parsed.payload as ApplySchemaResponse;
    const payloadRecord = parsed.payload as unknown as Record<string, unknown>;
    const applyText =
      typeof parsed.payload === "string"
        ? parsed.payload
        : typeof payloadRecord.result === "string"
          ? payloadRecord.result
          : parsed.rawMessage;
    const applyPayload =
      value && typeof value === "object" && typeof (value as unknown as { stage?: unknown }).stage === "string"
        ? (value as unknown as Record<string, unknown>)
        : payloadRecord.structured_output && typeof payloadRecord.structured_output === "object"
          ? (payloadRecord.structured_output as Record<string, unknown>)
          : (value as unknown as Record<string, unknown>);
    if (applyPayload.stage === "decision") {
      const normalizedOptions = ensureDecisionOptions(applyPayload.options, "apply decision result");
      const decision: TaskDecisionRequest = {
        summary: ensureNonEmptyString(applyPayload.summary, "summary"),
        options: normalizedOptions,
        recommendedOptionId: normalizedOptions.find((option) => option.recommended)?.id ?? null,
      };
      return {
        summary: decision.summary,
        output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
        decision,
        providerEvidence: {
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
        },
      };
    }

    if (applyPayload.stage === "approval") {
      if (!Array.isArray(applyPayload.operations) || !applyPayload.operations.length) {
        throw new Error("Claude did not return any apply operations.");
      }
      const approval: TaskApprovalRequest = {
        summary: ensureNonEmptyString(applyPayload.summary, "summary"),
        operations: applyPayload.operations.map((operation) => this.parseApplyOperation(operation)),
      };
      return {
        summary: approval.summary,
        output: approval.operations.map((operation) => this.describeApplyOperation(operation)).join("\n"),
        approval,
        providerEvidence: {
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
        },
      };
    }

    if (applyPayload.stage === "completed") {
      return {
        summary: ensureNonEmptyString(applyPayload.summary, "summary"),
        output: ensureNonEmptyString(applyPayload.details, "details"),
        providerEvidence: {
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
        },
      };
    }

    const fallback = this.parseApplyDecisionFromText(applyText);
    if (fallback) {
      callbacks?.onRuntimeSignal(
        {
          code: "PROVIDER_APPLY_DEGRADED_DECISION_OUTPUT",
          severity: "degraded",
          summary: "Provider returned prose apply options; using degraded decision extraction.",
          detail: "Parsed apply decision options from prose because structured JSON was unavailable.",
        },
        "Parsed apply decision options from prose because structured JSON was unavailable."
      );
      return {
        summary: fallback.summary,
        output: fallback.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
        decision: {
          summary: fallback.summary,
          options: fallback.options,
          recommendedOptionId: fallback.options.find((option) => option.recommended)?.id ?? null,
        },
        providerEvidence: {
          finalMessageSource: parsed.source,
          finalizationPath: this.toFinalizationPath(parsed.source),
          lastAgentMessagePreview: previewText(parsed.rawMessage),
        },
      };
    }

    throw new Error("Claude did not return a usable apply result.");
  }

  private trySalvagePlanResult(stdout: string): TaskRunResult | null {
    const parsed = this.tryParseSalvagePlanEnvelope(stdout);
    if (!parsed) {
      return null;
    }
    try {
      return this.toTaskRunResult("plan", parsed);
    } catch {
      return null;
    }
  }

  private tryParseSalvagePlanEnvelope(stdout: string): ParsedEnvelope<PlanSchemaResponse> | null {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = stripMarkdownCodeFence(trimmed);
    const directObject = this.tryParseJsonRecord(normalized);
    if (directObject) {
      const directEnvelope = this.buildSalvagedPlanEnvelopeFromRecord(directObject, "direct_message", normalized);
      if (directEnvelope) {
        return directEnvelope;
      }
    }

    const extracted = extractEmbeddedJsonObject(normalized);
    if (extracted) {
      const embeddedObject = this.tryParseJsonRecord(extracted);
      if (embeddedObject) {
        const embeddedEnvelope = this.buildSalvagedPlanEnvelopeFromRecord(embeddedObject, "embedded_json", trimmed);
        if (embeddedEnvelope) {
          return embeddedEnvelope;
        }
      }
    }

    const proseEnvelope = this.buildSalvagedPlanEnvelopeFromText(trimmed);
    if (proseEnvelope) {
      return proseEnvelope;
    }
    return null;
  }

  private buildSalvagedPlanEnvelopeFromRecord(
    record: Record<string, unknown>,
    source: TaskProviderEvidence["finalMessageSource"],
    rawMessage: string
  ): ParsedEnvelope<PlanSchemaResponse> | null {
    const structuredOutput =
      record.structured_output && typeof record.structured_output === "object"
        ? (record.structured_output as Record<string, unknown>)
        : null;
    const summary =
      readOptionalNonEmptyString(record.summary) ??
      readOptionalNonEmptyString(structuredOutput?.summary) ??
      readOptionalNonEmptyString(record.title) ??
      readOptionalNonEmptyString(record.headline) ??
      readOptionalNonEmptyString(record.message);
    const options =
      this.readPlanOptionsFromUnknown(record.options) ??
      this.readPlanOptionsFromUnknown(record.choices) ??
      this.readPlanOptionsFromUnknown(record.candidates) ??
      this.readPlanOptionsFromUnknown(record.recommendations) ??
      this.readPlanOptionsFromUnknown(structuredOutput?.options);
    if (!summary || !options?.length) {
      return null;
    }
    return {
      payload: { ...record, summary, options } as PlanSchemaResponse,
      sessionId: typeof record.session_id === "string" ? record.session_id : null,
      source,
      rawMessage,
    };
  }

  private buildSalvagedPlanEnvelopeFromText(rawMessage: string): ParsedEnvelope<PlanSchemaResponse> | null {
    const fallback = this.parsePlanFromText(rawMessage);
    if (!fallback) {
      return null;
    }
    return {
      payload: { summary: fallback.summary, options: fallback.options } as PlanSchemaResponse,
      sessionId: this.tryExtractEnvelopeSessionId(rawMessage),
      source: "direct_message",
      rawMessage,
    };
  }

  private readPlanOptionsFromUnknown(value: unknown): PlanSchemaResponse["options"] | null {
    if (!Array.isArray(value)) {
      return null;
    }
    const normalized: PlanSchemaResponse["options"] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (!item || typeof item !== "object") {
        return null;
      }
      const record = item as Record<string, unknown>;
      const id =
        readOptionalNonEmptyString(record.id) ??
        readOptionalNonEmptyString(record.key) ??
        readOptionalNonEmptyString(record.name) ??
        `option_${String.fromCharCode(97 + index)}`;
      const title =
        readOptionalNonEmptyString(record.title) ??
        readOptionalNonEmptyString(record.name) ??
        readOptionalNonEmptyString(record.label) ??
        id;
      const summary =
        readOptionalNonEmptyString(record.summary) ??
        readOptionalNonEmptyString(record.description) ??
        readOptionalNonEmptyString(record.details) ??
        readOptionalNonEmptyString(record.reason) ??
        title;
      normalized.push({
        id,
        title,
        summary,
        recommended: record.recommended === true,
      });
    }
    return normalized.length >= 2 ? normalized : null;
  }

  private trySalvageAnalyzeResult(stdout: string, callbacks?: ProviderRunCallbacks): TaskRunResult | null {
    const parsed = this.tryParseSalvageAnalyzeEnvelope(stdout);
    if (!parsed) {
      return null;
    }
    try {
      const result = this.toAnalyzeTaskRunResult(parsed, callbacks);
      const payload = parsed.payload as unknown as Record<string, unknown>;
      if (payload.__salvagedFromText === true) {
        callbacks?.onRuntimeSignal(
          {
            code: "PROVIDER_ANALYZE_DEGRADED_OUTPUT",
            severity: "degraded",
            summary: "Provider returned malformed analyze output; using degraded text salvage.",
            detail: "Recovered analyze output from substantive final text because structured JSON was unavailable.",
          },
          parsed.rawMessage
        );
      }
      return result;
    } catch {
      return null;
    }
  }

  private tryParseSalvageAnalyzeEnvelope(stdout: string): ParsedEnvelope<AnalyzeSchemaResponse> | null {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return null;
    }

    const normalized = stripMarkdownCodeFence(trimmed);
    const directObject = this.tryParseJsonRecord(normalized);
    if (directObject) {
      const directEnvelope = this.buildSalvagedAnalyzeEnvelopeFromRecord(directObject, "direct_message", normalized);
      if (directEnvelope) {
        return directEnvelope;
      }
    }

    const extracted = extractEmbeddedJsonObject(normalized);
    if (extracted) {
      const embeddedObject = this.tryParseJsonRecord(extracted);
      if (embeddedObject) {
        const embeddedEnvelope = this.buildSalvagedAnalyzeEnvelopeFromRecord(embeddedObject, "embedded_json", trimmed);
        if (embeddedEnvelope) {
          return embeddedEnvelope;
        }
      }
    }

    const proseEnvelope = this.buildSalvagedAnalyzeEnvelopeFromText(trimmed);
    if (proseEnvelope) {
      return proseEnvelope;
    }
    return null;
  }

  private buildSalvagedAnalyzeEnvelopeFromRecord(
    record: Record<string, unknown>,
    source: TaskProviderEvidence["finalMessageSource"],
    rawMessage: string
  ): ParsedEnvelope<AnalyzeSchemaResponse> | null {
    const summary =
      readOptionalNonEmptyString(record.summary) ??
      readOptionalNonEmptyString(record.title) ??
      readOptionalNonEmptyString(record.headline);
    const details =
      readOptionalNonEmptyString(record.details) ??
      readOptionalNonEmptyString(record.output) ??
      readOptionalNonEmptyString(record.message) ??
      readNestedOptionalNonEmptyString(record, "structured_output", "details") ??
      readOptionalNonEmptyString(record.result);
    if (!summary || !details) {
      return null;
    }
    return {
      payload: { ...record, summary, details } as AnalyzeSchemaResponse,
      sessionId: typeof record.session_id === "string" ? record.session_id : null,
      source,
      rawMessage,
    };
  }

  private buildSalvagedAnalyzeEnvelopeFromText(rawMessage: string): ParsedEnvelope<AnalyzeSchemaResponse> | null {
    const text = rawMessage.trim();
    if (text.length < 80 || !/[\r\n]/.test(text)) {
      return null;
    }
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length < 2) {
      return null;
    }
    const summary = lines[0].replace(/^#+\s*/, "").trim();
    const details = lines.slice(1).join("\n").trim();
    if (!summary || !details || details.length < 40) {
      return null;
    }
    return {
      payload: { summary, details, __salvagedFromText: true } as AnalyzeSchemaResponse,
      sessionId: this.tryExtractEnvelopeSessionId(rawMessage),
      source: "direct_message",
      rawMessage,
    };
  }

  private tryParseJsonRecord(raw: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private hasNonEmptyStringField(payload: Record<string, unknown>, ...path: string[]): boolean {
    let current: unknown = payload;
    for (const segment of path) {
      if (!current || typeof current !== "object") {
        return false;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return typeof current === "string" && current.trim().length > 0;
  }

  private toAnalyzeTaskRunResult(
    parsed: ParsedEnvelope<AnalyzeSchemaResponse>,
    callbacks?: ProviderRunCallbacks
  ): TaskRunResult {
    const payload = parsed.payload as unknown as Record<string, unknown>;
    const providerEvidence = {
      finalMessageSource: parsed.source,
      finalizationPath: this.toFinalizationPath(parsed.source),
      lastAgentMessagePreview: previewText(parsed.rawMessage),
    };
    const strictSummary = readOptionalNonEmptyString(payload.summary);
    const strictDetails = readOptionalNonEmptyString(payload.details);
    if (strictSummary && strictDetails) {
      return {
        summary: strictSummary,
        output: strictDetails,
        providerEvidence,
      };
    }

    const envelopeSummary = readNestedOptionalNonEmptyString(payload, "structured_output", "summary");
    const envelopeDetails = readNestedOptionalNonEmptyString(payload, "structured_output", "details");
    const envelopeResult = readOptionalNonEmptyString(payload.result);
    const cleanSummary = strictSummary ?? envelopeSummary ?? "Analysis completed from provider output.";
    const cleanOutput = strictDetails ?? envelopeDetails ?? envelopeResult;
    if (cleanOutput) {
      return {
        summary: cleanSummary,
        output: cleanOutput,
        providerEvidence,
      };
    }

    const structuredOutput =
      payload.structured_output && typeof payload.structured_output === "object"
        ? (payload.structured_output as Record<string, unknown>)
        : null;
    const hasMalformedStrictFields = ("summary" in payload && !strictSummary) || ("details" in payload && !strictDetails);
    const hasMalformedStructuredFields =
      Boolean(structuredOutput) &&
      (("summary" in structuredOutput! && !envelopeSummary) || ("details" in structuredOutput! && !envelopeDetails));
    const inferredSummary =
      readOptionalNonEmptyString(payload.title) ?? readOptionalNonEmptyString(payload.headline) ?? strictSummary;
    const inferredOutput =
      readOptionalNonEmptyString(payload.output) ?? readOptionalNonEmptyString(payload.message) ?? envelopeResult;
    if (!hasMalformedStrictFields && !hasMalformedStructuredFields && inferredSummary && inferredOutput) {
      return {
        summary: inferredSummary,
        output: inferredOutput,
        providerEvidence,
      };
    }

    const fallbackSummary =
      strictSummary ??
      readOptionalNonEmptyString(payload.title) ??
      readOptionalNonEmptyString(payload.headline) ??
      "Analysis completed from provider output.";
    const fallbackOutput =
      strictDetails ??
      readOptionalNonEmptyString(payload.output) ??
      readOptionalNonEmptyString(payload.message) ??
      readOptionalNonEmptyString(parsed.rawMessage);
    if (!fallbackOutput) {
      throw new Error("Claude returned an unusable analyze result.");
    }

    callbacks?.onRuntimeSignal(
      {
        code: "PROVIDER_ANALYZE_DEGRADED_OUTPUT",
        severity: "degraded",
        summary: "Provider returned malformed analyze JSON; using degraded text extraction.",
        detail: "Recovered analyze output from the final provider message because the structured summary/details fields were invalid.",
      },
      parsed.rawMessage
    );

    return {
      summary: fallbackSummary,
      output: fallbackOutput,
      providerEvidence,
    };
  }

  private parsePayload<T>(label: string, stdout: string, stderr: string): ParsedEnvelope<T> {
    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error(stderr.trim() || `Claude did not return a usable ${label}.`);
    }

    const direct = this.tryParseEnvelope<T>(trimmed);
    if (direct) {
      return direct;
    }

    const normalized = stripMarkdownCodeFence(trimmed);
    const extracted = extractEmbeddedJsonObject(normalized);
    if (extracted) {
      const embeddedEnvelope = this.tryParseEnvelope<T>(extracted);
      if (embeddedEnvelope) {
        return {
          payload: embeddedEnvelope.payload,
          sessionId: embeddedEnvelope.sessionId,
          source: "embedded_json",
          rawMessage: embeddedEnvelope.rawMessage,
        };
      }
      return {
        payload: JSON.parse(extracted) as T,
        sessionId: null,
        source: "embedded_json",
        rawMessage: trimmed,
      };
    }

    throw new Error(`Claude did not return a usable ${label}.`);
  }

  private tryExtractEnvelopeSessionId(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const direct = this.tryReadEnvelopeSessionId(trimmed);
    if (direct) {
      return direct;
    }

    const normalized = stripMarkdownCodeFence(trimmed);
    const extracted = extractEmbeddedJsonObject(normalized);
    if (!extracted) {
      return null;
    }
    return this.tryReadEnvelopeSessionId(extracted);
  }

  private tryReadEnvelopeSessionId(raw: string): string | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownCodeFence(raw));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (sessionId) {
      return sessionId;
    }

    if (typeof record.result === "string") {
      return this.tryReadEnvelopeSessionId(record.result);
    }

    if (record.result && typeof record.result === "object") {
      return this.tryReadEnvelopeSessionId(JSON.stringify(record.result));
    }

    return null;
  }

  private tryExtractEnvelopeError(raw: string): { sessionId: string | null; source: TaskProviderEvidence["finalMessageSource"]; rawMessage: string } | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }

    const direct = this.tryReadEnvelopeError(trimmed, "direct_message");
    if (direct) {
      return direct;
    }

    const normalized = stripMarkdownCodeFence(trimmed);
    const extracted = extractEmbeddedJsonObject(normalized);
    if (!extracted) {
      return null;
    }
    return this.tryReadEnvelopeError(extracted, "embedded_json");
  }

  private tryReadEnvelopeError(
    raw: string,
    source: TaskProviderEvidence["finalMessageSource"]
  ): { sessionId: string | null; source: TaskProviderEvidence["finalMessageSource"]; rawMessage: string } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownCodeFence(raw));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (record.is_error === true) {
      const rawMessage = this.describeEnvelopeError(record) ?? raw;
      return { sessionId, source, rawMessage };
    }

    if (typeof record.result === "string") {
      const nested = this.tryReadEnvelopeError(record.result, source);
      if (nested) {
        return { sessionId: nested.sessionId ?? sessionId, source: nested.source, rawMessage: nested.rawMessage };
      }
    }

    if (record.result && typeof record.result === "object") {
      const nested = this.tryReadEnvelopeError(JSON.stringify(record.result), source);
      if (nested) {
        return { sessionId: nested.sessionId ?? sessionId, source: nested.source, rawMessage: nested.rawMessage };
      }
    }

    return null;
  }

  private tryParseEnvelope<T>(raw: string): ParsedEnvelope<T> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripMarkdownCodeFence(raw));
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.session_id === "string" ? record.session_id : null;
    if (record.is_error === true) {
      throw new Error(this.describeEnvelopeError(record) ?? raw);
    }

    if ("summary" in record || "stage" in record || "options" in record) {
      return {
        payload: record as T,
        sessionId,
        source: "direct_message",
        rawMessage: raw,
      };
    }

    const result = record.result;
    if (typeof result === "string") {
      const normalized = stripMarkdownCodeFence(result);
      if (!normalized.trim()) {
        throw new Error("Claude returned an empty result payload.");
      }
      try {
        return {
          payload: JSON.parse(normalized) as T,
          sessionId,
          source: "direct_message",
          rawMessage: result,
        };
      } catch {
        const extracted = extractEmbeddedJsonObject(normalized);
        if (!extracted) {
          return null;
        }
        const nested = this.tryParseEnvelope<T>(extracted);
        if (nested) {
          return {
            payload: nested.payload,
            sessionId: nested.sessionId ?? sessionId,
            source: "embedded_json",
            rawMessage: result,
          };
        }
        return {
          payload: JSON.parse(extracted) as T,
          sessionId,
          source: "embedded_json",
          rawMessage: result,
        };
      }
    }

    if (result && typeof result === "object") {
      const nested = this.tryParseEnvelope<T>(JSON.stringify(result));
      if (nested) {
        return {
          payload: nested.payload,
          sessionId: nested.sessionId ?? sessionId,
          source: "direct_message",
          rawMessage: JSON.stringify(result),
        };
      }
      return {
        payload: result as T,
        sessionId,
        source: "direct_message",
        rawMessage: JSON.stringify(result),
      };
    }

    return null;
  }

  private describeEnvelopeError(record: Record<string, unknown>): string | null {
    const result = typeof record.result === "string" ? record.result.trim() : "";
    const message = typeof record.message === "string" ? record.message.trim() : "";
    const subtype = typeof record.subtype === "string" ? record.subtype.trim() : "";
    const errorType = typeof record.error_type === "string" ? record.error_type.trim() : "";
    if (subtype === "error_max_structured_output_retries") {
      return subtype;
    }
    if (/\bapi error\b/i.test(result)) {
      return result;
    }
    const candidates = [message, errorType, subtype && subtype !== "success" ? subtype : "", result].filter(Boolean);
    if (!candidates.length) {
      return null;
    }
    return candidates[0] ?? null;
  }

  private parsePlanFromText(text: string): { summary: string; options: TaskDecisionOption[] } | null {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const options: TaskDecisionOption[] = [];
    let summary: string | null = null;
    let pendingOption: TaskDecisionOption | null = null;

    const flushPendingOption = () => {
      if (!pendingOption) {
        return;
      }
      options.push({
        ...pendingOption,
        title: pendingOption.title || pendingOption.id,
        summary: pendingOption.summary || pendingOption.title || pendingOption.id,
      });
      pendingOption = null;
    };

    for (const line of lines) {
      if (!summary && !/option/i.test(line) && !/^[-*•]/.test(line) && !/^\d+[.)]/.test(line)) {
        summary = line;
      }

      const headingMatch = line.match(/^(?:#{1,6}\s*)?(?:option\s+([a-z0-9]+)|([1-4])[.)])\s*[:\-–—]?\s*(.+)$/i);
      if (headingMatch) {
        flushPendingOption();
        const rawId = String(headingMatch[1] ?? headingMatch[2] ?? `${options.length + 1}`);
        const normalizedId = normalizeOptionId(rawId);
        const remainder = headingMatch[3]?.trim() ?? "";
        const normalizedRemainder = remainder.replace(/^recommended\s*[—:\-]?\s*/i, "").replace(/\[recommended\]/gi, "").trim();
        const [title, summaryText] = splitTitleSummary(normalizedRemainder);
        pendingOption = {
          id: normalizedId,
          title: title || normalizedId,
          summary: summaryText || title || normalizedRemainder || normalizedId,
          recommended: /\brecommended\b/i.test(remainder),
        };
        continue;
      }

      const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
      if (bulletMatch && pendingOption) {
        const detail = bulletMatch[1]?.trim() ?? "";
        if (detail) {
          pendingOption.summary = appendSentence(pendingOption.summary, detail);
          if (/\brecommended\b/i.test(detail)) {
            pendingOption.recommended = true;
          }
        }
        continue;
      }

      const inlineMatch = line.match(/^(?:option[\s_-]*([a-z0-9]+)|Option\s+([A-Z0-9]+))\s*[:\-]\s*(.+)$/i);
      if (inlineMatch) {
        flushPendingOption();
        const rawId = String(inlineMatch[1] ?? inlineMatch[2] ?? "");
        const normalizedId = normalizeOptionId(rawId);
        const remainder = inlineMatch[3]?.trim() ?? "";
        const [title, summaryText] = splitTitleSummary(remainder);
        options.push({
          id: normalizedId,
          title: title || normalizedId,
          summary: summaryText || title || remainder || normalizedId,
          recommended: /\brecommended\b/i.test(line),
        });
        continue;
      }

      if (pendingOption && !/^recommended option\s*:/i.test(line)) {
        pendingOption.summary = appendSentence(pendingOption.summary, line);
        if (/\brecommended\b/i.test(line)) {
          pendingOption.recommended = true;
        }
        continue;
      }
    }

    flushPendingOption();

    if (options.length < 2) {
      return null;
    }

    return {
      summary: summary ?? "Plan options extracted from provider output.",
      options,
    };
  }

  private parseApplyDecisionFromText(text: string): { summary: string; options: TaskDecisionOption[] } | null {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const options: TaskDecisionOption[] = [];
    let summary: string | null = null;

    for (const line of lines) {
      if (!summary && !/^#+\s*/.test(line) && !/^\d+\./.test(line) && !/options?/i.test(line)) {
        summary = line;
      }
      const match = line.match(/^([1-4])\.\s*(?:\*\*|__)?(.+?)(?:\*\*|__)?\s*$/);
      if (!match) {
        const recommendedHeader = line.match(/^recommended option\s*:\s*(.+)$/i);
        if (recommendedHeader) {
          const normalized = recommendedHeader[1]?.trim() ?? "";
          const [title, summaryText] = splitTitleSummary(normalized);
          options.push({
            id: "option_1",
            title: title || "Option 1",
            summary: summaryText || title || normalized || "Option 1",
            recommended: true,
          });
        }
        continue;
      }
      const rawBody = match[2]?.trim() ?? "";
      const cleaned = rawBody.replace(/\*\*/g, "").replace(/__/g, "").trim();
      const recommended = /^recommended\b/i.test(cleaned) || /\brecommended\b/i.test(cleaned) || /\[recommended\]/i.test(cleaned);
      const normalized = cleaned.replace(/^recommended\s*[—:\-]?\s*/i, "").replace(/\[recommended\]/gi, "").trim();
      const [title, summaryText] = splitTitleSummary(normalized);
      options.push({
        id: `option_${match[1]}`,
        title: title || `Option ${match[1]}`,
        summary: summaryText || title || normalized || `Option ${match[1]}`,
        recommended,
      });
    }

    if (options.length < 1) {
      return null;
    }

    return {
      summary: summary ?? "Apply options extracted from provider output.",
      options,
    };
  }

  private parseApplyOperation(operation: ApplyApprovalSchemaResponse["operations"][number]): ApplyOperation {
    const record = operation as unknown as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    if (!path) {
      throw commandFailure("PROVIDER_OUTPUT_INVALID", "Claude approval operation is missing a valid path.");
    }

    if (record.type === "write_file") {
      if (typeof record.content !== "string") {
        throw commandFailure("PROVIDER_OUTPUT_INVALID", `Claude write_file operation for ${path} is missing content.`);
      }
      return { type: "write_file", path, content: record.content };
    }

    const oldText =
      typeof record.oldText === "string"
        ? record.oldText
        : typeof record.old_text === "string"
          ? record.old_text
          : "";
    const newText =
      typeof record.newText === "string"
        ? record.newText
        : typeof record.new_text === "string"
          ? record.new_text
          : "";
    if (!oldText) {
      throw commandFailure("PROVIDER_OUTPUT_INVALID", `Claude replace_text operation for ${path} is missing oldText.`);
    }
    if (!newText) {
      throw commandFailure("PROVIDER_OUTPUT_INVALID", `Claude replace_text operation for ${path} is missing newText.`);
    }
    return {
      type: "replace_text",
      path,
      oldText,
      newText,
    };
  }

  private describeApplyOperation(operation: ApplyOperation): string {
    return operation.type === "write_file" ? `write_file ${operation.path}` : `replace_text ${operation.path}`;
  }

  private toFinalizationPath(
    source: TaskProviderEvidence["finalMessageSource"]
  ): TaskProviderEvidence["finalizationPath"] {
    if (source === "embedded_json") {
      return "embedded_json";
    }
    if (source === "stdout_scan") {
      return "stdout_scan";
    }
    if (source === "output_file") {
      return "output_file";
    }
    if (source === "stream_capture" || source === "direct_message") {
      return "stream_capture";
    }
    return "none";
  }

  private buildAnalyzePrompt(
    context: ProviderRunContext,
    forceJsonReply: boolean,
    localWorkspaceSnapshot?: LocalWorkspaceSnapshot | null
  ): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files or run mutating commands.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not ask follow-up questions or wait for user input. Return the best possible answer in a single response.",
      "Prefer the prompt, focus paths, and deterministic local workspace context before broad exploration.",
      `User request: ${context.prompt}`,
    ];
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    if (localWorkspaceSnapshot?.lines.length) {
      lines.push("Deterministic local workspace context:");
      lines.push(...localWorkspaceSnapshot.lines);
    }
    if (forceJsonReply) {
      lines.push('Return a raw JSON object only in this shape: {"summary":"...","details":"..."}');
      lines.push("Do not wrap the JSON in markdown fences.");
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
      "Do not ask the user to choose or wait for user input. Return the full option set in this response.",
      "Return 2 to 4 meaningful implementation options and mark exactly one option as recommended.",
      `User request: ${context.prompt}`,
    ];
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    if (localWorkspaceSnapshot?.lines.length) {
      lines.push("Deterministic local workspace context:");
      lines.push(...localWorkspaceSnapshot.lines);
    }
    if (forceJsonReply) {
      lines.push(
        'Return a raw JSON object only in this shape: {"summary":"...","options":[{"id":"option_a","title":"...","summary":"...","recommended":true}]}'
      );
      lines.push("Do not wrap the JSON in markdown fences.");
    }
    return lines.join("\n");
  }

  private buildApplyDecisionPrompt(context: ProviderRunContext, forceJsonReply: boolean): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files yourself.",
      "You are in a non-interactive task run. request_user_input is unavailable.",
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
      "Do not use delete, rename, git, terminal, debug, formatter, or shell-based edits.",
      "For replace_text, you must include path, oldText, and newText. oldText must be the exact existing text to replace, and newText must be the exact replacement text.",
      "Never emit placeholder-only operations. If you cannot provide exact oldText/newText yet, return stage=decision instead of stage=approval.",
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

  private buildResumePrompt(prompt: string, forceJsonReply: boolean): string {
    const lines = [
      prompt,
      "You are in a non-interactive task run. request_user_input is unavailable.",
      "Do not ask follow-up questions or wait for user input. Return the best possible result in one reply.",
    ];
    if (forceJsonReply) {
      lines.push('Return a raw JSON object only in this shape: {"summary":"...","details":"..."}');
      lines.push("Do not wrap the JSON in markdown fences.");
    }
    return lines.join("\n");
  }

  private analyzeSchema(): string {
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["summary", "details"],
      properties: {
        summary: { type: "string" },
        details: { type: "string" },
      },
    });
  }

  private planSchema(): string {
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["summary", "options"],
      properties: {
        summary: { type: "string" },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "summary", "recommended"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              recommended: { type: "boolean" },
            },
          },
        },
      },
    });
  }

  private applyDecisionSchema(): string {
    return JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["stage", "summary", "options"],
      properties: {
        stage: { const: "decision" },
        summary: { type: "string" },
        options: JSON.parse(this.planSchema()).properties.options,
      },
    });
  }

  private applyApprovalSchema(): string {
    return JSON.stringify({
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["stage", "summary", "operations"],
          properties: {
            stage: { const: "approval" },
            summary: { type: "string" },
            operations: {
              type: "array",
              items: {
                oneOf: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "path", "content"],
                    properties: {
                      type: { const: "write_file" },
                      path: { type: "string" },
                      content: { type: "string" },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "path", "oldText", "newText"],
                    properties: {
                      type: { const: "replace_text" },
                      path: { type: "string" },
                      oldText: { type: "string" },
                      newText: { type: "string" },
                    },
                  },
                ],
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["stage", "summary", "details"],
          properties: {
            stage: { const: "completed" },
            summary: { type: "string" },
            details: { type: "string" },
          },
        },
        JSON.parse(this.applyDecisionSchema()),
      ],
    });
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
}

function stripMarkdownCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractEmbeddedJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return value.slice(start, end + 1);
}

function normalizeOptionId(rawId: string): string {
  const value = rawId.trim().toLowerCase();
  if (!value) {
    return "option";
  }
  return value.startsWith("option_") ? value : `option_${value}`;
}


function splitTitleSummary(value: string): [string, string] {
  const separators = [" - ", " — ", " – ", ": ", " -", ":", " "];
  for (const separator of separators) {
    const index = value.indexOf(separator);
    if (index > 0) {
      return [value.slice(0, index).trim(), value.slice(index + separator.length).trim()];
    }
  }
  return [value.trim(), ""];
}

function appendSentence(base: string, addition: string): string {
  const next = addition.trim();
  if (!next) {
    return base.trim();
  }
  const current = base.trim();
  if (!current) {
    return next;
  }
  return /[.!?。！？:]$/.test(current) ? `${current} ${next}` : `${current}. ${next}`;
}

function previewText(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  return value.trim().slice(0, 280);
}
