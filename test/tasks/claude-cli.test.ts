import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeExecArgs,
  buildClaudeResumeArgs,
  classifyClaudeCliFailure,
  classifyClaudeRuntimeSignal,
  detectClaudeCliCapabilities,
  validateClaudeExecutablePath,
  type ClaudeCliCapabilities,
} from "../../src/tasks/claude-cli";

const fullCapabilities: ClaudeCliCapabilities = {
  supportsBare: true,
  supportsPrint: true,
  supportsOutputFormat: true,
  supportsJsonSchema: true,
  supportsResume: true,
  supportsModel: true,
  supportsPermissionMode: true,
};

test("validateClaudeExecutablePath accepts bare names and absolute paths", () => {
  assert.doesNotThrow(() => validateClaudeExecutablePath("claude"));
  assert.doesNotThrow(() => validateClaudeExecutablePath("C:\\tools\\claude.exe"));
});

test("validateClaudeExecutablePath rejects shell-like fragments", () => {
  assert.throws(() => validateClaudeExecutablePath("claude --help"));
  assert.throws(() => validateClaudeExecutablePath("claude && echo hi"));
});

test("detectClaudeCliCapabilities parses help output", () => {
  const capabilities = detectClaudeCliCapabilities(
    [
      "Usage: claude [options]",
      "--bare",
      "--print",
      "--output-format",
      "--json-schema",
      "--resume",
      "--model",
      "--permission-mode",
    ].join("\n")
  );

  assert.deepEqual(capabilities, fullCapabilities);
});

test("buildClaudeExecArgs includes modern headless flags", () => {
  const args = buildClaudeExecArgs({
    prompt: "Explain this repository.",
    model: "sonnet",
    schema: '{"type":"object"}',
    capabilities: fullCapabilities,
  });

  assert.deepEqual(args, [
    "--bare",
    "--permission-mode",
    "plan",
    "--model",
    "sonnet",
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    '{"type":"object"}',
    "Explain this repository.",
  ]);
});

test("buildClaudeExecArgs can disable permission mode", () => {
  const args = buildClaudeExecArgs({
    prompt: "Explain this repository.",
    model: "sonnet",
    capabilities: fullCapabilities,
    permissionModePlan: false,
  });

  assert.deepEqual(args, ["--bare", "--model", "sonnet", "-p", "--output-format", "json", "Explain this repository."]);
});

test("buildClaudeExecArgs can disable print mode", () => {
  const args = buildClaudeExecArgs({
    prompt: "Explain this repository.",
    model: "sonnet",
    capabilities: fullCapabilities,
    printPrompt: false,
  });

  assert.deepEqual(args, ["--bare", "--permission-mode", "plan", "--model", "sonnet", "--output-format", "json", "Explain this repository."]);
});

test("buildClaudeResumeArgs includes resume session id", () => {
  const args = buildClaudeResumeArgs({
    sessionId: "session-1",
    prompt: "Continue.",
    capabilities: fullCapabilities,
  });

  assert.deepEqual(args, [
    "--resume",
    "session-1",
    "--bare",
    "--permission-mode",
    "plan",
    "-p",
    "--output-format",
    "json",
    "Continue.",
  ]);
});

test("classifyClaudeCliFailure maps common provider failures to stable codes", () => {
  assert.deepEqual(classifyClaudeCliFailure(new Error("spawn claude ENOENT")), {
    code: "PROVIDER_EXECUTABLE_MISSING",
    message:
      "Claude Code CLI executable was not found. Check clawdrive.provider.claude.path and local installation. Claude Code for VS Code alone does not satisfy background provider tasks.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("401 Unauthorized: invalid api key")), {
    code: "PROVIDER_AUTH_FAILED",
    message: "Claude Code could not authenticate with the configured upstream model provider.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("No authentication found")), {
    code: "PROVIDER_AUTH_FAILED",
    message: "Claude Code could not authenticate with the configured upstream model provider.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("Auth error: No API key available")), {
    code: "PROVIDER_AUTH_FAILED",
    message: "Claude Code could not authenticate with the configured upstream model provider.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("HTTP error: 500 Internal Server Error")), {
    code: "PROVIDER_UPSTREAM_UNAVAILABLE",
    message: "The upstream model provider is currently unavailable or unstable.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("invalid model: claude-haiku-4-5-20251001")), {
    code: "PROVIDER_MODEL_INVALID",
    message: "The configured Claude model is invalid or unavailable. Check clawdrive.provider.claude.model.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("unsupported model 'abc'")), {
    code: "PROVIDER_MODEL_INVALID",
    message: "The configured Claude model is invalid or unavailable. Check clawdrive.provider.claude.model.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error('MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found')), {
    code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
    message: "Claude Code could not use the configured MCP tools. Check claude-vscode MCP compatibility and tool registration.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("unexpected argument '--json-schema' found")), {
    code: "PROVIDER_CLI_ARGS_UNSUPPORTED",
    message: "The installed Claude Code CLI does not support one or more arguments required by this provider.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("socket hang up while reading result stream")), {
    code: "PROVIDER_TRANSPORT_FAILED",
    message:
      "Claude Code transport failed while talking to a downstream service. Check relay, MCP, or provider compatibility.",
  });
  assert.deepEqual(classifyClaudeCliFailure(new Error("Claude stalled after turn start without producing provider activity.")), {
    code: "PROVIDER_RESULT_STALLED",
    message: "Claude Code stalled after turn start without producing a usable result.",
  });
});


test("classifyClaudeCliFailure maps structured output retry exhaustion to invalid output", () => {
  assert.deepEqual(classifyClaudeCliFailure(new Error("error_max_structured_output_retries")), {
    code: "PROVIDER_OUTPUT_INVALID",
    message: "Claude Code could not satisfy the required structured output contract for this task.",
  });
});

test("classifyClaudeRuntimeSignal recognizes transport, auth, model, and MCP patterns", () => {
  assert.deepEqual(classifyClaudeRuntimeSignal("socket hang up while reading result stream"), {
    code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
    severity: "degraded",
    summary: "Provider transport reported a downstream connectivity problem.",
    detail: "socket hang up while reading result stream",
  });
  assert.deepEqual(classifyClaudeRuntimeSignal("401 Unauthorized: invalid api key"), {
    code: "PROVIDER_AUTH_FAILED",
    severity: "fatal",
    summary: "Provider authentication failed while contacting the upstream model service.",
    detail: "401 Unauthorized: invalid api key",
  });
  assert.deepEqual(classifyClaudeRuntimeSignal("No authentication found"), {
    code: "PROVIDER_AUTH_FAILED",
    severity: "fatal",
    summary: "Provider authentication failed while contacting the upstream model service.",
    detail: "No authentication found",
  });
  assert.deepEqual(classifyClaudeRuntimeSignal("invalid model: claude-haiku-4-5-20251001"), {
    code: "PROVIDER_MODEL_INVALID",
    severity: "fatal",
    summary: "Provider model configuration is invalid or unavailable.",
    detail: "invalid model: claude-haiku-4-5-20251001",
  });
  assert.deepEqual(classifyClaudeRuntimeSignal('MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found'), {
    code: "PROVIDER_MCP_COMPATIBILITY_FAILED",
    severity: "fatal",
    summary: "Provider MCP compatibility failed while fetching tools or invoking methods.",
    detail: 'MCP server "claude-vscode" Failed to fetch tools: MCP error -32601: Method not found',
  });
});
