import * as vscode from "vscode";

export interface ClawDriveConfig {
  gatewayHost: string;
  gatewayPort: number;
  displayName: string;
}

export function getConfig(): ClawDriveConfig {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  return {
    gatewayHost: cfg.get<string>("gateway.host", "127.0.0.1"),
    gatewayPort: cfg.get<number>("gateway.port", 3100),
    displayName: cfg.get<string>("displayName", "ClawDrive"),
  };
}
