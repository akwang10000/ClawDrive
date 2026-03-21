import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import type { ClawDriveConfig } from "../config";
import { commandFailure } from "../guards/errors";
import { log, logError } from "../logger";
import { taskResumePrompt } from "./text";
import type { ProviderProbeResult, ProviderRunCallbacks, ProviderRunContext, TaskProvider } from "./provider";
import type { TaskDecisionRequest, TaskResponseInput, TaskRunResult } from "./types";

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

export class CodexCliProvider implements TaskProvider {
  readonly kind = "codex";

  constructor(private readonly config: ClawDriveConfig) {}

  async probe(): Promise<ProviderProbeResult> {
    if (!this.config.providerEnabled || this.config.providerKind !== "codex") {
      return { ready: false, state: "disabled", detail: "Codex provider is disabled." };
    }

    try {
      const executable = await this.resolveExecutable();
      await this.runCommand(executable, ["--version"], process.cwd(), new AbortController().signal, false);
      return { ready: true, state: "ready", detail: `Using ${executable}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        state: /not found|not exist|not recognized/i.test(message) ? "missing" : "error",
        detail: message,
      };
    }
  }

  async startTask(context: ProviderRunContext, callbacks: ProviderRunCallbacks, signal: AbortSignal): Promise<TaskRunResult> {
    const executable = await this.resolveExecutable();
    const schemaPath = await this.writeSchema(context.mode === "plan" ? this.planSchema() : this.analyzeSchema());
    try {
      const prompt = context.mode === "plan" ? this.buildPlanPrompt(context) : this.buildAnalyzePrompt(context);
      const raw = await this.runCommand(
        executable,
        this.buildExecArgs(context.workspacePath, schemaPath, prompt),
        context.workspacePath,
        signal,
        true,
        callbacks
      );
      return context.mode === "plan" ? this.parsePlanResult(raw) : this.parseAnalyzeResult(raw);
    } finally {
      await fs.rm(schemaPath, { force: true });
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
    const schemaPath = await this.writeSchema(this.analyzeSchema());
    try {
      const raw = await this.runCommand(
        executable,
        this.buildResumeArgs(context.workspacePath, schemaPath, context.sessionId, taskResumePrompt(undefined, response.message)),
        context.workspacePath,
        signal,
        true,
        callbacks
      );
      return this.parseAnalyzeResult(raw);
    } finally {
      await fs.rm(schemaPath, { force: true });
    }
  }

  private async resolveExecutable(): Promise<string> {
    const configured = (this.config.providerCodexPath || "codex").trim();
    if (!configured) {
      throw new Error("Codex executable path is empty.");
    }
    const bareExecutable = /^[A-Za-z0-9._-]+(?:\.exe|\.cmd|\.bat)?$/;
    if (path.isAbsolute(configured)) {
      await fs.access(configured);
      return configured;
    }
    if (!bareExecutable.test(configured)) {
      throw new Error("Codex executable must be a bare executable name or an absolute path.");
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

  private buildExecArgs(workspacePath: string | null, schemaPath: string, prompt: string): string[] {
    const args = [
      "--ask-for-approval",
      "never",
      "-c",
      "shell_environment_policy.inherit=all",
      "exec",
      "--json",
      "--sandbox",
      "read-only",
    ];
    if (workspacePath) {
      args.push("-C", workspacePath);
    } else {
      args.push("--skip-git-repo-check");
    }
    if (this.config.providerCodexModel.trim()) {
      args.push("-m", this.config.providerCodexModel.trim());
    }
    args.push("--output-schema", schemaPath, prompt);
    return args;
  }

  private buildResumeArgs(workspacePath: string | null, schemaPath: string, sessionId: string, prompt: string): string[] {
    const args = [
      "--ask-for-approval",
      "never",
      "-c",
      "shell_environment_policy.inherit=all",
      "exec",
      "resume",
      "--json",
    ];
    if (!workspacePath) {
      args.push("--skip-git-repo-check");
    }
    if (this.config.providerCodexModel.trim()) {
      args.push("-m", this.config.providerCodexModel.trim());
    }
    args.push("--output-schema", schemaPath, sessionId, prompt);
    return args;
  }

  private async runCommand(
    executable: string,
    args: string[],
    cwd: string | null,
    signal: AbortSignal,
    parseEvents: boolean,
    callbacks?: ProviderRunCallbacks
  ): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: cwd ?? undefined,
        env: process.env,
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

  private parseAnalyzeResult(raw: string): TaskRunResult {
    const parsed = JSON.parse(this.extractLastAgentMessage(raw)) as AnalyzeSchemaResponse;
    return {
      summary: parsed.summary.trim(),
      output: parsed.details.trim(),
      decision: null,
    };
  }

  private parsePlanResult(raw: string): TaskRunResult {
    const parsed = JSON.parse(this.extractLastAgentMessage(raw)) as PlanSchemaResponse;
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

  private buildAnalyzePrompt(context: ProviderRunContext): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files, run mutating commands, or suggest applying changes now.",
      "Prefer reasoning over shell exploration.",
      "If you need shell commands, keep them minimal and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer Get-ChildItem, Get-Content, and other basic built-in commands over rg-heavy scans.",
      "Produce a concise explanation and a more detailed analysis.",
      `User request: ${context.prompt}`,
    ];
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    return lines.join("\n");
  }

  private buildPlanPrompt(context: ProviderRunContext): string {
    const lines = [
      "You are running inside ClawDrive for VS Code.",
      "Stay read-only. Do not modify files.",
      "Prefer reasoning over shell exploration.",
      "If you need shell commands, keep them minimal and read-only.",
      "Do not assume rg is installed.",
      "On Windows, prefer basic built-in commands over rg-heavy scans.",
      "Return 2 to 4 meaningful implementation options and mark exactly one option as recommended.",
      "Each option must be distinct and concise.",
      `User request: ${context.prompt}`,
    ];
    if (context.paths.length) {
      lines.push(`Focus paths: ${context.paths.join(", ")}`);
    }
    return lines.join("\n");
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

  private async writeSchema(content: string): Promise<string> {
    const filePath = path.join(os.tmpdir(), `clawdrive-schema-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }
}
