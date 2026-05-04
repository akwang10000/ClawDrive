import * as vscode from "vscode";
import { getCurrentLocale, t } from "./i18n";
import type { DashboardTaskBulkActions, DashboardTaskCounts, DashboardTaskItem } from "./dashboard-tasks";
import type { TaskBatchActionResult } from "./tasks/types";

export interface DashboardSnapshot {
  locale: string;
  connectionState: string;
  displayName: string;
  gatewayUrl: string;
  connected: boolean;
  callable: boolean;
  providerStatus: string;
  commands: string[];
  taskCounts: DashboardTaskCounts;
  bulkActions: DashboardTaskBulkActions;
  tasks: DashboardTaskItem[];
}

type DashboardHandlers = {
  getSnapshot: () => DashboardSnapshot;
  onConnect: () => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onDiagnose: () => Promise<void>;
  onCancelTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onCancelActiveTasks: () => Promise<TaskBatchActionResult>;
  onClearFinishedTasks: () => Promise<TaskBatchActionResult>;
};

let panel: vscode.WebviewPanel | null = null;
let activeHandlers: DashboardHandlers | null = null;

export function showDashboardPanel(handlers: DashboardHandlers): void {
  activeHandlers = handlers;
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    void postSnapshot(handlers);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "clawdriveDashboard",
    t("app.dashboard"),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const nonce = createNonce();
  panel.webview.html = getHtml(panel.webview.cspSource, nonce);
  void postSnapshot(handlers);

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const msg = message as { type?: unknown };
    const type = typeof msg.type === "string" ? msg.type : "";

    try {
      if (type === "refresh") {
        await postSnapshot(handlers);
        return;
      }
      if (type === "connect") {
        await handlers.onConnect();
        await postSnapshot(handlers);
        return;
      }
      if (type === "settings") {
        await handlers.onOpenSettings();
        await postSnapshot(handlers);
        return;
      }
      if (type === "diagnose") {
        await handlers.onDiagnose();
        await postSnapshot(handlers);
        return;
      }
      if (type === "cancelTask") {
        const taskId = typeof (message as { taskId?: unknown }).taskId === "string" ? (message as { taskId: string }).taskId.trim() : "";
        if (!taskId) {
          throw new Error("taskId is required.");
        }
        await handlers.onCancelTask(taskId);
        await postSnapshot(handlers);
        return;
      }
      if (type === "deleteTask") {
        const taskId = typeof (message as { taskId?: unknown }).taskId === "string" ? (message as { taskId: string }).taskId.trim() : "";
        if (!taskId) {
          throw new Error("taskId is required.");
        }
        const { message: confirmMessage, actionLabel } = getDeleteTaskConfirmation(handlers.getSnapshot().locale);
        const confirmed = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, actionLabel);
        if (confirmed !== actionLabel) {
          return;
        }
        await handlers.onDeleteTask(taskId);
        await postSnapshot(handlers);
        return;
      }
      if (type === "cancelActiveTasks") {
        const count = handlers.getSnapshot().bulkActions.cancellable;
        if (count <= 0) {
          return;
        }
        const { message: confirmMessage, actionLabel } = getCancelActiveTasksConfirmation(handlers.getSnapshot().locale, count);
        const confirmed = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, actionLabel);
        if (confirmed !== actionLabel) {
          return;
        }
        await handlers.onCancelActiveTasks();
        await postSnapshot(handlers);
        return;
      }
      if (type === "clearFinishedTasks") {
        const count = handlers.getSnapshot().bulkActions.deletable;
        if (count <= 0) {
          return;
        }
        const { message: confirmMessage, actionLabel } = getClearFinishedTasksConfirmation(handlers.getSnapshot().locale, count);
        const confirmed = await vscode.window.showWarningMessage(confirmMessage, { modal: true }, actionLabel);
        if (confirmed !== actionLabel) {
          return;
        }
        await handlers.onClearFinishedTasks();
        await postSnapshot(handlers);
        return;
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      void panel?.webview.postMessage({ type: "error", error: messageText });
      void vscode.window.showErrorMessage(messageText);
    }
  });

  panel.onDidDispose(() => {
    panel = null;
    activeHandlers = null;
  });
}

export function refreshDashboardPanel(): void {
  if (!panel || !activeHandlers) {
    return;
  }
  void postSnapshot(activeHandlers);
}

