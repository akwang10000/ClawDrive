import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeVsCodeUriHandoff } from "../src/claude-vscode-handoff";
import { setVscodeExtensions, setVscodeOpenExternal } from "./test-utils";

test("ClaudeVsCodeUriHandoff opens the documented Claude Code URI when the extension is installed", async () => {
  setVscodeExtensions({ "anthropic.claude-code": { id: "anthropic.claude-code" } });
  let openedUri = "";
  setVscodeOpenExternal(async (uri) => {
    openedUri = uri.toString();
    return true;
  });

  const handoff = new ClaudeVsCodeUriHandoff();
  const result = await handoff.openPrompt({ prompt: "Review the repository structure." });

  assert.equal(result.ok, true);
  assert.match(openedUri, /^vscode:\/\/anthropic\.claude-code\/open\?/i);
  assert.match(openedUri, /prompt=Review\+the\+repository\+structure\./i);
  assert.equal(result.autoSubmitted, false);
});

test("ClaudeVsCodeUriHandoff reports a missing extension clearly", async () => {
  setVscodeExtensions({});
  setVscodeOpenExternal(async () => {
    throw new Error("should not be called");
  });

  const handoff = new ClaudeVsCodeUriHandoff();
  const result = await handoff.openPrompt({ prompt: "Review the repository structure." });

  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.code, "CLAUDE_VSCODE_NOT_INSTALLED");
  assert.match(result.message, /not installed/i);
});
