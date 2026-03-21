import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";
import type { ConnectionState } from "./gateway-client";
import { t } from "./i18n";
import { getOutputChannel } from "./logger";
import { getRegisteredCommands } from "./commands/registry";
import { getProviderDiagnosisMessage } from "./provider-status";
import type { ProviderStatusInfo } from "./tasks/types";

interface LocalGatewayConfigSnapshot {
  path: string;
  token?: string;
  allowCommands?: string[];
}

type FindingLevel = "ok" | "info" | "warn" | "error";

interface DiagnosisFinding {
  level: FindingLevel;
  message: string;
  detail?: string;
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

export async function runConnectionDiagnosis(state: ConnectionState, providerStatus: ProviderStatusInfo): Promise<void> {
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
        if (localConfig.allowCommands && !localConfig.allowCommands.includes("vscode.workspace.info")) {
          findings.push({
            level: "warn",
            message: t("diagnosis.allowCommandsBlocked"),
            detail: t("diagnosis.allowCommandsBlockedDetail"),
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
