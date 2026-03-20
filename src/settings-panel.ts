import * as vscode from "vscode";
import { getConfig } from "./config";
import { getCurrentLocale, t } from "./i18n";

interface SettingsData {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls: boolean;
  gatewayToken: string;
  displayName: string;
  locale: string;
}

type SettingsPanelHandlers = {
  onSaveAndConnect: () => Promise<void>;
  onDiagnose: () => Promise<void>;
};

let panel: vscode.WebviewPanel | null = null;

export function showSettingsPanel(handlers: SettingsPanelHandlers): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    "clawdriveSettings",
    t("app.settings"),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    }
  );

  const render = () => {
    const cfg = getConfig();
    const nonce = createNonce();
    panel!.webview.html = getHtml(
      {
        gatewayHost: cfg.gatewayHost,
        gatewayPort: cfg.gatewayPort,
        gatewayTls: cfg.gatewayTls,
        gatewayToken: cfg.gatewayToken,
        displayName: cfg.displayName,
        locale: getCurrentLocale(),
      },
      panel!.webview.cspSource,
      nonce
    );
  };

  render();

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const msg = message as { type?: unknown; data?: unknown };
    const type = typeof msg.type === "string" ? msg.type : "";

    try {
      if (type === "save" || type === "saveAndConnect") {
        const data = parseSettingsInput(msg.data);
        await applySettings(data);
        await vscode.window.showInformationMessage(t("notify.settingsSaved"));
        render();
        if (type === "saveAndConnect") {
          await handlers.onSaveAndConnect();
        }
        return;
      }

      if (type === "diagnose") {
        await handlers.onDiagnose();
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

function parseSettingsInput(value: unknown): SettingsData {
  if (!value || typeof value !== "object") {
    throw new Error(t("error.invalidSettingsPayload"));
  }

  const data = value as Record<string, unknown>;
  const gatewayHost = typeof data.gatewayHost === "string" ? data.gatewayHost.trim() : "";
  const gatewayToken = typeof data.gatewayToken === "string" ? data.gatewayToken.trim() : "";
  const displayName = typeof data.displayName === "string" ? data.displayName.trim() : "";
  const gatewayPortRaw =
    typeof data.gatewayPort === "string" || typeof data.gatewayPort === "number"
      ? Number(data.gatewayPort)
      : Number.NaN;

  if (!gatewayHost) {
    throw new Error(t("error.gatewayHostRequired"));
  }
  if (!Number.isFinite(gatewayPortRaw) || gatewayPortRaw <= 0 || gatewayPortRaw > 65535) {
    throw new Error(t("error.gatewayPortRange"));
  }
  if (!displayName) {
    throw new Error(t("error.displayNameRequired"));
  }

  return {
    gatewayHost,
    gatewayPort: Math.trunc(gatewayPortRaw),
    gatewayTls: Boolean(data.gatewayTls),
    gatewayToken,
    displayName,
    locale: typeof data.locale === "string" ? data.locale : getCurrentLocale(),
  };
}

async function applySettings(data: SettingsData): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  await cfg.update("gateway.host", data.gatewayHost, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.port", data.gatewayPort, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.tls", data.gatewayTls, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.token", data.gatewayToken, vscode.ConfigurationTarget.Global);
  await cfg.update("displayName", data.displayName, vscode.ConfigurationTarget.Global);
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 24; index += 1) {
    value += chars[Math.floor(Math.random() * chars.length)];
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getHtml(data: SettingsData, cspSource: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawDrive Settings</title>
  <style>
    :root {
      color-scheme: light dark;
      --panel-bg: color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-button-background) 16%);
      --panel-soft: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
      --line: color-mix(in srgb, var(--vscode-widget-border, #444) 60%, transparent);
      --accent-soft: color-mix(in srgb, var(--vscode-button-background) 12%, transparent);
      --warning-soft: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d9a400) 16%, transparent);
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px 20px 36px;
    }
    .wrap {
      max-width: 960px;
      margin: 0 auto;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 22px;
      margin-bottom: 18px;
      background: linear-gradient(135deg, var(--panel-bg), var(--panel-soft));
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      max-width: 700px;
    }
    .locale {
      display: inline-flex;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px;
      gap: 4px;
      background: var(--panel-soft);
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
    .layout {
      display: grid;
      grid-template-columns: 1.25fr 0.95fr;
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      background: var(--panel-soft);
    }
    .title {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .field {
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    input[type="text"], input[type="number"], input[type="password"] {
      width: 100%;
      box-sizing: border-box;
      padding: 9px 10px;
      border-radius: 8px;
      border: 1px solid var(--vscode-input-border, #555);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
    }
    .row label {
      margin: 0;
      font-weight: 400;
    }
    .hint {
      margin-top: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
    }
    .notice {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      margin-top: 14px;
      line-height: 1.6;
      font-size: 13px;
      background: var(--warning-soft);
    }
    .steps {
      display: grid;
      gap: 10px;
    }
    .step {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      background: color-mix(in srgb, var(--panel-soft) 90%, var(--accent-soft) 10%);
    }
    .step strong {
      display: block;
      margin-bottom: 6px;
    }
    .bullets {
      margin: 0;
      padding-left: 18px;
      line-height: 1.7;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
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
    .error {
      display: none;
      color: var(--vscode-errorForeground, #f14c4c);
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 18px;
    }
    @media (max-width: 860px) {
      .hero { flex-direction: column; }
      .layout { grid-template-columns: 1fr; }
      .actions { flex-direction: column; }
      .actions button { width: 100%; }
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
      <div class="locale">
        <button id="localeZh" type="button">中文</button>
        <button id="localeEn" type="button">English</button>
      </div>
    </div>
    <div id="error" class="error"></div>
    <div class="layout">
      <div class="stack">
        <div class="card">
          <div class="title" id="gatewayTitle"></div>
          <div class="field">
            <label for="gatewayHost" id="gatewayHostLabel"></label>
            <input id="gatewayHost" type="text" value="${escapeHtml(data.gatewayHost)}" placeholder="127.0.0.1">
            <div class="hint" id="gatewayHostHint"></div>
          </div>
          <div class="field">
            <label for="gatewayPort" id="gatewayPortLabel"></label>
            <input id="gatewayPort" type="number" value="${data.gatewayPort}" placeholder="18789">
          </div>
          <div class="field">
            <label for="gatewayToken" id="gatewayTokenLabel"></label>
            <input id="gatewayToken" type="password" value="${escapeHtml(data.gatewayToken)}" placeholder="gateway.auth.token">
            <div class="hint" id="gatewayTokenHint"></div>
          </div>
          <div class="row">
            <input id="gatewayTls" type="checkbox" ${data.gatewayTls ? "checked" : ""}>
            <label for="gatewayTls" id="gatewayTlsLabel"></label>
          </div>
          <div class="hint" id="gatewayTlsHint"></div>
        </div>
        <div class="card">
          <div class="title" id="nodeTitle"></div>
          <div class="field">
            <label for="displayName" id="displayNameLabel"></label>
            <input id="displayName" type="text" value="${escapeHtml(data.displayName)}" placeholder="ClawDrive">
            <div class="hint" id="displayNameHint"></div>
          </div>
          <div class="notice" id="allowCommandsNotice"></div>
        </div>
        <div class="actions">
          <button class="primary" id="save"></button>
          <button class="secondary" id="saveAndConnect"></button>
          <button class="secondary" id="diagnose"></button>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="title" id="stepsTitle"></div>
          <div class="steps">
            <div class="step"><strong id="step1Title"></strong><div id="step1Body"></div></div>
            <div class="step"><strong id="step2Title"></strong><div id="step2Body"></div></div>
            <div class="step"><strong id="step3Title"></strong><div id="step3Body"></div></div>
          </div>
        </div>
        <div class="card">
          <div class="title" id="checklistTitle"></div>
          <ul class="bullets">
            <li id="check1"></li>
            <li id="check2"></li>
            <li id="check3"></li>
          </ul>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = Object.assign({ locale: ${JSON.stringify(data.locale)} }, vscode.getState() || {});
    const copy = {
      title: { "zh-CN": "ClawDrive 设置", "en": "ClawDrive Settings" },
      subtitle: {
        "zh-CN": "先把 Gateway 参数配准，再回到控制台发起连接和诊断。Phase 1 只覆盖真实联调所需的最小配置。",
        "en": "Set the Gateway connection parameters first, then return to the dashboard to connect and diagnose. Phase 1 only covers the minimum configuration required for real integration."
      },
      gatewayTitle: { "zh-CN": "Gateway 配置", "en": "Gateway Configuration" },
      gatewayHostLabel: { "zh-CN": "Host", "en": "Host" },
      gatewayHostHint: { "zh-CN": "本地 Gateway 通常使用 127.0.0.1。", "en": "A local Gateway usually uses 127.0.0.1." },
      gatewayPortLabel: { "zh-CN": "端口", "en": "Port" },
      gatewayTokenLabel: { "zh-CN": "Token", "en": "Token" },
      gatewayTokenHint: { "zh-CN": "本地 OpenClaw 通常可从 ~/.openclaw/openclaw.json 的 gateway.auth.token 取得。", "en": "For a local OpenClaw setup, read gateway.auth.token from ~/.openclaw/openclaw.json." },
      gatewayTlsLabel: { "zh-CN": "使用 TLS（wss://）", "en": "Use TLS (wss://)" },
      gatewayTlsHint: { "zh-CN": "大多数本地 Gateway 使用 ws://127.0.0.1:18789，通常不需要开启 TLS。", "en": "Most local Gateways use ws://127.0.0.1:18789 and usually do not require TLS." },
      nodeTitle: { "zh-CN": "节点信息", "en": "Node Identity" },
      displayNameLabel: { "zh-CN": "显示名称", "en": "Display Name" },
      displayNameHint: { "zh-CN": "这是节点在 Gateway 中显示的名称。", "en": "This is the name advertised by the node to the Gateway." },
      allowCommandsNotice: { "zh-CN": "如果 Gateway 启用了 gateway.nodes.allowCommands，请确认其中至少包含 vscode.workspace.info，否则会出现“已连接但不可调用”。", "en": "If the Gateway uses gateway.nodes.allowCommands, make sure vscode.workspace.info is included, or the node may be connected but not callable." },
      save: { "zh-CN": "保存设置", "en": "Save Settings" },
      saveAndConnect: { "zh-CN": "保存并连接", "en": "Save and Connect" },
      diagnose: { "zh-CN": "运行诊断", "en": "Run Diagnosis" },
      stepsTitle: { "zh-CN": "最小接入路径", "en": "Minimal Onboarding Path" },
      step1Title: { "zh-CN": "1. 配准 Gateway", "en": "1. Configure the Gateway" },
      step1Body: { "zh-CN": "填写 host、port、token，并确认 TLS 是否关闭。", "en": "Fill in host, port, token, and confirm whether TLS should be off." },
      step2Title: { "zh-CN": "2. 回到控制台连接", "en": "2. Return to Dashboard and Connect" },
      step2Body: { "zh-CN": "保存后回到 Dashboard，执行 Connect，确认连接状态变成“已连接”。", "en": "Return to the Dashboard after saving, click Connect, and confirm the state becomes connected." },
      step3Title: { "zh-CN": "3. 让 OpenClaw 调用", "en": "3. Invoke from OpenClaw" },
      step3Body: { "zh-CN": "在 OpenClaw 侧触发 vscode.workspace.info，并在 ClawDrive 日志中确认 invoke request / result。", "en": "Trigger vscode.workspace.info from OpenClaw and confirm invoke request / result entries in the ClawDrive log." },
      checklistTitle: { "zh-CN": "接入前检查", "en": "Pre-flight Checklist" },
      check1: { "zh-CN": "本地默认地址通常是 127.0.0.1:18789。", "en": "The common local address is 127.0.0.1:18789." },
      check2: { "zh-CN": "如使用 allowCommands，至少允许 vscode.workspace.info。", "en": "If allowCommands is enabled, make sure vscode.workspace.info is allowed." },
      check3: { "zh-CN": "若出现 device identity mismatch，说明当前节点身份没有复用到正确历史身份。", "en": "If you see device identity mismatch, the node identity is not reusing the correct historical identity." },
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
    function getData() {
      return {
        gatewayHost: document.getElementById("gatewayHost").value,
        gatewayPort: document.getElementById("gatewayPort").value,
        gatewayTls: document.getElementById("gatewayTls").checked,
        gatewayToken: document.getElementById("gatewayToken").value,
        displayName: document.getElementById("displayName").value,
        locale: state.locale,
      };
    }
    document.getElementById("save").addEventListener("click", () => {
      showError("");
      vscode.postMessage({ type: "save", data: getData() });
    });
    document.getElementById("saveAndConnect").addEventListener("click", () => {
      showError("");
      vscode.postMessage({ type: "saveAndConnect", data: getData() });
    });
    document.getElementById("diagnose").addEventListener("click", () => vscode.postMessage({ type: "diagnose" }));
    document.getElementById("localeZh").addEventListener("click", () => {
      state.locale = "zh-CN";
      applyLocale();
    });
    document.getElementById("localeEn").addEventListener("click", () => {
      state.locale = "en";
      applyLocale();
    });
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "error") {
        showError(msg.error || tr("unknownError"));
      }
    });
    applyLocale();
  </script>
</body>
</html>`;
}
