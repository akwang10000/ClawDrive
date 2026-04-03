import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { ClawDriveActivityProvider } from "./activity-view";
import { getConfig } from "./config";
import { dispatchCommand, getRegisteredCommands, initializeCommandRegistry } from "./commands/registry";
import { buildDashboardTaskSnapshot } from "./dashboard-tasks";
import { collectOperatorStatus, runConnectionDiagnosis, isCallableWithLocalConfig } from "./diagnostics";
import { refreshDashboardPanel, showDashboardPanel } from "./dashboard-panel";
import { GatewayClient, type ConnectionState } from "./gateway-client";
import { getCurrentLocale, t } from "./i18n";
import { getOutputChannel, log, logError } from "./logger";
import { getProviderStatusLabel } from "./provider-status";
import { AgentRouteService } from "./routing/service";
import { showSettingsPanel } from "./settings-panel";
import { ClawDriveStatusBar } from "./status-bar";
import { runSelftest } from "./selftest-runner";
import { TaskService } from "./tasks/service";

class ClawDriveRuntime {
  private readonly context: vscode.ExtensionContext;
  private readonly statusBar: ClawDriveStatusBar;
  private readonly taskService: TaskService;
  private readonly activityProvider: ClawDriveActivityProvider;
  private readonly routeService: AgentRouteService;
  private client: GatewayClient | null = null;
  private connectionState: ConnectionState = "disconnected";

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.taskService = new TaskService(context);
    this.activityProvider = new ClawDriveActivityProvider(this.taskService);
    this.statusBar = new ClawDriveStatusBar();
    this.routeService = new AgentRouteService({
      taskService: this.taskService,
      getConnectionState: () => this.connectionState,
      getProviderStatus: () => this.taskService.getProviderStatus(),
    });
    initializeCommandRegistry({
      taskService: this.taskService,
      routeHandler: (params) => this.routeService.route(params),
    });
    this.statusBar.update(this.connectionState, isCallableWithLocalConfig(), this.providerStatusLabel());
    this.taskService.onDidChange(() => {
      this.statusBar.update(this.connectionState, isCallableWithLocalConfig(), this.providerStatusLabel());
      this.activityProvider.refresh();
      refreshDashboardPanel();
    });
    this.taskService.onDidEmitLifecycle((event) => {
      this.client?.emitTaskLifecycle(event);
    });
  }

  async initialize(): Promise<void> {
    await this.taskService.initialize({ probeProvider: false });
    void this.taskService.refreshProviderStatus().catch((error) => {
      logError(`Provider probe during startup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (getConfig().autoConnect) {
      this.connect();
    }
  }

  dispose(): void {
    this.client?.stop();
    this.taskService.dispose();
    this.activityProvider.dispose();
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
        this.statusBar.update(state, isCallableWithLocalConfig(), this.providerStatusLabel());
        refreshDashboardPanel();
      },
    });
    log(t("log.startClient", cfg.gatewayHost, cfg.gatewayPort));
    this.client.start();
  }

  disconnect(): void {
    this.client?.stop();
    this.client = null;
    this.connectionState = "disconnected";
    this.statusBar.update(this.connectionState, isCallableWithLocalConfig(), this.providerStatusLabel());
    refreshDashboardPanel();
    log(t("log.stopClient"));
  }

  async showStatus(): Promise<void> {
    const cfg = getConfig();
    const latestTask =
      this.taskService.getLatestTask(["waiting_approval", "waiting_decision", "running", "queued", "interrupted"]) ??
      this.taskService.getLatestTask(["failed"]);
    const status = await collectOperatorStatus(this.connectionState, this.taskService.getProviderStatus(), latestTask);
    const message = [
      t("showStatus.displayName", cfg.displayName),
      t("showStatus.gateway", status.gatewayUrl),
      t("showStatus.connected", status.connected ? t("status.yes") : t("status.no")),
      t("showStatus.callable", status.callable ? t("status.ready") : t("status.blocked")),
      t("showStatus.provider", status.providerStatus.label),
      t("showStatus.commands", getRegisteredCommands().join(", ") || "(none)"),
    ].join("\n");

    log(t("log.showStatus"));
    getOutputChannel().show(true);
    getOutputChannel().appendLine("");
    getOutputChannel().appendLine(message);
    await vscode.window.showInformationMessage(t("notify.statusWritten"));
  }

  async diagnose(): Promise<void> {
    await this.taskService.refreshProviderStatus();
    const latestTask =
      this.taskService.getLatestTask(["waiting_approval", "waiting_decision", "running", "queued", "interrupted"]) ??
      this.taskService.getLatestTask(["failed"]);
    await runConnectionDiagnosis(this.connectionState, this.taskService.getProviderStatus(), latestTask);
  }

  openLog(): void {
    getOutputChannel().show(true);
  }

  getActivityProvider(): ClawDriveActivityProvider {
    return this.activityProvider;
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  async refreshProviderStatus(): Promise<void> {
    await this.taskService.refreshProviderStatus();
    this.statusBar.update(this.connectionState, isCallableWithLocalConfig(), this.providerStatusLabel());
    refreshDashboardPanel();
  }

  async continueTask(taskId: string): Promise<void> {
    await this.activityProvider.continueTask(taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.taskService.cancelTask(taskId);
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.taskService.deleteTask(taskId);
  }

  async approveTask(taskId: string): Promise<void> {
    await this.activityProvider.approveTask(taskId);
  }

  async rejectTask(taskId: string): Promise<void> {
    await this.activityProvider.rejectTask(taskId);
  }

  async openTaskResult(taskId: string): Promise<void> {
    await this.activityProvider.openResult(taskId);
  }

  async selftest(): Promise<void> {
    await runSelftest(this.routeService, this.taskService);
  }

  getDashboardSnapshot() {
    const cfg = getConfig();
    const taskSnapshot = buildDashboardTaskSnapshot(this.taskService.listAllTasks(), 20);
    return {
      locale: getCurrentLocale(),
      connectionState: this.connectionState,
      displayName: cfg.displayName,
      gatewayUrl: `${cfg.gatewayTls ? "wss" : "ws"}://${cfg.gatewayHost}:${cfg.gatewayPort}`,
      connected: this.connectionState === "connected",
      callable: isCallableWithLocalConfig(),
      providerStatus: this.providerStatusLabel(),
      commands: getRegisteredCommands(),
      taskCounts: taskSnapshot.taskCounts,
      tasks: taskSnapshot.tasks,
    };
  }

  private providerStatusLabel(): string {
    return getProviderStatusLabel(this.taskService.getProviderStatus());
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const runtime = new ClawDriveRuntime(context);
  await runtime.initialize();
  log(t("log.activating"));

  context.subscriptions.push(
    getOutputChannel(),
    vscode.window.registerTreeDataProvider("clawdrive.activity", runtime.getActivityProvider()),
    vscode.commands.registerCommand("clawdrive.dashboard", () => {
      showDashboardPanel({
        getSnapshot: () => runtime.getDashboardSnapshot(),
        onConnect: async () => {
          runtime.connect();
        },
        onOpenSettings: async () => {
          showSettingsPanel({
            onSaveAndConnect: async () => {
              await runtime.refreshProviderStatus();
              runtime.connect();
            },
          });
        },
        onDiagnose: async () => {
          await runtime.diagnose();
        },
        onCancelTask: async (taskId: string) => {
          await runtime.cancelTask(taskId);
        },
        onDeleteTask: async (taskId: string) => {
          await runtime.deleteTask(taskId);
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
          await runtime.refreshProviderStatus();
          runtime.connect();
        },
      });
    }),
    vscode.commands.registerCommand("clawdrive.selftest", () => runtime.selftest()),
    vscode.commands.registerCommand("clawdrive.activity.refresh", () => runtime.getActivityProvider().refresh()),
    vscode.commands.registerCommand("clawdrive.activity.openResult", (taskId: string) => runtime.openTaskResult(taskId)),
    vscode.commands.registerCommand("clawdrive.activity.continue", (taskId: string) => runtime.continueTask(taskId)),
    vscode.commands.registerCommand("clawdrive.activity.approve", (taskId: string) => runtime.approveTask(taskId)),
    vscode.commands.registerCommand("clawdrive.activity.reject", (taskId: string) => runtime.rejectTask(taskId)),
    vscode.commands.registerCommand("clawdrive.activity.cancel", (taskId: string) => runtime.cancelTask(taskId)),
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("clawdrive.provider") || event.affectsConfiguration("clawdrive.tasks")) {
        await runtime.refreshProviderStatus();
      }
      if (event.affectsConfiguration("clawdrive.autoConnect")) {
        const cfg = getConfig();
        if (cfg.autoConnect && runtime.getConnectionState() === "disconnected") {
          runtime.connect();
        }
      }
    }),
    { dispose: () => runtime.dispose() }
  );
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered during activation.
}
