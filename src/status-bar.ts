import * as vscode from "vscode";
import type { ConnectionState } from "./gateway-client";

export class ClawDriveStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "clawdrive.dashboard";
    this.item.show();
    this.update("disconnected", false);
  }

  update(state: ConnectionState, callable: boolean): void {
    if (state === "connected") {
      this.item.text = callable ? "$(plug) ClawDrive" : "$(warning) ClawDrive";
    } else if (state === "connecting") {
      this.item.text = "$(sync~spin) ClawDrive";
    } else {
      this.item.text = "$(debug-disconnect) ClawDrive";
    }

    this.item.tooltip = [
      `Connection: ${state}`,
      `Callable: ${callable ? "yes" : "no"}`,
      "Provider ready: not configured in Phase 1",
    ].join("\n");
  }

  dispose(): void {
    this.item.dispose();
  }
}
