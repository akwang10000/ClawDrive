import * as vscode from "vscode";
import { getConfig } from "./config";

let outputChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("ClawDrive");
  }
  outputChannel.appendLine(message);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("ClawDrive");
  const cfg = getConfig();

  log("Activating ClawDrive for VS Code");
  log(`Configured gateway: ${cfg.gatewayHost}:${cfg.gatewayPort}`);

  const showStatus = vscode.commands.registerCommand("clawdrive.showStatus", async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(no workspace)";
    const message = [
      `Display name: ${cfg.displayName}`,
      `Gateway: ${cfg.gatewayHost}:${cfg.gatewayPort}`,
      `Workspace: ${workspaceFolder}`,
      "Status: bootstrap scaffold only",
    ].join("\n");

    log("Showing bootstrap status");
    await vscode.window.showInformationMessage("ClawDrive bootstrap status opened.");
    outputChannel?.show(true);
    outputChannel?.appendLine("");
    outputChannel?.appendLine(message);
  });

  context.subscriptions.push(showStatus, outputChannel);
}

export function deactivate(): void {
  outputChannel?.dispose();
  outputChannel = undefined;
}
