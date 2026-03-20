import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | undefined;

export function getOutputChannel(): vscode.OutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("ClawDrive");
  }
  return outputChannel;
}

export function log(message: string): void {
  getOutputChannel().appendLine(message);
}

export function logError(message: string): void {
  getOutputChannel().appendLine(`[error] ${message}`);
}
