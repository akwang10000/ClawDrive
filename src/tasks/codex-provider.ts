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
  detectCodexCliCapabilities,
  sanitizeCodexConfig,
  validateCodexExecutablePath,
  type CodexCliCapabilities,
} from "./codex-cli";
import type { ProviderProbeResult, ProviderRunCallbacks, ProviderRunContext, TaskProvider } from "./provider";
import { commandFailure as commandFailureTypeGuard } from "../guards/errors";
import type { ApplyOperation, TaskApprovalRequest, TaskDecisionRequest, TaskResponseInput, TaskRunResult } from "./types";

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
      const finalMessage = outputPath ? await this.readOutputMessage(outputPath) : null;
      if (context.mode === "plan") {
        return this.parsePlanResult(raw, finalMessage);
      }
      if (context.mode === "apply") {
        return this.parseApplyResult(raw, finalMessage);
      }
      return this.parseAnalyzeResult(raw, finalMessage);
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
      const message = outputPath ? await this.readOutputMessage(outputPath) : this.extractLastAgentMessage(raw);
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
    const capabilities = detectCodexCliCapabilities(rootHelp, execHelp, resumeHelp);
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
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: cwd ?? undefined,
        env: env ?? process.env,
        windowsHide: true,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let stdoutBuffer = "";
      const onAbort = () => child.kill();
      signal.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout += text;
        if (!parseEvents) {
          return;
        }
        stdoutBuffer += text;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          this.handleStdoutLine(line, callbacks);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          logError(`codex: ${line}`);
          callbacks?.onOutput(line);
        }
      });

      child.once("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.once("close", (code, closeSignal) => {
        signal.removeEventListener("abort", onAbort);
        if (stdoutBuffer.trim()) {
          this.handleStdoutLine(stdoutBuffer, callbacks);
        }
        if (signal.aborted) {
          reject(new Error(String(signal.reason ?? "aborted")));
          return;
        }
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(new Error(stderr.trim() || stdout.trim() || `codex exited with code ${code ?? "unknown"} (${closeSignal ?? "no-signal"})`));
      });
    });
  }

  private handleStdoutLine(line: string, callbacks?: ProviderRunCallbacks): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "thread.started" && typeof parsed.thread_id === "string") {
        callbacks?.onSessionId(parsed.thread_id);
        return;
      }
      if (type === "turn.started") {
        callbacks?.onProgress("Codex task turn started.");
        return;
      }
      if (type === "turn.completed") {
        callbacks?.onProgress("Codex task turn completed.");
        return;
      }
      if (type === "item.completed") {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          callbacks?.onOutput(item.text);
          callbacks?.onProgress("Received Codex output.");
        }
      }
    } catch {
      log(`codex stdout: ${trimmed}`);
    }
  }

  private parseAnalyzeResult(raw: string, finalMessage?: string | null): TaskRunResult {
    const parsed = JSON.parse(stripMarkdownCodeFence(finalMessage ?? this.extractLastAgentMessage(raw))) as AnalyzeSchemaResponse;
    return {
      summary: parsed.summary.trim(),
      output: parsed.details.trim(),
      decision: null,
    };
  }

  private parseAnalyzeMessage(message: string): TaskRunResult {
    const parsed = JSON.parse(stripMarkdownCodeFence(message)) as AnalyzeSchemaResponse;
    return {
      summary: parsed.summary.trim(),
      output: parsed.details.trim(),
      decision: null,
    };
  }

  private parsePlanResult(raw: string, finalMessage?: string | null): TaskRunResult {
    const parsed = JSON.parse(stripMarkdownCodeFence(finalMessage ?? this.extractLastAgentMessage(raw))) as PlanSchemaResponse;
    const decision: TaskDecisionRequest = {
      summary: parsed.summary.trim(),
      options: parsed.options.map((option) => ({
        id: option.id.trim(),
        title: option.title.trim(),
        summary: option.summary.trim(),
        recommended: option.recommended,
      })),
      recommendedOptionId: parsed.options.find((option) => option.recommended)?.id ?? null,
    };
    return {
      summary: decision.summary,
      output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
      decision,
    };
  }

  private parseApplyResult(raw: string, finalMessage?: string | null): TaskRunResult {
    const parsed = JSON.parse(stripMarkdownCodeFence(finalMessage ?? this.extractLastAgentMessage(raw))) as ApplySchemaResponse;
    if (parsed.stage === "decision") {
      const decision: TaskDecisionRequest = {
        summary: parsed.summary.trim(),
        options: parsed.options.map((option) => ({
          id: option.id.trim(),
          title: option.title.trim(),
          summary: option.summary.trim(),
          recommended: option.recommended,
        })),
        recommendedOptionId: parsed.options.find((option) => option.recommended)?.id ?? null,
      };
      return {
        summary: decision.summary,
        output: decision.options.map((option) => `${option.id}: ${option.title} - ${option.summary}`).join("\n"),
        decision,
      };
    }

    if (parsed.stage === "approval") {
      const approval: TaskApprovalRequest = {
        summary: parsed.summary.trim(),
        operations: parsed.operations.map((operation) => this.parseApplyOperation(operation)),
      };
      return {
        summary: approval.summary,
        output: approval.operations.map((operation) => this.describeApplyOperation(operation)).join("\n"),
        approval,
      };
    }

    return {
      summary: parsed.summary.trim(),
      output: parsed.details.trim(),
      decision: null,
      approval: null,
    };
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

  private async readOutputMessage(filePath: string): Promise<string> {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      throw new Error("Codex resume did not return a final message.");
    }
    return raw.trim();
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

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
