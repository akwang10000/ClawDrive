import * as vscode from "vscode";

export interface ClawDriveConfig {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls: boolean;
  gatewayToken: string;
  displayName: string;
}

export function getConfig(): ClawDriveConfig {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  return {
    gatewayHost: cfg.get<string>("gateway.host", "127.0.0.1"),
    gatewayPort: cfg.get<number>("gateway.port", 18789),
    gatewayTls: cfg.get<boolean>("gateway.tls", false),
    gatewayToken: cfg.get<string>("gateway.token", ""),
    displayName: cfg.get<string>("displayName", "ClawDrive"),
  };
}
