import * as vscode from "vscode";
import type { ConnectionState } from "./gateway-client";
import { t } from "./i18n";

export class ClawDriveStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = "clawdrive.dashboard";
    this.item.show();
    this.update("disconnected", false, "Disabled");
  }

  update(state: ConnectionState, callable: boolean, providerLabel: string): void {
    if (state === "connected") {
      this.item.text = callable ? "$(plug) ClawDrive" : "$(warning) ClawDrive";
    } else if (state === "connecting") {
      this.item.text = "$(sync~spin) ClawDrive";
    } else {
      this.item.text = "$(debug-disconnect) ClawDrive";
    }

    const stateText =
      state === "connected"
        ? t("status.connected")
        : state === "connecting"
          ? t("status.connecting")
          : t("status.disconnected");

    this.item.tooltip = [
      t("statusBar.connection", stateText),
      t("statusBar.callable", callable ? t("status.yes") : t("status.no")),
      t("statusBar.provider", providerLabel),
    ].join("\n");
  }

  dispose(): void {
    this.item.dispose();
  }
}
