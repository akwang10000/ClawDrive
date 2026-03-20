import * as vscode from "vscode";
import { getConfig } from "./config";

interface SettingsData {
  gatewayHost: string;
  gatewayPort: number;
  gatewayTls: boolean;
  gatewayToken: string;
  displayName: string;
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
    "ClawDrive Settings",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
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
        vscode.window.showInformationMessage("ClawDrive settings saved.");
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
      panel?.webview.postMessage({ type: "error", error: messageText });
      void vscode.window.showErrorMessage(messageText);
    }
  });

  panel.onDidDispose(() => {
    panel = null;
  });
}

function parseSettingsInput(value: unknown): SettingsData {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid settings payload.");
  }

  const data = value as Record<string, unknown>;
  const gatewayHost = typeof data.gatewayHost === "string" ? data.gatewayHost.trim() : "";
  const gatewayToken = typeof data.gatewayToken === "string" ? data.gatewayToken.trim() : "";
  const displayName = typeof data.displayName === "string" ? data.displayName.trim() : "";
  const gatewayPortRaw = typeof data.gatewayPort === "string" || typeof data.gatewayPort === "number"
    ? Number(data.gatewayPort)
    : Number.NaN;

  if (!gatewayHost) {
    throw new Error("Gateway host is required.");
  }
  if (!Number.isFinite(gatewayPortRaw) || gatewayPortRaw <= 0 || gatewayPortRaw > 65535) {
    throw new Error("Gateway port must be between 1 and 65535.");
  }
  if (!displayName) {
    throw new Error("Display name is required.");
  }

  return {
    gatewayHost,
    gatewayPort: Math.trunc(gatewayPortRaw),
    gatewayTls: Boolean(data.gatewayTls),
    gatewayToken,
    displayName,
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
    }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 24px;
    }
    .wrap {
      max-width: 760px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 22px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .card {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 10px;
      padding: 18px;
      background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-button-background) 12%);
      margin-bottom: 18px;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 14px;
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
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-input-border, #555);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px 0 0;
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
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 8px;
      padding: 12px;
      margin-top: 14px;
      line-height: 1.6;
      font-size: 13px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    button {
      border: none;
      border-radius: 6px;
      padding: 9px 16px;
      cursor: pointer;
      font: inherit;
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
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 18px;
    }
    code {
      background: color-mix(in srgb, var(--vscode-editor-background) 65%, var(--vscode-textCodeBlock-background, #333) 35%);
      padding: 2px 6px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>ClawDrive Settings</h1>
    <div class="sub">配置 ClawDrive 与现有 OpenClaw Gateway 的连接。Phase 1 只覆盖真实联调所需的最小配置。</div>
    <div id="error" class="error"></div>

    <div class="card">
      <div class="title">Gateway</div>
      <div class="field">
        <label for="gatewayHost">Host</label>
        <input id="gatewayHost" type="text" value="${escapeHtml(data.gatewayHost)}" placeholder="127.0.0.1">
        <div class="hint">本地 Gateway 默认使用 <code>127.0.0.1</code>。</div>
      </div>
      <div class="field">
        <label for="gatewayPort">Port</label>
        <input id="gatewayPort" type="number" value="${data.gatewayPort}" placeholder="18789">
      </div>
      <div class="field">
        <label for="gatewayToken">Token</label>
        <input id="gatewayToken" type="password" value="${escapeHtml(data.gatewayToken)}" placeholder="gateway.auth.token">
        <div class="hint">本地 OpenClaw 通常从 <code>~/.openclaw/openclaw.json</code> 的 <code>gateway.auth.token</code> 获取。</div>
      </div>
      <div class="row">
        <input id="gatewayTls" type="checkbox" ${data.gatewayTls ? "checked" : ""}>
        <label for="gatewayTls">Use TLS (wss://)</label>
      </div>
      <div class="hint">大多数本地 Gateway 使用 <code>ws://127.0.0.1:18789</code>，通常不需要开启 TLS。</div>
    </div>

    <div class="card">
      <div class="title">Node</div>
      <div class="field">
        <label for="displayName">Display Name</label>
        <input id="displayName" type="text" value="${escapeHtml(data.displayName)}" placeholder="ClawDrive">
        <div class="hint">这是节点在 Gateway 中显示的名字。</div>
      </div>
      <div class="notice">
        如果 Gateway 开启了 <code>gateway.nodes.allowCommands</code>，请确认其中至少包含 <code>vscode.workspace.info</code>，否则会出现“已连接但不可调用”。
      </div>
    </div>

    <div class="actions">
      <button class="primary" id="save">保存设置</button>
      <button class="secondary" id="saveAndConnect">保存并连接</button>
      <button class="secondary" id="diagnose">运行诊断</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

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

    document.getElementById("diagnose").addEventListener("click", () => {
      vscode.postMessage({ type: "diagnose" });
    });

    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "error") {
        showError(msg.error || "Unknown error");
      }
    });
  </script>
</body>
</html>`;
}
