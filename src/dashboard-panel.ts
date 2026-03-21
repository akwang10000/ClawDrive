import * as vscode from "vscode";
import { getCurrentLocale, t } from "./i18n";

export interface DashboardSnapshot {
  locale: string;
  connectionState: string;
  displayName: string;
  gatewayUrl: string;
  connected: boolean;
  callable: boolean;
  providerStatus: string;
  commands: string[];
}

type DashboardHandlers = {
  getSnapshot: () => DashboardSnapshot;
  onConnect: () => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onDiagnose: () => Promise<void>;
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
    @media (max-width: 860px) {
      .hero { flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
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
        "zh-CN": "\\u53ea\\u4fdd\\u7559\\u5fc5\\u8981\\u6d41\\u7a0b\\uff1a\\u5148\\u770b\\u72b6\\u6001\\uff0c\\u9700\\u8981\\u65f6\\u6253\\u5f00\\u8bbe\\u7f6e\\uff0c\\u4fee\\u6539\\u540e\\u76f4\\u63a5\\u70b9\\u201c\\u4fdd\\u5b58\\u5e76\\u8fde\\u63a5\\u201d\\u3002",
        "en": "Only the essential flow remains: check status, open settings when needed, then save and connect."
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
      commandsTitle: { "zh-CN": "\\u5f53\\u524d\\u547d\\u4ee4\\u9762", "en": "Current Command Surface" },
      commandsEmpty: { "zh-CN": "\\u5f53\\u524d\\u6ca1\\u6709\\u5e7f\\u544a\\u4efb\\u4f55\\u547d\\u4ee4", "en": "No commands advertised" },
      pillConnected: { "zh-CN": "Gateway \\u5df2\\u8fde\\u63a5", "en": "Gateway Connected" },
      pillConnecting: { "zh-CN": "Gateway \\u8fde\\u63a5\\u4e2d", "en": "Gateway Connecting" },
      pillDisconnected: { "zh-CN": "Gateway \\u672a\\u8fde\\u63a5", "en": "Gateway Disconnected" },
      valueConnected: { "zh-CN": "\\u5df2\\u8fde\\u63a5", "en": "Connected" },
      valueDisconnected: { "zh-CN": "\\u672a\\u8fde\\u63a5", "en": "Disconnected" },
      valueReady: { "zh-CN": "\\u5c31\\u7eea", "en": "Ready" },
      valueBlocked: { "zh-CN": "\\u53d7\\u9650", "en": "Blocked" },
      valueNotReady: { "zh-CN": "\\u672a\\u63a5\\u5165", "en": "Not Ready" },
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
    function renderSnapshot(snapshot) {
      const pill = document.getElementById("connectionPill");
      const connectButton = document.getElementById("connect");
      if (snapshot.connectionState === "connected") {
        pill.textContent = tr("pillConnected");
        pill.className = "pill ok";
        connectButton.textContent = tr("reconnect");
      } else if (snapshot.connectionState === "connecting") {
        pill.textContent = tr("pillConnecting");
        pill.className = "pill warn";
        connectButton.textContent = tr("reconnect");
      } else {
        pill.textContent = tr("pillDisconnected");
        pill.className = "pill";
        connectButton.textContent = tr("connect");
      }
      setStatus("connectedValue", snapshot.connected ? tr("valueConnected") : tr("valueDisconnected"), snapshot.connected ? "ok" : "warn");
      setStatus("callableValue", snapshot.callable ? tr("valueReady") : tr("valueBlocked"), snapshot.callable ? "ok" : "warn");
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
      applyCopy();
    }
    document.getElementById("connect").addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("diagnose").addEventListener("click", () => vscode.postMessage({ type: "diagnose" }));
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
