import * as vscode from "vscode";
import { getCurrentLocale, t } from "./i18n";

export interface DashboardSnapshot {
  locale: string;
  connectionState: string;
  displayName: string;
  gatewayUrl: string;
  connected: boolean;
  callable: boolean;
  providerReady: boolean;
  commands: string[];
}

type DashboardHandlers = {
  getSnapshot: () => DashboardSnapshot;
  onConnect: () => Promise<void> | void;
  onDisconnect: () => Promise<void> | void;
  onOpenSettings: () => Promise<void> | void;
  onDiagnose: () => Promise<void>;
  onShowStatus: () => Promise<void>;
  onOpenLog: () => Promise<void> | void;
};

let panel: vscode.WebviewPanel | null = null;

export function showDashboardPanel(handlers: DashboardHandlers): void {
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
      if (type === "disconnect") {
        await handlers.onDisconnect();
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
      if (type === "status") {
        await handlers.onShowStatus();
        return;
      }
      if (type === "log") {
        await handlers.onOpenLog();
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
  });
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
      --hero-bg: linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background) 12%), color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-sideBar-background) 4%));
      --card-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
      --line: color-mix(in srgb, var(--vscode-widget-border, #444) 60%, transparent);
      --ok-bg: color-mix(in srgb, #3fb950 14%, transparent);
      --warn-bg: color-mix(in srgb, #d29922 16%, transparent);
      --muted-bg: color-mix(in srgb, var(--vscode-descriptionForeground) 10%, transparent);
    }
    body {
      margin: 0;
      padding: 24px 20px 36px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
    .wrap {
      max-width: 1120px;
      margin: 0 auto;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: var(--hero-bg);
      padding: 22px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 28px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      max-width: 720px;
    }
    .heroSide {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .locale {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px;
      gap: 4px;
      background: var(--card-bg);
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
    .grid {
      display: grid;
      grid-template-columns: 1.25fr 0.95fr;
      gap: 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      background: var(--card-bg);
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background) 18%);
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .value {
      font-size: 20px;
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
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
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
    .locale button {
      border-radius: 999px;
      padding: 6px 12px;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: center;
    }
    .locale button.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .cmds {
      margin: 0;
      padding-left: 18px;
      line-height: 1.8;
    }
    .steps, .notes {
      display: grid;
      gap: 10px;
    }
    .step, .note {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: color-mix(in srgb, var(--card-bg) 90%, var(--vscode-button-background) 10%);
    }
    .step strong, .note strong {
      display: block;
      margin-bottom: 6px;
    }
    .error {
      display: none;
      margin-bottom: 18px;
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      border-radius: 10px;
      padding: 10px 12px;
      color: var(--vscode-errorForeground, #f14c4c);
    }
    @media (max-width: 860px) {
      .hero { flex-direction: column; }
      .heroSide { justify-content: flex-start; }
      .grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr; }
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
      <div class="heroSide">
        <div id="connectionPill" class="pill"></div>
        <div class="locale">
          <button id="localeZh" type="button">中文</button>
          <button id="localeEn" type="button">English</button>
        </div>
      </div>
    </div>
    <div id="error" class="error"></div>
    <div class="grid">
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
          <button class="secondary" id="disconnect"></button>
          <button class="secondary" id="settings"></button>
          <button class="secondary" id="diagnose"></button>
          <button class="secondary" id="status"></button>
          <button class="secondary" id="log"></button>
        </div>
      </div>
      <div class="card">
        <div class="title" id="commandsTitle"></div>
        <ul id="commands" class="cmds"></ul>
      </div>
      <div class="card">
        <div class="title" id="stepsTitle"></div>
        <div class="steps">
          <div class="step"><strong id="step1Title"></strong><div id="step1Body"></div></div>
          <div class="step"><strong id="step2Title"></strong><div id="step2Body"></div></div>
          <div class="step"><strong id="step3Title"></strong><div id="step3Body"></div></div>
        </div>
      </div>
      <div class="card">
        <div class="title" id="notesTitle"></div>
        <div class="notes">
          <div class="note"><strong id="noteScopeKey"></strong><div id="noteScopeValue"></div></div>
          <div class="note"><strong id="noteChangesKey"></strong><div id="noteChangesValue"></div></div>
          <div class="note"><strong id="noteFailureKey"></strong><div id="noteFailureValue"></div></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = Object.assign({ locale: ${initialLocale} }, vscode.getState() || {});
    const copy = {
      title: { "zh-CN": "ClawDrive 控制台", "en": "ClawDrive Dashboard" },
      subtitle: {
        "zh-CN": "把 Phase 1 常用操作集中到一个界面：先看状态，再做连接、设置和诊断，最后验证 OpenClaw 的真实调用。",
        "en": "Bring the common Phase 1 actions into one screen: inspect state first, then connect, configure, diagnose, and finally verify a real OpenClaw invocation."
      },
      overviewTitle: { "zh-CN": "当前状态", "en": "Current State" },
      connectionLabel: { "zh-CN": "连接", "en": "Connection" },
      callableLabel: { "zh-CN": "可调用", "en": "Callable" },
      providerLabel: { "zh-CN": "Provider 状态", "en": "Provider Status" },
      displayNameKey: { "zh-CN": "显示名称", "en": "Display Name" },
      gatewayKey: { "zh-CN": "Gateway", "en": "Gateway" },
      commandCountKey: { "zh-CN": "远程命令数", "en": "Remote Commands" },
      actionsTitle: { "zh-CN": "下一步操作", "en": "Next Actions" },
      connect: { "zh-CN": "连接 Gateway", "en": "Connect" },
      disconnect: { "zh-CN": "断开连接", "en": "Disconnect" },
      settings: { "zh-CN": "打开设置", "en": "Open Settings" },
      diagnose: { "zh-CN": "运行诊断", "en": "Run Diagnosis" },
      status: { "zh-CN": "输出状态", "en": "Show Status" },
      log: { "zh-CN": "打开日志", "en": "Open Log" },
      commandsTitle: { "zh-CN": "当前命令面", "en": "Current Command Surface" },
      commandsEmpty: { "zh-CN": "当前没有广告任何命令", "en": "No commands advertised" },
      stepsTitle: { "zh-CN": "最小联调路径", "en": "Minimal Integration Path" },
      step1Title: { "zh-CN": "1. 配置 Gateway", "en": "1. Configure the Gateway" },
      step1Body: {
        "zh-CN": "先打开设置，确认 host、port、token 与 TLS 是否和当前 Gateway 一致。",
        "en": "Open settings first and confirm host, port, token, and TLS match the current Gateway."
      },
      step2Title: { "zh-CN": "2. 发起连接", "en": "2. Connect" },
      step2Body: {
        "zh-CN": "点击连接后，优先看“连接”和“可调用”两个状态块。",
        "en": "After connecting, check the Connection and Callable state blocks first."
      },
      step3Title: { "zh-CN": "3. 验证真实调用", "en": "3. Verify a Real Invocation" },
      step3Body: {
        "zh-CN": "从 OpenClaw 发起 vscode.workspace.info，并在日志里确认 invoke request / result。",
        "en": "Invoke vscode.workspace.info from OpenClaw and confirm invoke request / result in the log."
      },
      notesTitle: { "zh-CN": "Phase 1 备注", "en": "Phase 1 Notes" },
      noteScopeKey: { "zh-CN": "当前范围", "en": "Current Scope" },
      noteScopeValue: { "zh-CN": "Gateway 接入 + vscode.workspace.info", "en": "Gateway integration + vscode.workspace.info" },
      noteChangesKey: { "zh-CN": "OpenClaw 改动", "en": "OpenClaw Changes" },
      noteChangesValue: { "zh-CN": "不需要修改 OpenClaw 源码", "en": "No OpenClaw source changes required" },
      noteFailureKey: { "zh-CN": "典型故障", "en": "Typical Failure" },
      noteFailureValue: {
        "zh-CN": "allowCommands 未放行 vscode.workspace.info，或设备身份不兼容。",
        "en": "allowCommands does not permit vscode.workspace.info, or the device identity is incompatible."
      },
      pillConnected: { "zh-CN": "Gateway 已连接", "en": "Gateway Connected" },
      pillConnecting: { "zh-CN": "Gateway 连接中", "en": "Gateway Connecting" },
      pillDisconnected: { "zh-CN": "Gateway 未连接", "en": "Gateway Disconnected" },
      valueConnected: { "zh-CN": "已连接", "en": "Connected" },
      valueDisconnected: { "zh-CN": "未连接", "en": "Disconnected" },
      valueReady: { "zh-CN": "就绪", "en": "Ready" },
      valueBlocked: { "zh-CN": "受限", "en": "Blocked" },
      valueNotReady: { "zh-CN": "未接入", "en": "Not Ready" },
      unknownError: { "zh-CN": "未知错误", "en": "Unknown error" }
    };
    function tr(key) {
      const entry = copy[key];
      return entry ? (entry[state.locale] || entry["zh-CN"] || entry["en"] || key) : key;
    }
    function applyLocale() {
      Object.keys(copy).forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = tr(id);
        }
      });
      document.documentElement.lang = state.locale === "en" ? "en" : "zh-CN";
      document.getElementById("localeZh").classList.toggle("active", state.locale === "zh-CN");
      document.getElementById("localeEn").classList.toggle("active", state.locale === "en");
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
      if (snapshot.locale && !state.userSelectedLocale) {
        state.locale = snapshot.locale;
      }
      const pill = document.getElementById("connectionPill");
      if (snapshot.connectionState === "connected") {
        pill.textContent = tr("pillConnected");
        pill.className = "pill ok";
      } else if (snapshot.connectionState === "connecting") {
        pill.textContent = tr("pillConnecting");
        pill.className = "pill warn";
      } else {
        pill.textContent = tr("pillDisconnected");
        pill.className = "pill";
      }
      setStatus("connectedValue", snapshot.connected ? tr("valueConnected") : tr("valueDisconnected"), snapshot.connected ? "ok" : "warn");
      setStatus("callableValue", snapshot.callable ? tr("valueReady") : tr("valueBlocked"), snapshot.callable ? "ok" : "warn");
      setStatus("providerValue", snapshot.providerReady ? tr("valueReady") : tr("valueNotReady"), snapshot.providerReady ? "ok" : "muted");
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
      applyLocale();
    }
    document.getElementById("connect").addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    document.getElementById("disconnect").addEventListener("click", () => vscode.postMessage({ type: "disconnect" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("diagnose").addEventListener("click", () => vscode.postMessage({ type: "diagnose" }));
    document.getElementById("status").addEventListener("click", () => vscode.postMessage({ type: "status" }));
    document.getElementById("log").addEventListener("click", () => vscode.postMessage({ type: "log" }));
    document.getElementById("localeZh").addEventListener("click", () => {
      state.locale = "zh-CN";
      state.userSelectedLocale = true;
      applyLocale();
    });
    document.getElementById("localeEn").addEventListener("click", () => {
      state.locale = "en";
      state.userSelectedLocale = true;
      applyLocale();
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
    applyLocale();
    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}
