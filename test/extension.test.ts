import test from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { activate } from "../src/extension";
import {
  clearRegisteredVscodeCommands,
  getRegisteredVscodeCommands,
  makeExtensionContext,
  makeTempDir,
  setVscodeExtensions,
  setVscodeOpenExternal,
  setWorkspaceRoot,
} from "./test-utils";

test("activate registers and executes the Claude Code handoff command", async () => {
  clearRegisteredVscodeCommands();
  const rootPath = await makeTempDir("clawdrive-extension-claude-handoff");
  setWorkspaceRoot(rootPath);
  setVscodeExtensions({ "anthropic.claude-code": { id: "anthropic.claude-code" } });

  let openedUri = "";
  setVscodeOpenExternal(async (uri) => {
    openedUri = uri.toString();
    return true;
  });

  const context = makeExtensionContext(rootPath) as vscode.ExtensionContext & { subscriptions: vscode.Disposable[] };
  context.subscriptions = [];

  await activate(context);

  assert.ok(getRegisteredVscodeCommands().includes("clawdrive.openInClaudeCode"));
  await vscode.commands.executeCommand("clawdrive.openInClaudeCode");

  assert.match(openedUri, /^vscode:\/\/anthropic\.claude-code\/open\?/i);
  assert.match(openedUri, /prompt=/i);

  for (const subscription of context.subscriptions) {
    subscription.dispose();
  }
});
