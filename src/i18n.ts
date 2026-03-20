import * as vscode from "vscode";

export type SupportedLocale = "zh-CN" | "en";

type Dict = Record<string, string>;

const zhCN: Dict = {
  "app.dashboard": "ClawDrive 控制台",
  "app.settings": "ClawDrive 设置",
  "status.connected": "已连接",
  "status.disconnected": "未连接",
  "status.connecting": "连接中",
  "status.ready": "就绪",
  "status.blocked": "受限",
  "status.notReady": "未接入",
  "status.yes": "是",
  "status.no": "否",
  "statusBar.connection": "连接状态：{0}",
  "statusBar.callable": "可调用：{0}",
  "statusBar.provider": "Provider 状态：{0}",
  "notify.settingsSaved": "ClawDrive 设置已保存。",
  "notify.statusWritten": "ClawDrive 状态已写入输出日志。",
  "notify.diagnosisSummary": "诊断完成：{0} 个错误，{1} 个警告。",
  "notify.openLog": "打开日志",
  "error.invalidSettingsPayload": "设置数据无效。",
  "error.gatewayHostRequired": "必须填写 Gateway host。",
  "error.gatewayPortRange": "Gateway port 必须在 1 到 65535 之间。",
  "error.displayNameRequired": "必须填写显示名称。",
  "diagnosis.title": "=== ClawDrive 连接诊断 ===",
  "diagnosis.ok": "OK",
  "diagnosis.info": "信息",
  "diagnosis.warn": "警告",
  "diagnosis.error": "错误",
  "diagnosis.gatewayConfigured": "当前 Gateway：{0}",
  "diagnosis.tokenConfigured": "Gateway token 已配置。",
  "diagnosis.tokenMissing": "Gateway token 为空。",
  "diagnosis.tokenMissingDetail": "请先设置 clawdrive.gateway.token，再连接受保护的 Gateway。",
  "diagnosis.commandsReady": "已广告命令面：{0}",
  "diagnosis.commandsEmpty": "广告命令面为空。",
  "diagnosis.loopbackTlsWarn": "当前对本地 loopback Gateway 启用了 TLS。",
  "diagnosis.loopbackTlsWarnDetail": "大多数本地 OpenClaw Gateway 使用 ws://127.0.0.1:18789，而不是 TLS。",
  "diagnosis.gatewayReachable": "Gateway TCP 端口可达。",
  "diagnosis.gatewayUnreachable": "无法连接到 {0}:{1}。",
  "diagnosis.localConfigMissing": "未在 ~/.openclaw/openclaw.json 找到本地 OpenClaw 配置。",
  "diagnosis.localConfigLoaded": "已读取本地 OpenClaw 配置：{0}",
  "diagnosis.tokenMismatch": "当前 Gateway token 与本地 OpenClaw token 不一致。",
  "diagnosis.tokenMismatchDetail": "如果这是本地 Gateway，请复制 ~/.openclaw/openclaw.json 中的 gateway.auth.token。",
  "diagnosis.allowCommandsBlocked": "本地 allowCommands 可能阻止 vscode.workspace.info。",
  "diagnosis.allowCommandsBlockedDetail": "在 allowCommands 中加入 vscode.workspace.info 后，connected but not callable 风险才会消失。",
  "diagnosis.localConfigReadFailed": "读取本地 OpenClaw 配置失败。",
  "diagnosis.remoteGateway": "当前是远端 Gateway，已跳过本地配置检查。",
  "diagnosis.sessionState": "当前会话状态：{0}",
  "diagnosis.sessionStateDetail": "执行 ClawDrive: Connect 以建立 Gateway 会话。",
  "diagnosis.callableState": "当前可调用状态：{0}",
  "diagnosis.callableStateDetail": "请检查 allowCommands，并确认当前广告命令面已被允许。",
  "diagnosis.provider": "Provider 状态：Phase 1 尚未实现。",
  "showStatus.displayName": "显示名称：{0}",
  "showStatus.gateway": "Gateway：{0}",
  "showStatus.connected": "已连接：{0}",
  "showStatus.callable": "可调用：{0}",
  "showStatus.provider": "Provider 状态：{0}",
  "showStatus.commands": "命令面：{0}",
  "log.activating": "正在激活 ClawDrive for VS Code",
  "log.startClient": "正在启动 Gateway 客户端：{0}:{1}",
  "log.stopClient": "Gateway 客户端已停止",
  "log.showStatus": "正在输出 ClawDrive 状态"
};

