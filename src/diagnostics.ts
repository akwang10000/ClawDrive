import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";
import type { ConnectionState } from "./gateway-client";
import { getCurrentLocale, t } from "./i18n";
import { getOutputChannel } from "./logger";
import { getRegisteredCommands } from "./commands/registry";
import { getProviderDiagnosisMessage } from "./provider-status";
import type { ProviderStatusInfo, TaskSnapshot, TaskState } from "./tasks/types";

interface LocalGatewayConfigSnapshot {
  path: string;
  token?: string;
  allowCommands?: string[];
}

export type FindingLevel = "ok" | "info" | "warn" | "error";

export interface DiagnosisFinding {
  level: FindingLevel;
  message: string;
  detail?: string;
}

export interface ConnectionDiagnosisSnapshot {
  gatewayUrl: string;
  connectionState: ConnectionState;
  callable: boolean;
  providerStatus: ProviderStatusInfo;
  findings: DiagnosisFinding[];
}

export interface DiagnosisTaskSummary {
  taskId: string;
  title: string;
  state: TaskState;
  updatedAt: string;
  summary: string;
  errorCode: string | null;
  error: string | null;
}

export interface OperatorStatusSnapshot {
  gatewayUrl: string;
  connected: boolean;
  connectionState: ConnectionState;
  callable: boolean;
  providerReady: boolean;
  providerStatus: ProviderStatusInfo;
  findings: DiagnosisFinding[];
  latestTask: DiagnosisTaskSummary | null;
  latestTaskState: TaskState | null;
  latestFailureSummary: string | null;
  actionableHint: string | null;
}

function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

async function probeTcpPort(host: string, port: number, timeoutMs = 2500): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish());
    socket.once("timeout", () => finish(new Error(`Timed out after ${timeoutMs}ms`)));
    socket.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
    socket.connect(port, host);
  });
}

function tryLoadLocalGatewayConfig(): LocalGatewayConfigSnapshot | null {
  const filePath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    gateway?: {
      auth?: { token?: unknown };
      nodes?: { allowCommands?: unknown };
    };
  };

  return {
    path: filePath,
    token: typeof parsed.gateway?.auth?.token === "string" ? parsed.gateway.auth.token : undefined,
    allowCommands: Array.isArray(parsed.gateway?.nodes?.allowCommands)
      ? parsed.gateway.nodes.allowCommands.filter((value): value is string => typeof value === "string")
      : undefined,
  };
}

function formatLevel(level: FindingLevel): string {
  switch (level) {
    case "ok":
      return t("diagnosis.ok");
    case "info":
      return t("diagnosis.info");
    case "warn":
      return t("diagnosis.warn");
    default:
      return t("diagnosis.error");
  }
}

function localizedText(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}

function summarize(findings: DiagnosisFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((finding) => finding.level === "error").length,
    warnings: findings.filter((finding) => finding.level === "warn").length,
  };
}

function connectionStateText(state: ConnectionState): string {
  if (state === "connected") {
    return t("status.connected");
  }
  if (state === "connecting") {
    return t("status.connecting");
  }
  return t("status.disconnected");
}

function toDiagnosisTaskSummary(task: TaskSnapshot): DiagnosisTaskSummary {
  return {
    taskId: task.taskId,
    title: task.title,
    state: task.state,
    updatedAt: task.updatedAt,
    summary: task.summary,
    errorCode: task.errorCode ?? null,
    error: task.error ?? null,
  };
}

