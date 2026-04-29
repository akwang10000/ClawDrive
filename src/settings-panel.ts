import * as vscode from "vscode";
import { getConfig } from "./config";
import { getCurrentLocale, t } from "./i18n";

interface SettingsData {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls: boolean;
  gatewayToken: string;
  autoConnect: boolean;
  displayName: string;
  providerEnabled: boolean;
  providerKind: "codex" | "claude";
  providerCodexPath: string;
  providerCodexModel: string;
  providerClaudePath: string;
  providerClaudeModel: string;
  providerFallbackToAlternate: boolean;
  providerPolicyLevel: "safe" | "extended" | "raw";
  providerDisableFeatures: string[];
  providerSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  tasksDefaultTimeoutMs: number;
  tasksHistoryLimit: number;
  locale: string;
}

type SettingsPanelHandlers = {
  onSaveAndConnect: () => Promise<void>;
};

let panel: vscode.WebviewPanel | null = null;

export function showSettingsPanel(handlers: SettingsPanelHandlers): void {
  const render = () => {
    const cfg = getConfig();
    const nonce = createNonce();
    panel!.webview.html = getHtml(
      {
        gatewayHost: cfg.gatewayHost,
        gatewayPort: cfg.gatewayPort,
        gatewayTls: cfg.gatewayTls,
        gatewayToken: cfg.gatewayToken,
        autoConnect: cfg.autoConnect,
        displayName: cfg.displayName,
        providerEnabled: cfg.providerEnabled,
        providerKind: cfg.providerKind,
        providerCodexPath: cfg.providerCodexPath,
        providerCodexModel: cfg.providerCodexModel,
        providerClaudePath: cfg.providerClaudePath,
        providerClaudeModel: cfg.providerClaudeModel,
        providerFallbackToAlternate: cfg.providerFallbackToAlternate,
        providerPolicyLevel: cfg.providerPolicyLevel,
        providerDisableFeatures: cfg.providerDisableFeatures,
        providerSandboxMode: cfg.providerSandboxMode,
        tasksDefaultTimeoutMs: cfg.tasksDefaultTimeoutMs,
        tasksHistoryLimit: cfg.tasksHistoryLimit,
        locale: getCurrentLocale(),
      },
      panel!.webview.cspSource,
      nonce
    );
  };

  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    render();
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

  render();

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    const msg = message as { type?: unknown; data?: unknown };
    const type = typeof msg.type === "string" ? msg.type : "";

    try {
      if (type === "saveAndConnect") {
        const data = parseSettingsInput(msg.data);
        await applySettings(data);
        await handlers.onSaveAndConnect();
        await vscode.window.showInformationMessage(t("notify.settingsSaved"));
        panel?.dispose();
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
  const providerKindRaw = typeof data.providerKind === "string" ? data.providerKind.trim() : "";
  const providerCodexPath = typeof data.providerCodexPath === "string" ? data.providerCodexPath.trim() : "";
  const providerCodexModel = typeof data.providerCodexModel === "string" ? data.providerCodexModel.trim() : "";
  const providerClaudePath = typeof data.providerClaudePath === "string" ? data.providerClaudePath.trim() : "";
  const providerClaudeModel = typeof data.providerClaudeModel === "string" ? data.providerClaudeModel.trim() : "";
  const providerPolicyLevelRaw = typeof data.providerPolicyLevel === "string" ? data.providerPolicyLevel.trim() : "";
  const providerDisableFeaturesRaw =
    typeof data.providerDisableFeatures === "string" ? data.providerDisableFeatures : "";
  const providerSandboxModeRaw = typeof data.providerSandboxMode === "string" ? data.providerSandboxMode.trim() : "";
  const gatewayPortRaw =
    typeof data.gatewayPort === "string" || typeof data.gatewayPort === "number"
      ? Number(data.gatewayPort)
      : Number.NaN;
  const tasksDefaultTimeoutRaw =
    typeof data.tasksDefaultTimeoutMs === "string" || typeof data.tasksDefaultTimeoutMs === "number"
      ? Number(data.tasksDefaultTimeoutMs)
      : Number.NaN;
  const tasksHistoryLimitRaw =
    typeof data.tasksHistoryLimit === "string" || typeof data.tasksHistoryLimit === "number"
      ? Number(data.tasksHistoryLimit)
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
  if (!Number.isFinite(tasksDefaultTimeoutRaw) || tasksDefaultTimeoutRaw < 5000) {
    throw new Error("Task timeout must be at least 5000ms.");
  }
  if (!Number.isFinite(tasksHistoryLimitRaw) || tasksHistoryLimitRaw < 1) {
    throw new Error("Task history limit must be at least 1.");
  }

  return {
    gatewayHost,
    gatewayPort: Math.trunc(gatewayPortRaw),
    gatewayTls: Boolean(data.gatewayTls),
    gatewayToken,
    autoConnect: Boolean(data.autoConnect),
    displayName,
    providerEnabled: Boolean(data.providerEnabled),
    providerKind: providerKindRaw === "claude" ? "claude" : "codex",
    providerCodexPath: providerCodexPath || "codex",
    providerCodexModel,
    providerClaudePath: providerClaudePath || "claude",
    providerClaudeModel,
    providerFallbackToAlternate: Boolean(data.providerFallbackToAlternate),
    providerPolicyLevel:
      providerPolicyLevelRaw === "extended" || providerPolicyLevelRaw === "raw" ? providerPolicyLevelRaw : "safe",
    providerDisableFeatures: providerDisableFeaturesRaw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    providerSandboxMode:
      providerSandboxModeRaw === "workspace-write" || providerSandboxModeRaw === "danger-full-access"
        ? providerSandboxModeRaw
        : "read-only",
    tasksDefaultTimeoutMs: Math.trunc(tasksDefaultTimeoutRaw),
    tasksHistoryLimit: Math.trunc(tasksHistoryLimitRaw),
    locale: typeof data.locale === "string" ? data.locale : getCurrentLocale(),
  };
}

async function applySettings(data: SettingsData): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("clawdrive");
  await cfg.update("gateway.host", data.gatewayHost, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.port", data.gatewayPort, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.tls", data.gatewayTls, vscode.ConfigurationTarget.Global);
  await cfg.update("gateway.token", data.gatewayToken, vscode.ConfigurationTarget.Global);
  await cfg.update("autoConnect", data.autoConnect, vscode.ConfigurationTarget.Global);
  await cfg.update("displayName", data.displayName, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.enabled", data.providerEnabled, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.kind", data.providerKind, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.codex.path", data.providerCodexPath, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.codex.model", data.providerCodexModel, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.claude.path", data.providerClaudePath, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.claude.model", data.providerClaudeModel, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.fallbackToAlternate", data.providerFallbackToAlternate, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.policyLevel", data.providerPolicyLevel, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.disableFeatures", data.providerDisableFeatures, vscode.ConfigurationTarget.Global);
  await cfg.update("provider.sandboxMode", data.providerSandboxMode, vscode.ConfigurationTarget.Global);
  await cfg.update("tasks.defaultTimeoutMs", data.tasksDefaultTimeoutMs, vscode.ConfigurationTarget.Global);
  await cfg.update("tasks.historyLimit", data.tasksHistoryLimit, vscode.ConfigurationTarget.Global);
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
      --panel-bg: linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-button-background) 16%), color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-sideBar-background) 6%));
      --card-bg: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background) 8%);
      --line: color-mix(in srgb, var(--vscode-widget-border, #444) 60%, transparent);
      --note-bg: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 10%, transparent);
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px 20px 32px;
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
      padding: 22px;
      background: var(--panel-bg);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      max-width: 680px;
    }
    .layout {
      display: grid;
      grid-template-columns: 1.1fr 0.9fr;
      gap: 16px;
    }
    .stack {
      display: grid;
      gap: 16px;
    }
    .card {
      padding: 18px;
    }
    .title {
      margin: 0 0 16px;
      font-size: 16px;
      font-weight: 600;
    }
    .field {
      margin-bottom: 14px;
    }
    label {
      display: block;
      margin-bottom: 6px;
      font-weight: 500;
    }
    input[type="text"], input[type="number"], input[type="password"], select {
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
    .note {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      line-height: 1.6;
      background: var(--note-bg);
      color: var(--vscode-foreground);
    }
    .note + .note {
      margin-top: 10px;
    }
    .actions {
      display: flex;
      gap: 10px;
    }
    button {
      border: none;
      border-radius: 10px;
      padding: 11px 14px;
      cursor: pointer;
      font: inherit;
      text-align: left;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .error {
      display: none;
      color: var(--vscode-errorForeground, #f14c4c);
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      border-radius: 10px;
      padding: 10px 12px;
    }
    @media (max-width: 860px) {
      .layout { grid-template-columns: 1fr; }
      .actions button { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <h1 id="title"></h1>
      <div class="sub" id="subtitle"></div>
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
          <div class="row">
            <input id="autoConnect" type="checkbox" ${data.autoConnect ? "checked" : ""}>
            <label for="autoConnect" id="autoConnectLabel"></label>
          </div>
          <div class="hint" id="autoConnectHint"></div>
        </div>
        <div class="card">
          <div class="title" id="nodeTitle"></div>
          <div class="field">
            <label for="displayName" id="displayNameLabel"></label>
            <input id="displayName" type="text" value="${escapeHtml(data.displayName)}" placeholder="ClawDrive">
            <div class="hint" id="displayNameHint"></div>
          </div>
          <div class="field">
            <label for="providerKind" id="providerKindLabel"></label>
            <select id="providerKind">
              <option value="codex" ${data.providerKind === "codex" ? "selected" : ""}>codex-cli</option>
              <option value="claude" ${data.providerKind === "claude" ? "selected" : ""}>claude-cli</option>
            </select>
            <div class="hint" id="providerKindHint"></div>
          </div>
          <div class="field">
            <label for="providerCodexPath" id="providerCodexPathLabel"></label>
            <input id="providerCodexPath" type="text" value="${escapeHtml(data.providerCodexPath)}" placeholder="codex">
            <div class="hint" id="providerCodexPathHint"></div>
          </div>
          <div class="field">
            <label for="providerCodexModel" id="providerCodexModelLabel"></label>
            <input id="providerCodexModel" type="text" value="${escapeHtml(data.providerCodexModel)}" placeholder="">
            <div class="hint" id="providerCodexModelHint"></div>
          </div>
          <div class="field">
            <label for="providerClaudePath" id="providerClaudePathLabel"></label>
            <input id="providerClaudePath" type="text" value="${escapeHtml(data.providerClaudePath)}" placeholder="claude">
            <div class="hint" id="providerClaudePathHint"></div>
          </div>
          <div class="field">
            <label for="providerClaudeModel" id="providerClaudeModelLabel"></label>
            <input id="providerClaudeModel" type="text" value="${escapeHtml(data.providerClaudeModel)}" placeholder="">
            <div class="hint" id="providerClaudeModelHint"></div>
          </div>
          <div class="row">
            <input id="providerFallbackToAlternate" type="checkbox" ${data.providerFallbackToAlternate ? "checked" : ""}>
            <label for="providerFallbackToAlternate" id="providerFallbackToAlternateLabel"></label>
          </div>
          <div class="hint" id="providerFallbackToAlternateHint"></div>
          <div class="field">
            <label for="providerPolicyLevel" id="providerPolicyLevelLabel"></label>
            <select id="providerPolicyLevel">
              <option value="safe" ${data.providerPolicyLevel === "safe" ? "selected" : ""}>safe</option>
              <option value="extended" ${data.providerPolicyLevel === "extended" ? "selected" : ""}>extended</option>
              <option value="raw" ${data.providerPolicyLevel === "raw" ? "selected" : ""}>raw</option>
            </select>
            <div class="hint" id="providerPolicyLevelHint"></div>
          </div>
          <div class="field">
            <label for="providerDisableFeatures" id="providerDisableFeaturesLabel"></label>
            <input id="providerDisableFeatures" type="text" value="${escapeHtml(data.providerDisableFeatures.join(", "))}" placeholder="multi_agent, plugins, apps, shell_snapshot">
            <div class="hint" id="providerDisableFeaturesHint"></div>
          </div>
          <div class="field">
            <label for="providerSandboxMode" id="providerSandboxModeLabel"></label>
            <select id="providerSandboxMode">
              <option value="read-only" ${data.providerSandboxMode === "read-only" ? "selected" : ""}>read-only</option>
              <option value="workspace-write" ${data.providerSandboxMode === "workspace-write" ? "selected" : ""}>workspace-write</option>
              <option value="danger-full-access" ${data.providerSandboxMode === "danger-full-access" ? "selected" : ""}>danger-full-access</option>
            </select>
            <div class="hint" id="providerSandboxModeHint"></div>
          </div>
          <div class="row">
            <input id="providerEnabled" type="checkbox" ${data.providerEnabled ? "checked" : ""}>
            <label for="providerEnabled" id="providerEnabledLabel"></label>
          </div>
          <div class="hint" id="providerEnabledHint"></div>
        </div>
        <div class="card">
          <div class="title" id="tasksTitle"></div>
          <div class="field">
            <label for="tasksDefaultTimeoutMs" id="tasksDefaultTimeoutLabel"></label>
            <input id="tasksDefaultTimeoutMs" type="number" value="${data.tasksDefaultTimeoutMs}" placeholder="300000">
          </div>
          <div class="field">
            <label for="tasksHistoryLimit" id="tasksHistoryLimitLabel"></label>
            <input id="tasksHistoryLimit" type="number" value="${data.tasksHistoryLimit}" placeholder="50">
          </div>
        </div>
        <div class="actions">
          <button id="saveAndConnect"></button>
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="title" id="notesTitle"></div>
          <div class="note" id="note1"></div>
          <div class="note" id="note2"></div>
          <div class="note" id="note3"></div>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = { locale: ${JSON.stringify(data.locale)} };
    const copy = {
      title: { "zh-CN": "\\u8bbe\\u7f6e", "en": "Settings" },
      subtitle: {
        "zh-CN": "\\u53ea\\u4fdd\\u7559\\u8fde\\u63a5 OpenClaw \\u6240\\u9700\\u7684\\u5173\\u952e\\u9879\\u3002\\u4fee\\u6539\\u5b8c\\u76f4\\u63a5\\u70b9\\u201c\\u4fdd\\u5b58\\u5e76\\u8fde\\u63a5\\u201d\\uff0c\\u4e0d\\u518d\\u5206\\u6210\\u591a\\u6b65\\u3002",
        "en": "Only the essential fields for connecting to OpenClaw remain. Update them and click Save and Connect."
      },
      gatewayTitle: { "zh-CN": "Gateway", "en": "Gateway" },
      gatewayHostLabel: { "zh-CN": "Host", "en": "Host" },
      gatewayHostHint: { "zh-CN": "\\u672c\\u5730 Gateway \\u901a\\u5e38\\u662f 127.0.0.1\\u3002", "en": "A local Gateway usually uses 127.0.0.1." },
      gatewayPortLabel: { "zh-CN": "\\u7aef\\u53e3", "en": "Port" },
      gatewayTokenLabel: { "zh-CN": "Token", "en": "Token" },
      gatewayTokenHint: { "zh-CN": "\\u53ef\\u4ece ~/.openclaw/openclaw.json \\u7684 gateway.auth.token \\u8bfb\\u53d6\\u3002", "en": "Read gateway.auth.token from ~/.openclaw/openclaw.json." },
      gatewayTlsLabel: { "zh-CN": "\\u4f7f\\u7528 TLS\\uff08wss://\\uff09", "en": "Use TLS (wss://)" },
      gatewayTlsHint: { "zh-CN": "\\u5927\\u591a\\u6570\\u672c\\u5730\\u573a\\u666f\\u4e0d\\u9700\\u8981\\u5f00\\u542f TLS\\u3002", "en": "Most local setups do not need TLS." },
      autoConnectLabel: { "zh-CN": "\\u542f\\u52a8\\u540e\\u81ea\\u52a8\\u8fde\\u63a5 Gateway", "en": "Auto-connect on startup" },
      autoConnectHint: { "zh-CN": "\\u5f00\\u542f\\u540e\\uff0cVS Code \\u91cd\\u8f7d\\u6216\\u542f\\u52a8\\u65f6\\u4f1a\\u81ea\\u52a8\\u5c1d\\u8bd5\\u8fde\\u63a5\\u3002", "en": "When enabled, VS Code will try to connect automatically on startup or reload." },
      nodeTitle: { "zh-CN": "\\u8282\\u70b9\\u4e0e Provider", "en": "Node and Provider" },
      displayNameLabel: { "zh-CN": "\\u663e\\u793a\\u540d\\u79f0", "en": "Display Name" },
      displayNameHint: { "zh-CN": "\\u8fd9\\u662f Gateway \\u4e2d\\u770b\\u5230\\u7684\\u8282\\u70b9\\u540d\\u79f0\\u3002", "en": "This is the node name shown in the Gateway." },
      providerKindLabel: { "zh-CN": "Provider \\u7c7b\\u578b", "en": "Provider Kind" },
      providerKindHint: {
        "zh-CN": "\\u53ea\\u6709 CLI provider \\u4f1a\\u7528\\u4e8e long-running task\\u3002Claude Code for VS Code \\u662f handoff-only\\uff0c\\u4e0d\\u662f\\u540e\\u53f0 task provider\\u3002",
        "en": "Only CLI providers run long-running tasks. Claude Code for VS Code is handoff-only and is not a background task provider."
      },
      providerCodexPathLabel: { "zh-CN": "Codex \\u53ef\\u6267\\u884c\\u8def\\u5f84", "en": "Codex Executable" },
      providerCodexPathHint: { "zh-CN": "\\u53ef\\u4ee5\\u5199 codex\\uff0c\\u4e5f\\u53ef\\u4ee5\\u586b\\u7edd\\u5bf9\\u8def\\u5f84\\u3002", "en": "Use codex or an absolute executable path." },
      providerCodexModelLabel: { "zh-CN": "Codex \\u6a21\\u578b\\uff08\\u53ef\\u9009\\uff09", "en": "Codex Model (Optional)" },
      providerCodexModelHint: { "zh-CN": "\\u7559\\u7a7a\\u65f6\\u4f7f\\u7528 Codex CLI \\u9ed8\\u8ba4\\u6a21\\u578b\\u3002", "en": "Leave empty to use the Codex CLI default model." },
      providerClaudePathLabel: { "zh-CN": "Claude CLI \\u53ef\\u6267\\u884c\\u8def\\u5f84", "en": "Claude CLI Executable" },
      providerClaudePathHint: {
        "zh-CN": "\\u586b\\u5199 Claude CLI \\u7684\\u547d\\u4ee4\\u540d\\u6216\\u7edd\\u5bf9\\u8def\\u5f84\\u3002\\u5355\\u72ec\\u5b89\\u88c5 Claude Code for VS Code \\u6269\\u5c55\\u4e0d\u7b49\u4e8e\\u8fd9\\u4e2a CLI\u3002",
        "en": "Use the Claude CLI command name or an absolute executable path. Installing Claude Code for VS Code alone does not provide this CLI runtime."
      },
      providerClaudeModelLabel: { "zh-CN": "Claude \\u6a21\\u578b\\uff08\\u53ef\\u9009\\uff09", "en": "Claude Model (Optional)" },
      providerClaudeModelHint: { "zh-CN": "\\u7559\\u7a7a\\u65f6\\u4f7f\\u7528 Claude Code \\u9ed8\\u8ba4\\u6a21\\u578b\\u3002", "en": "Leave empty to use the Claude Code default model." },
      providerFallbackToAlternateLabel: {
        "zh-CN": "\\u9009\\u4e2d provider \\u4e0d\\u53ef\\u7528\\u65f6\\u81ea\\u52a8\\u56de\\u9000\\u5230\\u53e6\\u4e00\\u4e2a provider",
        "en": "Fall back to the other provider when unavailable"
      },
      providerFallbackToAlternateHint: {
        "zh-CN": "\\u9ed8\\u8ba4\\u5173\\u95ed\\u3002\\u5f00\\u542f\\u540e\\uff0c\\u5f53\\u524d provider \\u4e0d\\u53ef\\u7528\\u65f6\\u4f1a\\u5c1d\\u8bd5\\u5185\\u7f6e\u7684\u53e6\u4e00\u4e2a provider\u3002",
        "en": "Off by default. When enabled, ClawDrive will try the other built-in provider if the selected one is unavailable."
      },
      providerPolicyLevelLabel: { "zh-CN": "Provider \\u7b56\\u7565\\u5c42\\u7ea7", "en": "Provider Policy Level" },
      providerPolicyLevelHint: {
        "zh-CN": "\\u9ed8\\u8ba4 safe \\u4f7f\\u7528\\u9694\\u79bb CODEX_HOME\\uff0cextended \\u4f1a\\u4ece\\u4f60\\u7684\\u672c\\u5730 Codex home \\u6d3e\\u751f task CODEX_HOME\\u5e76\\u5bf9\u914d\u7f6e\\u505a\\u5b89\\u5168\\u5254\\u79bb\\uff0craw \\u5219\\u76f4\\u63a5\\u7ee7\\u627f\\u539f\\u59cb CODEX_HOME\\uff08\\u98ce\\u9669\\u6700\\u9ad8\\uff09\\u3002",
        "en": "safe uses isolated CODEX_HOME. extended derives and sanitizes a task CODEX_HOME. raw reuses your source CODEX_HOME directly and is the highest-risk mode."
      },
      providerDisableFeaturesLabel: { "zh-CN": "\\u5f3a\\u5236\\u5173\\u95ed\\u7684 Codex features", "en": "Forced-off Codex Features" },
      providerDisableFeaturesHint: {
        "zh-CN": "\\u7528\\u82f1\\u6587\\u9017\\u53f7\\u5206\\u9694 feature \\u540d\\u79f0\\u3002\\u7559\\u7a7a\\u8868\\u793a\\u4e0d\\u989d\\u5916\\u5173\\u95ed task \\u542f\\u52a8 feature\\u3002",
        "en": "Comma-separated feature names. Leave empty to avoid forcing any task startup features off."
      },
      providerSandboxModeLabel: { "zh-CN": "Provider \\u547d\\u4ee4\\u6743\\u9650", "en": "Provider Sandbox Mode" },
      providerSandboxModeHint: {
        "zh-CN": "\\u9ed8\\u8ba4 read-only\\uff0cworkspace-write \\u4e3a\\u5de5\\u4f5c\\u533a\\u5199\\u5165\\u6388\\u6743\\uff0cdanger-full-access \\u4e3a\\u6700\\u9ad8\\u6743\\u9650\\uff08\\u98ce\\u9669\\u6700\\u9ad8\\uff09\\u3002",
        "en": "Default is read-only. workspace-write allows workspace writes. danger-full-access removes sandboxing (highest risk)."
      },
      providerEnabledLabel: { "zh-CN": "\\u542f\\u7528 Provider task \\u6267\\u884c", "en": "Enable Provider Tasks" },
      providerEnabledHint: { "zh-CN": "\\u9700\\u8981\\u4efb\\u52a1\\u547d\\u4ee4\\u65f6\\u6253\\u5f00\\u5b83\\u3002", "en": "Turn this on before using task commands." },
      tasksTitle: { "zh-CN": "\\u4efb\\u52a1\\u9ed8\\u8ba4\\u503c", "en": "Task Defaults" },
      tasksDefaultTimeoutLabel: { "zh-CN": "\\u9ed8\\u8ba4\\u8d85\\u65f6\\uff08ms\\uff09", "en": "Timeout (ms)" },
      tasksHistoryLimitLabel: { "zh-CN": "\\u5386\\u53f2\\u4fdd\\u7559\\u6570\\u91cf", "en": "History Limit" },
      saveAndConnect: { "zh-CN": "\\u4fdd\\u5b58\\u5e76\\u8fde\\u63a5", "en": "Save and Connect" },
      notesTitle: { "zh-CN": "\\u4f7f\\u7528\\u8bf4\\u660e", "en": "Notes" },
      note1: {
        "zh-CN": "\\u8fd9\\u4e2a\\u9875\\u9762\\u7528\\u6765\\u914d\\u7f6e\\u5e76\\u5b8c\\u6210\\u9996\\u6b21\\u8fde\\u63a5\\u3002\\u8fde\\u63a5\\u72b6\\u6001\\u548c\\u8bca\\u65ad\\u4ecd\\u7136\\u56de\\u5230 dashboard \\u67e5\\u770b\\u3002",
        "en": "Use this page for configuration and first-time connect. Ongoing status and diagnosis still live in the dashboard."
      },
      note2: {
        "zh-CN": "\\u5982\\u679c provider \\u62a5 ENOENT\\uff0c\\u8bf7\\u76f4\\u63a5\\u586b\\u5199\\u5bf9\\u5e94 CLI \\u7684\\u7edd\\u5bf9\\u8def\\u5f84\\u3002Claude Code for VS Code \\u6269\\u5c55\\u53ea\\u80fd\\u505a handoff\\uff0c\\u4e0d\u80fd\u4ee3\u66ff CLI task provider\u3002",
        "en": "If the provider reports ENOENT, enter the absolute path to the selected CLI. Claude Code for VS Code is handoff-only and does not replace a CLI task provider."
      },
      note3: {
        "zh-CN": "\\u70b9\\u51fb\\u201c\\u4fdd\\u5b58\\u5e76\\u8fde\\u63a5\\u201d\\u540e\\u4f1a\\u7acb\\u5373\\u8fde\\u63a5\\uff0c\\u4e0a\\u9762\\u7684 auto-connect \\u5f00\\u5173\\u53ea\\u63a7\\u5236\\u4e0b\\u6b21\\u542f\\u52a8\\u6216\\u91cd\\u8f7d\\u65f6\\u662f\\u5426\\u81ea\\u52a8\\u8fde\\u63a5\\u3002",
        "en": "Click Save and Connect to connect immediately. The auto-connect switch above only controls whether startup or reload also connects automatically."
      },
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
        autoConnect: document.getElementById("autoConnect").checked,
        displayName: document.getElementById("displayName").value,
        providerEnabled: document.getElementById("providerEnabled").checked,
        providerKind: document.getElementById("providerKind").value,
        providerCodexPath: document.getElementById("providerCodexPath").value,
        providerCodexModel: document.getElementById("providerCodexModel").value,
        providerClaudePath: document.getElementById("providerClaudePath").value,
        providerClaudeModel: document.getElementById("providerClaudeModel").value,
        providerFallbackToAlternate: document.getElementById("providerFallbackToAlternate").checked,
        providerPolicyLevel: document.getElementById("providerPolicyLevel").value,
        providerDisableFeatures: document.getElementById("providerDisableFeatures").value,
        providerSandboxMode: document.getElementById("providerSandboxMode").value,
        tasksDefaultTimeoutMs: document.getElementById("tasksDefaultTimeoutMs").value,
        tasksHistoryLimit: document.getElementById("tasksHistoryLimit").value,
        locale: state.locale,
      };
    }
    document.getElementById("saveAndConnect").addEventListener("click", () => {
      showError("");
      vscode.postMessage({ type: "saveAndConnect", data: getData() });
    });
    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "error") {
        showError(msg.error || tr("unknownError"));
      }
    });
    applyCopy();
  </script>
</body>
</html>`;
}