const en: Dict = {
  "app.dashboard": "ClawDrive Dashboard",
  "app.settings": "ClawDrive Settings",
  "status.connected": "Connected",
  "status.disconnected": "Disconnected",
  "status.connecting": "Connecting",
  "status.ready": "Ready",
  "status.blocked": "Blocked",
  "status.notReady": "Not Ready",
  "status.yes": "Yes",
  "status.no": "No",
  "statusBar.connection": "Connection: {0}",
  "statusBar.callable": "Callable: {0}",
  "statusBar.provider": "Provider Status: {0}",
  "notify.settingsSaved": "ClawDrive settings saved.",
  "notify.statusWritten": "ClawDrive status written to the output channel.",
  "notify.diagnosisSummary": "Diagnosis complete: {0} error(s), {1} warning(s).",
  "notify.openLog": "Open Log",
  "error.invalidSettingsPayload": "Invalid settings payload.",
  "error.gatewayHostRequired": "Gateway host is required.",
  "error.gatewayPortRange": "Gateway port must be between 1 and 65535.",
  "error.displayNameRequired": "Display name is required.",
  "diagnosis.title": "=== ClawDrive Connection Diagnosis ===",
  "diagnosis.ok": "OK",
  "diagnosis.info": "INFO",
  "diagnosis.warn": "WARN",
  "diagnosis.error": "ERROR",
  "diagnosis.gatewayConfigured": "Configured gateway: {0}",
  "diagnosis.tokenConfigured": "Gateway token is configured.",
  "diagnosis.tokenMissing": "Gateway token is empty.",
  "diagnosis.tokenMissingDetail": "Set clawdrive.gateway.token before connecting to a protected Gateway.",
  "diagnosis.commandsReady": "Advertised command surface is ready ({0}).",
  "diagnosis.commandsEmpty": "Advertised command surface is empty.",
  "diagnosis.loopbackTlsWarn": "TLS is enabled for a loopback Gateway host.",
  "diagnosis.loopbackTlsWarnDetail": "Most local OpenClaw gateways use ws://127.0.0.1:18789 rather than TLS.",
  "diagnosis.gatewayReachable": "Gateway TCP port is reachable.",
  "diagnosis.gatewayUnreachable": "Cannot reach {0}:{1}.",
  "diagnosis.localConfigMissing": "Local OpenClaw config was not found at ~/.openclaw/openclaw.json.",
  "diagnosis.localConfigLoaded": "Loaded local OpenClaw config from {0}.",
  "diagnosis.tokenMismatch": "Configured Gateway token does not match the local OpenClaw token.",
  "diagnosis.tokenMismatchDetail": "Copy gateway.auth.token from ~/.openclaw/openclaw.json if this is your local Gateway.",
  "diagnosis.allowCommandsBlocked": "Local allowCommands may block vscode.workspace.info.",
  "diagnosis.allowCommandsBlockedDetail": "Connected but not callable is likely until vscode.workspace.info is included.",
  "diagnosis.localConfigReadFailed": "Could not read the local OpenClaw config for diagnosis.",
  "diagnosis.remoteGateway": "Remote Gateway host detected; local config checks were skipped.",
  "diagnosis.sessionState": "Current session state: {0}",
  "diagnosis.sessionStateDetail": "Run ClawDrive: Connect to establish a Gateway session.",
  "diagnosis.callableState": "Current callable state: {0}",
  "diagnosis.callableStateDetail": "Check local allowCommands and confirm the advertised command surface is permitted.",
  "diagnosis.provider": "Provider status: not implemented in Phase 1.",
  "showStatus.displayName": "Display name: {0}",
  "showStatus.gateway": "Gateway: {0}",
  "showStatus.connected": "Connected: {0}",
  "showStatus.callable": "Callable: {0}",
  "showStatus.provider": "Provider status: {0}",
  "showStatus.commands": "Commands: {0}",
  "log.activating": "Activating ClawDrive for VS Code",
  "log.startClient": "Starting Gateway client for {0}:{1}",
  "log.stopClient": "Gateway client stopped",
  "log.showStatus": "Showing ClawDrive status"
};

export function getCurrentLocale(): SupportedLocale {
  return vscode.env.language.trim().toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

export function getWebviewLocales(): Record<SupportedLocale, Dict> {
  return {
    "zh-CN": zhCN,
    en,
  };
}

export function t(key: string, ...args: Array<string | number>): string {
  const locale = getCurrentLocale();
  const source = locale === "en" ? en : zhCN;
  let template = source[key] ?? zhCN[key] ?? en[key] ?? key;
  for (const [index, arg] of args.entries()) {
    template = template.replaceAll(`{${index}}`, String(arg));
  }
  return template;
}
