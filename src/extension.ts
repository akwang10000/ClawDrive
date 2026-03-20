import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { getConfig } from "./config";
import { dispatchCommand, getRegisteredCommands } from "./commands/registry";
import { runConnectionDiagnosis, isCallableWithLocalConfig } from "./diagnostics";
import { showDashboardPanel } from "./dashboard-panel";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import { getOutputChannel, log } from "./logger";
import { showSettingsPanel } from "./settings-panel";
import { ClawDriveStatusBar } from "./status-bar";

class ClawDriveRuntime {
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: ClawDriveStatusBar;
  private client: GatewayClient | null = null;
  private connectionState: ConnectionState = "disconnected";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.statusBar = new ClawDriveStatusBar();
    this.statusBar.update(this.connectionState, isCallableWithLocalConfig());
  }

  dispose(): void {
    this.client?.stop();
    this.statusBar.dispose();
  }

  connect(): void {
    const cfg = getConfig();
    this.client?.stop();
    this.client = new GatewayClient({
      host: cfg.gatewayHost,
      port: cfg.gatewayPort,
      tls: cfg.gatewayTls,
      token: cfg.gatewayToken,
      displayName: cfg.displayName,
      commands: getRegisteredCommands(),
      caps: ["node.invoke"],
      clientVersion: String(this.context.extension.packageJSON.version ?? "0.1.0"),
      deviceIdentityPath: path.join(this.context.globalStorageUri.fsPath, "device.json"),
      legacyDeviceIdentityPaths: [path.join(os.homedir(), ".openclaw-vscode", "device.json")],
      onInvoke: dispatchCommand,
      onStateChange: (state) => {
        this.connectionState = state;
        this.statusBar.update(state, isCallableWithLocalConfig());
      },
    });
    log(`Starting Gateway client for ${cfg.gatewayHost}:${cfg.gatewayPort}`);
    this.client.start();
  }

  disconnect(): void {
    this.client?.stop();
    this.client = null;
    this.connectionState = "disconnected";
    this.statusBar.update(this.connectionState, isCallableWithLocalConfig());
    log("Gateway client stopped");
  }

  async showStatus(): Promise<void> {
    const cfg = getConfig();
    const message = [
      `Display name: ${cfg.displayName}`,
      `Gateway: ${cfg.gatewayTls ? "wss" : "ws"}://${cfg.gatewayHost}:${cfg.gatewayPort}`,
      `Connected: ${this.connectionState === "connected" ? "yes" : "no"}`,
      `Callable: ${isCallableWithLocalConfig() ? "yes" : "blocked or uncertain"}`,
      "Provider ready: not configured in Phase 1",
      `Commands: ${getRegisteredCommands().join(", ") || "(none)"}`,
    ].join("\n");

    log("Showing ClawDrive status");
    getOutputChannel().show(true);
    getOutputChannel().appendLine("");
    getOutputChannel().appendLine(message);
    await vscode.window.showInformationMessage("ClawDrive status written to the output channel.");
  }

  async diagnose(): Promise<void> {
    await runConnectionDiagnosis(this.connectionState);
  }

  openLog(): void {
    getOutputChannel().show(true);
  }

  getDashboardSnapshot() {
    const cfg = getConfig();
    return {
      displayName: cfg.displayName,
      gatewayUrl: `${cfg.gatewayTls ? "wss" : "ws"}://${cfg.gatewayHost}:${cfg.gatewayPort}`,
      connected: this.connectionState === "connected",
      callable: isCallableWithLocalConfig(),
      providerReady: false,
      commands: getRegisteredCommands(),
    };
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new ClawDriveRuntime(context);
  log("Activating ClawDrive for VS Code");

  context.subscriptions.push(
    getOutputChannel(),
    vscode.commands.registerCommand("clawdrive.dashboard", () => {
      showDashboardPanel({
        getSnapshot: () => runtime.getDashboardSnapshot(),
        onConnect: async () => {
          runtime.connect();
        },
        onDisconnect: async () => {
          runtime.disconnect();
        },
        onOpenSettings: async () => {
          showSettingsPanel({
            onSaveAndConnect: async () => {
              runtime.connect();
            },
            onDiagnose: async () => {
              await runtime.diagnose();
            },
          });
        },
        onDiagnose: async () => {
          await runtime.diagnose();
        },
        onShowStatus: async () => {
          await runtime.showStatus();
        },
        onOpenLog: async () => {
          runtime.openLog();
        },
      });
    }),
    vscode.commands.registerCommand("clawdrive.connect", () => runtime.connect()),
    vscode.commands.registerCommand("clawdrive.disconnect", () => runtime.disconnect()),
    vscode.commands.registerCommand("clawdrive.showStatus", () => runtime.showStatus()),
    vscode.commands.registerCommand("clawdrive.diagnoseConnection", () => runtime.diagnose()),
    vscode.commands.registerCommand("clawdrive.settings", () => {
      showSettingsPanel({
        onSaveAndConnect: async () => {
          runtime.connect();
        },
        onDiagnose: async () => {
          await runtime.diagnose();
        },
      });
    }),
    { dispose: () => runtime.dispose() }
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}
