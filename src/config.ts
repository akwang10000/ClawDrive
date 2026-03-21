import * as vscode from "vscode";

export interface ClawDriveConfig {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls: boolean;
  gatewayToken: string;
  autoConnect: boolean;
  displayName: string;
  providerEnabled: boolean;
  providerKind: "codex";
  providerCodexPath: string;
  providerCodexModel: string;
  tasksDefaultTimeoutMs: number;
  tasksHistoryLimit: number;
}

export function getConfig(): ClawDriveConfig {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  return {
    gatewayHost: cfg.get<string>("gateway.host", "127.0.0.1"),
    gatewayPort: cfg.get<number>("gateway.port", 18789),
    gatewayTls: cfg.get<boolean>("gateway.tls", false),
    gatewayToken: cfg.get<string>("gateway.token", ""),
    autoConnect: cfg.get<boolean>("autoConnect", true),
    displayName: cfg.get<string>("displayName", "ClawDrive"),
    providerEnabled: cfg.get<boolean>("provider.enabled", false),
    providerKind: "codex",
    providerCodexPath: cfg.get<string>("provider.codex.path", "codex"),
    providerCodexModel: cfg.get<string>("provider.codex.model", ""),
    tasksDefaultTimeoutMs: Math.max(5_000, cfg.get<number>("tasks.defaultTimeoutMs", 300_000)),
    tasksHistoryLimit: Math.max(1, cfg.get<number>("tasks.historyLimit", 50)),
  };
}
