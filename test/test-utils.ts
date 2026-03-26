import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { ClawDriveConfig } from "../src/config";

export function makeConfig(overrides?: Partial<ClawDriveConfig>): ClawDriveConfig {
  return {
    gatewayHost: "127.0.0.1",
    gatewayPort: 18789,
    gatewayTls: false,
    gatewayToken: "token",
    autoConnect: false,
    displayName: "ClawDrive",
    providerEnabled: true,
    providerKind: "codex",
    providerCodexPath: "codex",
    providerCodexModel: "",
    tasksDefaultTimeoutMs: 5_000,
    tasksHistoryLimit: 20,
    ...overrides,
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

export function makeExtensionContext(rootPath: string): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file(rootPath),
  } as vscode.ExtensionContext;
}

export function setWorkspaceRoot(rootPath: string): void {
  (vscode as typeof vscode & {
    __setWorkspaceFolders?: (folders: Array<{ name: string; uri: { fsPath: string; scheme: string } }>) => void;
  }).__setWorkspaceFolders?.([
    {
      name: path.basename(rootPath),
      uri: vscode.Uri.file(rootPath),
    },
  ]);
}

export function setLanguage(language: string): void {
  (vscode as typeof vscode & { __setLanguage?: (value: string) => void }).__setLanguage?.(language);
}

export function setVscodeConfig(values: Record<string, unknown>): void {
  (vscode as typeof vscode & { __setConfig?: (value: Record<string, unknown>) => void }).__setConfig?.(values);
}