async function postSnapshot(handlers: DashboardHandlers): Promise<void> {
  await panel?.webview.postMessage({
    type: "snapshot",
    snapshot: handlers.getSnapshot(),
  });
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 24; index += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}

function getDeleteTaskConfirmation(locale: string): { message: string; actionLabel: string } {
  if (locale === "en") {
    return {
      message: "Delete this task from local history? This cannot be undone.",
      actionLabel: "Delete",
    };
  }
  return {
    message: "确定从本地任务历史中删除这个任务？此操作不可撤销。",
    actionLabel: "删除",
  };
}

function getCancelActiveTasksConfirmation(locale: string, count: number): { message: string; actionLabel: string } {
  if (locale === "en") {
    return {
      message: `Cancel ${count} active or resumable task${count === 1 ? "" : "s"}?`,
      actionLabel: "Cancel Tasks",
    };
  }
  return {
    message: `确定取消 ${count} 个活跃或可恢复任务？`,
    actionLabel: "批量取消",
  };
}

function getClearFinishedTasksConfirmation(locale: string, count: number): { message: string; actionLabel: string } {
  if (locale === "en") {
    return {
      message: `Delete ${count} finished task histor${count === 1 ? "y" : "ies"}? This cannot be undone.`,
      actionLabel: "Clear Finished",
    };
  }
  return {
    message: `确定删除 ${count} 条终态任务历史？此操作不可撤销。`,
    actionLabel: "清理终态",
  };
}