function buildActionableHint(
  diagnosis: ConnectionDiagnosisSnapshot,
  latestTask: DiagnosisTaskSummary | null
): string | null {
  if (diagnosis.connectionState !== "connected") {
    return localizedText(
      "Reconnect the Gateway session first, then retry the request.",
      "\u5148\u6062\u590d Gateway \u8fde\u63a5\uff0c\u518d\u91cd\u8bd5\u8bf7\u6c42\u3002"
    );
  }

  if (!diagnosis.callable) {
    return localizedText(
      "Allow the advertised commands in OpenClaw allowCommands before retrying.",
      "\u5148\u5728 OpenClaw \u7684 allowCommands \u4e2d\u653e\u884c\u5f53\u524d\u5e7f\u544a\u547d\u4ee4\uff0c\u518d\u91cd\u8bd5\u3002"
    );
  }

  if (!diagnosis.providerStatus.ready) {
    return localizedText(
      "Fix provider readiness first, especially the Codex executable path or local installation.",
      "\u5148\u4fee\u590d provider \u5c31\u7eea\u95ee\u9898\uff0c\u91cd\u70b9\u68c0\u67e5 Codex \u53ef\u6267\u884c\u8def\u5f84\u548c\u672c\u5730\u5b89\u88c5\u3002"
    );
  }

  if (latestTask?.state === "failed") {
    return localizedText(
      "Inspect the latest failed task summary and error code before re-running the task.",
      "\u5148\u67e5\u770b\u6700\u8fd1\u5931\u8d25\u4efb\u52a1\u7684\u6458\u8981\u548c\u9519\u8bef\u7801\uff0c\u518d\u51b3\u5b9a\u662f\u5426\u91cd\u8bd5\u3002"
    );
  }

  if (latestTask?.state === "waiting_decision") {
    return localizedText(
      "The latest task is waiting for a decision. Continue it instead of starting a duplicate task.",
      "\u6700\u8fd1\u4efb\u52a1\u6b63\u5728\u7b49\u5f85\u51b3\u7b56\uff0c\u4f18\u5148\u7ee7\u7eed\u5b83\uff0c\u800c\u4e0d\u662f\u518d\u8d77\u4e00\u4e2a\u91cd\u590d\u4efb\u52a1\u3002"
    );
  }

  if (latestTask?.state === "interrupted") {
    return localizedText(
      "Resume the interrupted task before starting a new one.",
      "\u5148\u6062\u590d\u88ab\u4e2d\u65ad\u7684\u4efb\u52a1\uff0c\u518d\u51b3\u5b9a\u662f\u5426\u65b0\u5f00\u4efb\u52a1\u3002"
    );
  }

  return null;
}

export function isCallableWithLocalConfig(): boolean {
  const commands = getRegisteredCommands();
  if (!commands.length) {
    return false;
  }

  const cfg = getConfig();
  if (!isLoopbackHost(cfg.gatewayHost)) {
    return true;
  }

  const localConfig = tryLoadLocalGatewayConfig();
  if (!localConfig?.allowCommands || !localConfig.allowCommands.length) {
    return true;
  }

  return commands.every((command) => localConfig.allowCommands?.includes(command));
}

