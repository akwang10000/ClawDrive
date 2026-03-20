import * as vscode from "vscode";

export interface DashboardSnapshot {
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
    "ClawDrive Dashboard",
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
      panel?.webview.postMessage({ type: "error", error: messageText });
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
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ClawDrive Dashboard</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 24px;
      font-family: var(--vscode-font-family);
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
    }
    .wrap {
      max-width: 980px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
    }
    .sub {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
      line-height: 1.6;
    }
    .grid {
      display: grid;
      grid-template-columns: 1.2fr 1fr;
      gap: 18px;
    }
    .card {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 12px;
      padding: 18px;
      background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-button-background) 10%);
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: 14px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat {
      border: 1px solid var(--vscode-widget-border, #444);
      border-radius: 10px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-sideBar-background) 18%);
    }
    .label {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-bottom: 6px;
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
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border, #444) 55%, transparent);
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
      border-radius: 8px;
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
    .cmds {
      margin: 0;
      padding-left: 18px;
      line-height: 1.8;
    }
    .error {
      display: none;
      margin-bottom: 18px;
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--vscode-errorForeground, #f14c4c);
    }
    code {
      background: color-mix(in srgb, var(--vscode-editor-background) 65%, var(--vscode-textCodeBlock-background, #333) 35%);
      padding: 2px 6px;
      border-radius: 4px;
    }
    @media (max-width: 840px) {
      .grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr; }
      .actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>ClawDrive Dashboard</h1>
    <div class="sub">把 Phase 1 的常用功能集中到一个图形界面里，方便连接、配置和诊断。</div>
    <div id="error" class="error"></div>

    <div class="grid">
      <div class="card">
        <div class="title">Runtime Overview</div>
        <div class="stats">
          <div class="stat">
            <div class="label">Connection</div>
            <div class="value" id="connectedValue">-</div>
          </div>
          <div class="stat">
            <div class="label">Callable</div>
            <div class="value" id="callableValue">-</div>
          </div>
          <div class="stat">
            <div class="label">Provider Ready</div>
            <div class="value" id="providerValue">-</div>
          </div>
        </div>
        <div class="row"><div class="key">Display Name</div><div id="displayName">-</div></div>
        <div class="row"><div class="key">Gateway</div><div id="gatewayUrl">-</div></div>
        <div class="row"><div class="key">Remote Commands</div><div id="commandCount">-</div></div>
      </div>

      <div class="card">
        <div class="title">Quick Actions</div>
        <div class="actions">
          <button class="primary" id="connect">Connect</button>
          <button class="secondary" id="disconnect">Disconnect</button>
          <button class="secondary" id="settings">Open Settings</button>
          <button class="secondary" id="diagnose">Run Diagnosis</button>
          <button class="secondary" id="status">Show Status</button>
          <button class="secondary" id="log">Open Log</button>
        </div>
      </div>

      <div class="card">
        <div class="title">Remote Command Surface</div>
        <ul id="commands" class="cmds">
          <li class="muted">No commands advertised</li>
        </ul>
      </div>

      <div class="card">
        <div class="title">Phase 1 Notes</div>
        <div class="row"><div class="key">Current scope</div><div>Gateway + <code>vscode.workspace.info</code></div></div>
        <div class="row"><div class="key">OpenClaw changes</div><div>None required</div></div>
        <div class="row"><div class="key">Typical failure</div><div><code>allowCommands</code> missing <code>vscode.workspace.info</code></div></div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function showError(message) {
      const box = document.getElementById("error");
      box.textContent = message || "";
      box.style.display = message ? "block" : "none";
    }

    function formatBool(value, yesText = "Yes", noText = "No") {
      return value ? yesText : noText;
    }

    function setStatus(id, value, cssClass) {
      const el = document.getElementById(id);
      el.textContent = value;
      el.className = "value " + cssClass;
    }

    function renderSnapshot(snapshot) {
      setStatus("connectedValue", formatBool(snapshot.connected, "Connected", "Disconnected"), snapshot.connected ? "ok" : "warn");
      setStatus("callableValue", formatBool(snapshot.callable, "Ready", "Blocked"), snapshot.callable ? "ok" : "warn");
      setStatus("providerValue", formatBool(snapshot.providerReady, "Ready", "Not Ready"), snapshot.providerReady ? "ok" : "muted");
      document.getElementById("displayName").textContent = snapshot.displayName;
      document.getElementById("gatewayUrl").textContent = snapshot.gatewayUrl;
      document.getElementById("commandCount").textContent = String((snapshot.commands || []).length);

      const list = document.getElementById("commands");
      list.innerHTML = "";
      if (!snapshot.commands || !snapshot.commands.length) {
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = "No commands advertised";
        list.appendChild(li);
        return;
      }
      snapshot.commands.forEach((command) => {
        const li = document.createElement("li");
        li.textContent = command;
        list.appendChild(li);
      });
    }

    document.getElementById("connect").addEventListener("click", () => vscode.postMessage({ type: "connect" }));
    document.getElementById("disconnect").addEventListener("click", () => vscode.postMessage({ type: "disconnect" }));
    document.getElementById("settings").addEventListener("click", () => vscode.postMessage({ type: "settings" }));
    document.getElementById("diagnose").addEventListener("click", () => vscode.postMessage({ type: "diagnose" }));
    document.getElementById("status").addEventListener("click", () => vscode.postMessage({ type: "status" }));
    document.getElementById("log").addEventListener("click", () => vscode.postMessage({ type: "log" }));

    window.addEventListener("message", (event) => {
      const msg = event.data || {};
      if (msg.type === "snapshot") {
        showError("");
        renderSnapshot(msg.snapshot);
      }
      if (msg.type === "error") {
        showError(msg.error || "Unknown error");
      }
    });

    vscode.postMessage({ type: "refresh" });
  </script>
</body>
</html>`;
}