function getHtml(cspSource: string, nonce: string): string {
  const initialLocale = JSON.stringify(getCurrentLocale());

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawDrive Dashboard</title>
  <style>
    :root {
      color-scheme: light dark;
      --hero-bg: linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-button-background) 16%), color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-sideBar-background) 6%));
      --card-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
      --line: color-mix(in srgb, var(--vscode-widget-border, #444) 60%, transparent);
      --ok-bg: color-mix(in srgb, #3fb950 14%, transparent);
      --warn-bg: color-mix(in srgb, #d29922 16%, transparent);
      --danger-bg: color-mix(in srgb, #f14c4c 14%, transparent);
      --muted-bg: color-mix(in srgb, var(--vscode-descriptionForeground) 10%, transparent);
    }
    body {
      margin: 0;
      padding: 24px 20px 32px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
    .wrap {
      max-width: 960px;
      margin: 0 auto;
      display: grid;
      gap: 16px;
    }
    .hero, .card {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: var(--card-bg);
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      background: var(--hero-bg);
      padding: 22px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      max-width: 640px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 8px 12px;
      font-size: 12px;
      font-weight: 600;
      background: var(--muted-bg);
    }
    .pill.ok { background: var(--ok-bg); }
    .pill.warn { background: var(--warn-bg); }
    .layout {
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 16px;
    }
    .card {
      padding: 18px;
    }
    .title {
      margin: 0 0 14px;
      font-size: 16px;
      font-weight: 600;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-sideBar-background) 16%);
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .value {
      font-size: 18px;
      font-weight: 600;
    }
    .ok { color: #4caf50; }
    .warn { color: #d9a400; }
    .danger { color: var(--vscode-errorForeground, #f14c4c); }
    .muted { color: var(--vscode-descriptionForeground); }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }
    .row:last-child { border-bottom: none; }
    .key { color: var(--vscode-descriptionForeground); }
    .actions {
      display: grid;
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 11px 14px;
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .hint {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      font-size: 13px;
    }
    .cmds {
      margin: 0;
      padding-left: 18px;
      line-height: 1.8;
    }
    .error {
      display: none;
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      border-radius: 10px;
      padding: 10px 12px;
      color: var(--vscode-errorForeground, #f14c4c);
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      margin-bottom: 14px;
    }
    .task-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      min-width: 280px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 10px 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 86%, var(--vscode-sideBar-background) 14%);
    }
    .metric-label {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .metric-value {
      margin-top: 6px;
      font-size: 18px;
      font-weight: 700;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      background: var(--muted-bg);
    }
    .task-list {
      display: grid;
      gap: 10px;
    }
    .task-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-sideBar-background) 12%);
    }
    .task-main {
      min-width: 0;
    }
    .task-top {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 8px;
    }
    .task-title {
      font-size: 14px;
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 9px;
      font-size: 11px;
      font-weight: 600;
      background: var(--muted-bg);
    }
    .badge.ok {
      color: inherit;
      background: var(--ok-bg);
    }
    .badge.warn {
      color: inherit;
      background: var(--warn-bg);
    }
    .badge.danger {
      color: inherit;
      background: var(--danger-bg);
    }
    .task-summary {
      line-height: 1.5;
      margin-bottom: 8px;
      word-break: break-word;
    }
    .task-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }
    .task-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      align-self: start;
    }
    .task-bulk-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .task-bulk-action {
      padding: 8px 12px;
      border-radius: 8px;
    }
    .task-bulk-action.delete {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 74%, var(--vscode-errorForeground, #f14c4c) 26%);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .task-action {
      padding: 8px 12px;
      border-radius: 8px;
      text-align: center;
    }
    .task-action.delete {
      background: color-mix(in srgb, var(--vscode-button-secondaryBackground) 74%, var(--vscode-errorForeground, #f14c4c) 26%);
    }
    @media (max-width: 860px) {
      .hero { flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
      .section-head {
        flex-direction: column;
      }
      .task-metrics {
        grid-template-columns: 1fr;
        min-width: 0;
        width: 100%;
      }
      .task-item {
        grid-template-columns: 1fr;
      }
      .task-actions {
        justify-content: flex-start;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1 id="title"></h1>
        <div class="sub" id="subtitle"></div>
      </div>
      <div id="connectionPill" class="pill"></div>
    </div>
    <div id="error" class="error"></div>
    <div class="layout">
      <div class="card">
        <div class="title" id="overviewTitle"></div>
        <div class="stats">
          <div class="stat">
            <div class="label" id="connectionLabel"></div>
            <div class="value" id="connectedValue">-</div>
          </div>
          <div class="stat">
            <div class="label" id="callableLabel"></div>
            <div class="value" id="callableValue">-</div>
          </div>
          <div class="stat">
            <div class="label" id="providerLabel"></div>
            <div class="value" id="providerValue">-</div>
          </div>
        </div>
        <div class="row"><div class="key" id="displayNameKey"></div><div id="displayName">-</div></div>
        <div class="row"><div class="key" id="gatewayKey"></div><div id="gatewayUrl">-</div></div>
        <div class="row"><div class="key" id="commandCountKey"></div><div id="commandCount">-</div></div>
      </div>
      <div class="card">
        <div class="title" id="actionsTitle"></div>
        <div class="actions">
          <button class="primary" id="connect"></button>
          <button class="secondary" id="settings"></button>
          <button class="secondary" id="diagnose"></button>
        </div>
        <p class="hint" id="actionsHint"></p>
      </div>
    </div>
    <div class="card">
      <div class="section-head">
        <div>
          <div class="title" id="tasksTitle"></div>
          <div class="hint" id="tasksHint"></div>
          <div class="task-bulk-actions">
            <button class="secondary task-bulk-action" id="cancelActiveTasks"></button>
            <button class="secondary task-bulk-action delete" id="clearFinishedTasks"></button>
          </div>
        </div>
        <div class="task-metrics">
          <div class="metric">
            <div class="metric-label" id="taskTotalLabel"></div>
            <div class="metric-value" id="taskTotalValue">0</div>
          </div>
          <div class="metric">
            <div class="metric-label" id="taskActiveLabel"></div>
            <div class="metric-value" id="taskActiveValue">0</div>
          </div>
          <div class="metric">
            <div class="metric-label" id="taskTerminalLabel"></div>
            <div class="metric-value" id="taskTerminalValue">0</div>
          </div>
        </div>
      </div>
      <div id="taskCounts" class="chips"></div>
      <div id="taskList" class="task-list"></div>
    </div>
    <div class="card">
      <div class="title" id="commandsTitle"></div>
      <ul id="commands" class="cmds"></ul>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = Object.assign({ locale: ${initialLocale} }, vscode.getState() || {});
    const copy = {
      title: { "zh-CN": "\\u63a7\\u5236\\u53f0", "en": "Dashboard" },
      subtitle: {
        "zh-CN": "\\u5728\\u4e00\\u4e2a\\u63a7\\u5236\\u53f0\\u91cc\\u67e5\\u770b\\u8fde\\u63a5\\u72b6\\u6001\\u3001\\u89c2\\u5bdf\\u6700\\u8fd1\\u4efb\\u52a1\\uff0c\\u5e76\\u5904\\u7406\\u5e38\\u89c1\\u6062\\u590d\\u64cd\\u4f5c\\u3002",
        "en": "See connection status, watch recent tasks, and handle the most common recovery actions from one place."
      },
      overviewTitle: { "zh-CN": "\\u5f53\\u524d\\u72b6\\u6001", "en": "Current State" },
      connectionLabel: { "zh-CN": "\\u8fde\\u63a5", "en": "Connection" },
      callableLabel: { "zh-CN": "\\u53ef\\u8c03\\u7528", "en": "Callable" },
      providerLabel: { "zh-CN": "Provider", "en": "Provider" },
      displayNameKey: { "zh-CN": "\\u663e\\u793a\\u540d\\u79f0", "en": "Display Name" },
      gatewayKey: { "zh-CN": "Gateway", "en": "Gateway" },
      commandCountKey: { "zh-CN": "\\u547d\\u4ee4\\u6570\\u91cf", "en": "Command Count" },
      actionsTitle: { "zh-CN": "\\u5feb\\u901f\\u64cd\\u4f5c", "en": "Quick Actions" },
      actionsHint: {
        "zh-CN": "\\u9ad8\\u7ea7\\u64cd\\u4f5c\\uff08\\u65ad\\u5f00\\u8fde\\u63a5\\u3001\\u65e5\\u5fd7\\u3001\\u8be6\\u7ec6\\u72b6\\u6001\\uff09\\u4ecd\\u53ef\\u4ee5\\u4ece\\u547d\\u4ee4\\u9762\\u677f\\u8fdb\\u5165\\uff0c\\u4e0d\\u653e\\u5728\\u4e3b\\u754c\\u9762\\u3002",
        "en": "Advanced actions such as disconnect, logs, and detailed status remain available from the command palette."
      },
      connect: { "zh-CN": "\\u8fde\\u63a5 Gateway", "en": "Connect" },
      reconnect: { "zh-CN": "\\u91cd\\u65b0\\u8fde\\u63a5", "en": "Reconnect" },
      settings: { "zh-CN": "\\u6253\\u5f00\\u8bbe\\u7f6e", "en": "Open Settings" },
      diagnose: { "zh-CN": "\\u8fd0\\u884c\\u8bca\\u65ad", "en": "Run Diagnosis" },
      tasksTitle: { "zh-CN": "\\u6700\\u8fd1\\u4efb\\u52a1", "en": "Recent Tasks" },
      tasksHint: {
        "zh-CN": "\\u663e\\u793a\\u6700\\u8fd1 20 \\u6761\\u5df2\\u8ddf\\u8e2a\\u4efb\\u52a1\\uff0c\\u6d3b\\u8dc3\\u4efb\\u52a1\\u4f1a\\u6392\\u5728\\u524d\\u9762\\u3002",
        "en": "Showing the latest 20 tracked tasks. Active and resumable tasks stay on top."
      },
      taskTotalLabel: { "zh-CN": "\\u603b\\u6570", "en": "Total" },
      taskActiveLabel: { "zh-CN": "\\u6d3b\\u8dc3", "en": "Active" },
      taskTerminalLabel: { "zh-CN": "\\u7ec8\\u6001", "en": "Terminal" },
      noTasks: { "zh-CN": "\\u5f53\\u524d\\u8fd8\\u6ca1\\u6709\\u5df2\\u8ddf\\u8e2a\\u7684\\u4efb\\u52a1", "en": "No tracked tasks yet." },
      lastUpdated: { "zh-CN": "\\u6700\\u540e\\u66f4\\u65b0", "en": "Last updated" },
      cancelTask: { "zh-CN": "\\u53d6\\u6d88", "en": "Cancel" },
      deleteTask: { "zh-CN": "\\u5220\\u9664", "en": "Delete" },
      cancelActiveTasks: { "zh-CN": "批量取消", "en": "Cancel Active" },
      clearFinishedTasks: { "zh-CN": "清理终态", "en": "Clear Finished" },
      confirmDelete: {
        "zh-CN": "\\u786e\\u5b9a\\u4ece\\u672c\\u5730\\u4efb\\u52a1\\u5386\\u53f2\\u4e2d\\u5220\\u9664\\u8fd9\\u4e2a\\u4efb\\u52a1\\uff1f\\u6b64\\u64cd\\u4f5c\\u4e0d\\u53ef\\u64a4\\u9500\\u3002",
        "en": "Delete this task from local history? This cannot be undone."
      },
      commandsTitle: { "zh-CN": "\\u5f53\\u524d\\u547d\\u4ee4\\u9762", "en": "Current Command Surface" },
      commandsEmpty: { "zh-CN": "\\u5f53\\u524d\\u6ca1\\u6709\\u5e7f\\u544a\\u4efb\\u4f55\\u547d\\u4ee4", "en": "No commands advertised" },
      pillConnected: { "zh-CN": "Gateway \\u5df2\\u8fde\\u63a5", "en": "Gateway Connected" },
      pillConnecting: { "zh-CN": "Gateway \\u8fde\\u63a5\\u4e2d", "en": "Gateway Connecting" },
      pillDisconnected: { "zh-CN": "Gateway \\u672a\\u8fde\\u63a5", "en": "Gateway Disconnected" },
      valueConnected: { "zh-CN": "\\u5df2\\u8fde\\u63a5", "en": "Connected" },
      valueConnecting: { "zh-CN": "\\u8fde\\u63a5\\u4e2d", "en": "Connecting" },
      valueDisconnected: { "zh-CN": "\\u672a\\u8fde\\u63a5", "en": "Disconnected" },
      valueReady: { "zh-CN": "\\u5c31\\u7eea", "en": "Ready" },
      valueBlocked: { "zh-CN": "\\u53d7\\u9650", "en": "Blocked" },
      valueNotReady: { "zh-CN": "\\u672a\\u63a5\\u5165", "en": "Not Ready" },
      valuePending: { "zh-CN": "\\u5f85\\u786e\\u8ba4", "en": "Pending" },
      unknownError: { "zh-CN": "\\u672a\\u77e5\\u9519\\u8bef", "en": "Unknown error" }
    };
    function tr(key) {
      const entry = copy[key];
      return entry ? (entry[state.locale] || entry["zh-CN"] || entry["en"] || key) : key;
    }
    function applyCopy() {
      Object.keys(copy).forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = tr(id);
        }
      });
      document.documentElement.lang = state.locale === "en" ? "en" : "zh-CN";
      vscode.setState(state);
    }
    function showError(message) {
      const box = document.getElementById("error");
      box.textContent = message || "";
      box.style.display = message ? "block" : "none";
    }
    function setStatus(id, value, cssClass) {
      const el = document.getElementById(id);
      el.textContent = value;
      el.className = "value " + cssClass;
    }
    function formatTimestamp(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value || "-";
      }
      return date.toLocaleString(state.locale === "en" ? "en" : "zh-CN", { hour12: false });
    }
    function healthClass(health) {
      if (health === "failed") {
        return "danger";
      }
      if (health === "degraded" || health === "warning") {
        return "warn";
      }
      return "ok";
    }
    function renderTaskCounts(taskCounts) {
      document.getElementById("taskTotalValue").textContent = String(taskCounts.total || 0);
      document.getElementById("taskActiveValue").textContent = String(taskCounts.active || 0);
      document.getElementById("taskTerminalValue").textContent = String(taskCounts.terminal || 0);
      const counts = document.getElementById("taskCounts");
      counts.innerHTML = "";
      (taskCounts.byState || []).filter((entry) => entry.count > 0).forEach((entry) => {
        const chip = document.createElement("div");
        chip.className = "chip";
        chip.textContent = entry.label + ": " + entry.count;
        counts.appendChild(chip);
      });
    }
    function renderTasks(tasks) {
      const list = document.getElementById("taskList");
      list.innerHTML = "";
      if (!tasks || !tasks.length) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = tr("noTasks");
        list.appendChild(empty);
        return;
      }
      tasks.forEach((task) => {
        const item = document.createElement("div");
        item.className = "task-item";

        const main = document.createElement("div");
        main.className = "task-main";

        const top = document.createElement("div");
        top.className = "task-top";

        const title = document.createElement("div");
        title.className = "task-title";
        title.textContent = task.title;
        top.appendChild(title);

        const stateBadge = document.createElement("span");
        stateBadge.className = "badge";
        stateBadge.textContent = task.stateLabel;
        top.appendChild(stateBadge);

        if (task.executionHealth !== "clean") {
          const healthBadge = document.createElement("span");
          healthBadge.className = "badge " + healthClass(task.executionHealth);
          healthBadge.textContent = task.executionHealthLabel;
          top.appendChild(healthBadge);
        }

        const summary = document.createElement("div");
        summary.className = "task-summary";
        summary.textContent = task.summary;

        const meta = document.createElement("div");
        meta.className = "task-meta";
        meta.textContent = tr("lastUpdated") + ": " + formatTimestamp(task.updatedAt);

        main.appendChild(top);
        main.appendChild(summary);
        main.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "task-actions";

        if (task.canCancel) {
          const cancel = document.createElement("button");
          cancel.className = "secondary task-action";
          cancel.textContent = tr("cancelTask");
          cancel.dataset.action = "cancel";
          cancel.dataset.taskId = task.taskId;
          cancel.dataset.taskTitle = task.title;
          actions.appendChild(cancel);
        }

        if (task.canDelete) {
          const remove = document.createElement("button");
          remove.className = "secondary task-action delete";
          remove.textContent = tr("deleteTask");
          remove.dataset.action = "delete";
          remove.dataset.taskId = task.taskId;
          remove.dataset.taskTitle = task.title;
          actions.appendChild(remove);
        }

        item.appendChild(main);
        item.appendChild(actions);
        list.appendChild(item);
      });
    }
    function renderSnapshot(snapshot) {
      if (snapshot.locale) {
        state.locale = snapshot.locale;
      }
      const pill = document.getElementById("connectionPill");
      const connectButton = document.getElementById("connect");
      let connectionValue = tr("valueDisconnected");
      let connectionClass = "warn";
      if (snapshot.connectionState === "connected") {
        pill.textContent = tr("pillConnected");
        pill.className = "pill ok";
        connectButton.textContent = tr("reconnect");
        connectionValue = tr("valueConnected");
        connectionClass = "ok";
      } else if (snapshot.connectionState === "connecting") {
        pill.textContent = tr("pillConnecting");
        pill.className = "pill warn";
        connectButton.textContent = tr("reconnect");
        connectionValue = tr("valueConnecting");
        connectionClass = "warn";
      } else {
        pill.textContent = tr("pillDisconnected");
        pill.className = "pill";
        connectButton.textContent = tr("connect");
      }
      setStatus("connectedValue", connectionValue, connectionClass);
      if (snapshot.connectionState === "connected") {
        setStatus("callableValue", snapshot.callable ? tr("valueReady") : tr("valueBlocked"), snapshot.callable ? "ok" : "warn");
      } else {
        setStatus("callableValue", tr("valuePending"), "muted");
      }
      setStatus("providerValue", snapshot.providerStatus || tr("valueNotReady"), "muted");
      document.getElementById("displayName").textContent = snapshot.displayName;
      document.getElementById("gatewayUrl").textContent = snapshot.gatewayUrl;
      document.getElementById("commandCount").textContent = String((snapshot.commands || []).length);
      const list = document.getElementById("commands");
      list.innerHTML = "";
      if (!snapshot.commands || !snapshot.commands.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = tr("commandsEmpty");
        list.appendChild(li);
      } else {
        snapshot.commands.forEach((command) => {
          const li = document.createElement("li");
          li.textContent = command;
          list.appendChild(li);
        });
      }
      renderTaskCounts(snapshot.taskCounts || { total: 0, active: 0, terminal: 0, byState: [] });
      const bulkActions = snapshot.bulkActions || { cancellable: 0, deletable: 0 };
      document.getElementById("cancelActiveTasks").disabled = bulkActions.cancellable <= 0;
      document.getElementById("clearFinishedTasks").disabled = bulkActions.deletable <= 0;
      renderTasks(snapshot.tasks || []);
      applyCopy();
    }
    document.getElementById("connect").addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("diagnose").addEventListener("click", () => vscode.postMessage({ type: "diagnose" }));
    document.getElementById("cancelActiveTasks").addEventListener("click", () => {
      vscode.postMessage({ type: "cancelActiveTasks" });
    });
    document.getElementById("clearFinishedTasks").addEventListener("click", () => {
      vscode.postMessage({ type: "clearFinishedTasks" });
    });
    document.getElementById("taskList").addEventListener("click", (event) => {
      const button = event.target instanceof HTMLElement ? event.target.closest("button[data-action]") : null;
      if (!button) {
        return;
      }
      const taskId = button.dataset.taskId || "";
      if (!taskId) {
        return;
      }
      vscode.postMessage({
        type: button.dataset.action === "delete" ? "deleteTask" : "cancelTask",
        taskId,
      });
    });
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "snapshot") {
        showError("");
        renderSnapshot(msg.snapshot);
      }
      if (msg.type === "error") {
        showError(msg.error || tr("unknownError"));
      }
    });
    applyCopy();
    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}
