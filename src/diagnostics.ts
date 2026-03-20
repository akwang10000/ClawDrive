import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";
import type { ConnectionState } from "./gateway-client";
import { getOutputChannel } from "./logger";
import { getRegisteredCommands } from "./commands/registry";

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
      return "OK";
    case "info":
      return "INFO";
    case "warn":
      return "WARN";
    default:
      return "ERROR";
  }
}

function summarize(findings: DiagnosisFinding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((finding) => finding.level === "error").length,
    warnings: findings.filter((finding) => finding.level === "warn").length,
  };
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

export async function runConnectionDiagnosis(state: ConnectionState): Promise<void> {
  const cfg = getConfig();
  const findings: DiagnosisFinding[] = [];
  const commands = getRegisteredCommands();

  findings.push({
    level: "info",
    message: `Configured gateway: ${cfg.gatewayTls ? "wss" : "ws"}://${cfg.gatewayHost}:${cfg.gatewayPort}`,
  });
  findings.push({
    level: cfg.gatewayToken.trim() ? "ok" : "warn",
    message: cfg.gatewayToken.trim() ? "Gateway token is configured." : "Gateway token is empty.",
    detail: cfg.gatewayToken.trim()
      ? undefined
      : "Set clawdrive.gateway.token before connecting to a protected Gateway.",
  });
  findings.push({
    level: commands.length > 0 ? "ok" : "error",
    message: commands.length > 0
      ? `Advertised command surface is ready (${commands.join(", ")}).`
      : "Advertised command surface is empty.",
  });

  if (cfg.gatewayTls && isLoopbackHost(cfg.gatewayHost)) {
    findings.push({
      level: "warn",
      message: "TLS is enabled for a loopback Gateway host.",
      detail: "Most local OpenClaw gateways use ws://127.0.0.1:18789 rather than TLS.",
    });
  }

  try {
    await probeTcpPort(cfg.gatewayHost, cfg.gatewayPort);
    findings.push({
      level: "ok",
      message: "Gateway TCP port is reachable.",
    });
  } catch (error) {
    findings.push({
      level: "error",
      message: `Cannot reach ${cfg.gatewayHost}:${cfg.gatewayPort}.`,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (isLoopbackHost(cfg.gatewayHost)) {
    try {
      const localConfig = tryLoadLocalGatewayConfig();
      if (!localConfig) {
        findings.push({
          level: "warn",
          message: "Local OpenClaw config was not found at ~/.openclaw/openclaw.json.",
        });
      } else {
        findings.push({
          level: "info",
          message: `Loaded local OpenClaw config from ${localConfig.path}.`,
        });
        if (localConfig.token && cfg.gatewayToken.trim() && localConfig.token !== cfg.gatewayToken.trim()) {
          findings.push({
            level: "warn",
            message: "Configured Gateway token does not match the local OpenClaw token.",
            detail: "Copy gateway.auth.token from ~/.openclaw/openclaw.json if this is your local Gateway.",
          });
        }
        if (localConfig.allowCommands && !localConfig.allowCommands.includes("vscode.workspace.info")) {
          findings.push({
            level: "warn",
            message: "Local allowCommands may block vscode.workspace.info.",
            detail: "Connected but not callable is likely until vscode.workspace.info is included.",
          });
        }
      }
    } catch (error) {
      findings.push({
        level: "warn",
        message: "Could not read the local OpenClaw config for diagnosis.",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    findings.push({
      level: "info",
      message: "Remote Gateway host detected; local config checks were skipped.",
    });
  }

  findings.push({
    level: state === "connected" ? "ok" : "warn",
    message: `Current session state: ${state}.`,
    detail: state === "connected" ? undefined : "Run ClawDrive: Connect to establish a Gateway session.",
  });
  findings.push({
    level: isCallableWithLocalConfig() ? "ok" : "warn",
    message: `Callable state: ${isCallableWithLocalConfig() ? "ready" : "blocked or uncertain"}.`,
    detail: isCallableWithLocalConfig()
      ? undefined
      : "Check local allowCommands and confirm the advertised command surface is permitted.",
  });
  findings.push({
    level: "info",
    message: "Provider ready: not implemented in Phase 1.",
  });

  const output = getOutputChannel();
  output.show(true);
  output.appendLine("");
  output.appendLine("=== ClawDrive Connection Diagnosis ===");
  for (const finding of findings) {
    output.appendLine(`${formatLevel(finding.level)}  ${finding.message}`);
    if (finding.detail) {
      output.appendLine(`      ${finding.detail}`);
    }
  }

  const summary = summarize(findings);
  const summaryText = `Diagnosis complete: ${summary.errors} error(s), ${summary.warnings} warning(s).`;
  if (summary.errors > 0) {
    await vscode.window.showWarningMessage(summaryText, "Open Log");
  } else {
    await vscode.window.showInformationMessage(summaryText, "Open Log");
  }
}