export async function collectConnectionDiagnosis(
  state: ConnectionState,
  providerStatus: ProviderStatusInfo
): Promise<ConnectionDiagnosisSnapshot> {
  const cfg = getConfig();
  const findings: DiagnosisFinding[] = [];
  const commands = getRegisteredCommands();
  const gatewayUrl = `${cfg.gatewayTls ? "wss" : "ws"}://${cfg.gatewayHost}:${cfg.gatewayPort}`;

  findings.push({
    level: "info",
    message: t("diagnosis.gatewayConfigured", gatewayUrl),
  });
  findings.push({
    level: cfg.gatewayToken.trim() ? "ok" : "warn",
    message: cfg.gatewayToken.trim() ? t("diagnosis.tokenConfigured") : t("diagnosis.tokenMissing"),
    detail: cfg.gatewayToken.trim() ? undefined : t("diagnosis.tokenMissingDetail"),
  });
  findings.push({
    level: commands.length > 0 ? "ok" : "error",
    message: commands.length > 0 ? t("diagnosis.commandsReady", commands.join(", ")) : t("diagnosis.commandsEmpty"),
  });

  if (cfg.gatewayTls && isLoopbackHost(cfg.gatewayHost)) {
    findings.push({
      level: "warn",
      message: t("diagnosis.loopbackTlsWarn"),
      detail: t("diagnosis.loopbackTlsWarnDetail"),
    });
  }

  try {
    await probeTcpPort(cfg.gatewayHost, cfg.gatewayPort);
    findings.push({
      level: "ok",
      message: t("diagnosis.gatewayReachable"),
    });
  } catch (error) {
    findings.push({
      level: "error",
      message: t("diagnosis.gatewayUnreachable", cfg.gatewayHost, cfg.gatewayPort),
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (isLoopbackHost(cfg.gatewayHost)) {
    try {
      const localConfig = tryLoadLocalGatewayConfig();
      if (!localConfig) {
        findings.push({
          level: "warn",
          message: t("diagnosis.localConfigMissing"),
        });
      } else {
        findings.push({
          level: "info",
          message: t("diagnosis.localConfigLoaded", localConfig.path),
        });
        if (localConfig.token && cfg.gatewayToken.trim() && localConfig.token !== cfg.gatewayToken.trim()) {
          findings.push({
            level: "warn",
            message: t("diagnosis.tokenMismatch"),
            detail: t("diagnosis.tokenMismatchDetail"),
          });
        }
        const missingCommands = commands.filter((command) => !localConfig.allowCommands?.includes(command));
        if (localConfig.allowCommands && missingCommands.length > 0) {
          findings.push({
            level: "warn",
            message: localizedText(
              "Local allowCommands may block part of the advertised command surface.",
              "\u672c\u5730 allowCommands \u53ef\u80fd\u62e6\u622a\u4e86\u90e8\u5206\u5df2\u5e7f\u544a\u547d\u4ee4\u3002"
            ),
            detail: localizedText(
              `Add these commands to allowCommands: ${missingCommands.join(", ")}`,
              `\u8bf7\u5728 allowCommands \u91cc\u52a0\u5165\u8fd9\u4e9b\u547d\u4ee4\uff1A${missingCommands.join(", ")}`
            ),
          });
        }
      }
    } catch (error) {
      findings.push({
        level: "warn",
        message: t("diagnosis.localConfigReadFailed"),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    findings.push({
      level: "info",
      message: t("diagnosis.remoteGateway"),
    });
  }

  findings.push({
    level: state === "connected" ? "ok" : "warn",
    message: t("diagnosis.sessionState", connectionStateText(state)),
    detail: state === "connected" ? undefined : t("diagnosis.sessionStateDetail"),
  });

  const callable = isCallableWithLocalConfig();
  findings.push({
    level: callable ? "ok" : "warn",
    message: t("diagnosis.callableState", callable ? t("status.ready") : t("status.blocked")),
    detail: callable ? undefined : t("diagnosis.callableStateDetail"),
  });

  const providerDiagnosis = getProviderDiagnosisMessage(providerStatus);
  findings.push({
    level: "info",
    message: providerDiagnosis.message,
    detail: providerDiagnosis.detail,
  });

  return {
    gatewayUrl,
    connectionState: state,
    callable,
    providerStatus,
    findings,
  };
}

export async function collectOperatorStatus(
  state: ConnectionState,
  providerStatus: ProviderStatusInfo,
  latestTask?: TaskSnapshot | null
): Promise<OperatorStatusSnapshot> {
  const diagnosis = await collectConnectionDiagnosis(state, providerStatus);
  return buildOperatorStatusFromDiagnosis(diagnosis, latestTask);
}

export function buildOperatorStatusFromDiagnosis(
  diagnosis: ConnectionDiagnosisSnapshot,
  latestTask?: TaskSnapshot | null
): OperatorStatusSnapshot {
  const latest = latestTask ? toDiagnosisTaskSummary(latestTask) : null;
  const latestFailureSummary =
    latest?.state === "failed"
      ? latest.errorCode
        ? `${latest.errorCode}: ${latest.error ?? latest.summary}`
        : latest.error ?? latest.summary
      : null;

  return {
    gatewayUrl: diagnosis.gatewayUrl,
    connected: diagnosis.connectionState === "connected",
    connectionState: diagnosis.connectionState,
    callable: diagnosis.callable,
    providerReady: diagnosis.providerStatus.ready,
    providerStatus: diagnosis.providerStatus,
    findings: diagnosis.findings,
    latestTask: latest,
    latestTaskState: latest?.state ?? null,
    latestFailureSummary,
    actionableHint: buildActionableHint(diagnosis, latest),
  };
}

export async function runConnectionDiagnosis(
  state: ConnectionState,
  providerStatus: ProviderStatusInfo,
  latestTask?: TaskSnapshot | null
): Promise<void> {
  const snapshot = await collectOperatorStatus(state, providerStatus, latestTask);
  const findings = snapshot.findings;

  const output = getOutputChannel();
  output.show(true);
  output.appendLine("");
  output.appendLine(t("diagnosis.title"));
  for (const finding of findings) {
    output.appendLine(`${formatLevel(finding.level)}  ${finding.message}`);
    if (finding.detail) {
      output.appendLine(`      ${finding.detail}`);
    }
  }
  if (snapshot.latestTask) {
    output.appendLine(
      `${formatLevel(snapshot.latestTask.state === "failed" ? "warn" : "info")}  ${localizedText(
        `Latest task: ${snapshot.latestTask.title} (${snapshot.latestTask.state})`,
        `\u6700\u8fd1\u4efb\u52a1\uff1a${snapshot.latestTask.title}\uff08${snapshot.latestTask.summary}\uff09`
      )}`
    );
    if (snapshot.latestFailureSummary) {
      output.appendLine(`      ${snapshot.latestFailureSummary}`);
    }
  }
  if (snapshot.actionableHint) {
    output.appendLine(`      ${snapshot.actionableHint}`);
  }

  const summary = summarize(findings);
  const summaryText = t("notify.diagnosisSummary", summary.errors, summary.warnings);
  const openLogText = t("notify.openLog");
  const action =
    summary.errors > 0
      ? await vscode.window.showWarningMessage(summaryText, openLogText)
      : await vscode.window.showInformationMessage(summaryText, openLogText);

  if (action === openLogText) {
    output.show(true);
  }
}
