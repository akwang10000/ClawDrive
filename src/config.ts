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
  providerPolicyLevel: "safe" | "extended" | "raw";
  providerDisableFeatures: string[];
  providerSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  tasksDefaultTimeoutMs: number;
  tasksHistoryLimit: number;
}

export function getConfig(): ClawDriveConfig {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  const providerDisableFeatures = cfg.get<string[]>("provider.disableFeatures", [
    "multi_agent",
    "plugins",
    "apps",
    "shell_snapshot",
  ]);
  return {
    gatewayHost: cfg.get<string>("gateway.host", "127.0.0.1"),
    gatewayPort: cfg.get<number>("gateway.port", 18789),
    gatewayTls: cfg.get<boolean>("gateway.tls", false),
    gatewayToken: cfg.get<string>("gateway.token", ""),
    autoConnect: cfg.get<boolean>("autoConnect", false),
    displayName: cfg.get<string>("displayName", "ClawDrive"),
    providerEnabled: cfg.get<boolean>("provider.enabled", false),
    providerKind: "codex",
    providerCodexPath: cfg.get<string>("provider.codex.path", "codex"),
    providerCodexModel: cfg.get<string>("provider.codex.model", ""),
    providerPolicyLevel: cfg.get<"safe" | "extended" | "raw">("provider.policyLevel", "safe"),
    providerDisableFeatures: Array.isArray(providerDisableFeatures)
      ? providerDisableFeatures
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter(Boolean)
      : [],
    providerSandboxMode: cfg.get<"read-only" | "workspace-write" | "danger-full-access">(
      "provider.sandboxMode",
      "read-only"
    ),
    tasksDefaultTimeoutMs: Math.max(5_000, cfg.get<number>("tasks.defaultTimeoutMs", 300_000)),
    tasksHistoryLimit: Math.max(1, cfg.get<number>("tasks.historyLimit", 50)),
  };
}
