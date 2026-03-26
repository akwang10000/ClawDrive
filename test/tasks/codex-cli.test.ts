import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  classifyCodexCliFailure,
  classifyCodexRuntimeSignal,
  detectCodexCliCapabilities,
  sanitizeCodexConfig,
  validateCodexExecutablePath,
  type CodexCliCapabilities,
} from "../../src/tasks/codex-cli";

const fullCapabilities: CodexCliCapabilities = {
  supportsAskForApproval: true,
  supportsOutputSchema: true,
  supportsOutputLastMessage: true,
  supportsResumeOutputLastMessage: true,
};

test("validateCodexExecutablePath accepts bare names and absolute paths", () => {
  assert.doesNotThrow(() => validateCodexExecutablePath("codex"));
  assert.doesNotThrow(() => validateCodexExecutablePath("C:\\tools\\codex.exe"));
});

test("validateCodexExecutablePath rejects shell-like fragments", () => {
  assert.throws(() => validateCodexExecutablePath("codex --help"));
  assert.throws(() => validateCodexExecutablePath("codex && echo hi"));
});

test("detectCodexCliCapabilities parses help output", () => {
  const capabilities = detectCodexCliCapabilities(
    "Usage: codex [OPTIONS]\n  -a, --ask-for-approval <APPROVAL_POLICY>",
    "Usage: codex exec [OPTIONS]\n      --output-schema <FILE>\n  -o, --output-last-message <FILE>",
    "Usage: codex exec resume [OPTIONS]\n  -o, --output-last-message <FILE>"
  );
  assert.deepEqual(capabilities, fullCapabilities);
});

test("buildCodexExecArgs includes compatible flags for schema mode", () => {
  const args = buildCodexExecArgs({
    workspacePath: "H:\\workspace\\clawdrive-vscode",
    model: "gpt-5.4",
    prompt: "Explain this repository.",
    schemaPath: "C:\\temp\\schema.json",
    capabilities: fullCapabilities,
  });

  assert.deepEqual(args, [
    "--ask-for-approval",
    "never",
    "-c",
    "shell_environment_policy.inherit=all",
    "-C",
    "H:\\workspace\\clawdrive-vscode",
    "-m",
    "gpt-5.4",
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--output-schema",
    "C:\\temp\\schema.json",
    "Explain this repository.",
  ]);
});

test("buildCodexResumeArgs falls back cleanly when only output-last-message is supported", () => {
  const args = buildCodexResumeArgs({
    workspacePath: null,
    sessionId: "session-1",
    prompt: "Continue.",
    outputPath: "C:\\temp\\resume.txt",
    capabilities: {
      supportsAskForApproval: false,
      supportsOutputSchema: false,
      supportsOutputLastMessage: false,
      supportsResumeOutputLastMessage: true,
    },
  });

  assert.deepEqual(args, [
    "-c",
    "shell_environment_policy.inherit=all",
    "exec",
    "resume",
    "--json",
    "--skip-git-repo-check",
    "--output-last-message",
    "C:\\temp\\resume.txt",
    "session-1",
    "Continue.",
  ]);
});

test("classifyCodexCliFailure maps common provider failures to stable codes", () => {
  assert.deepEqual(classifyCodexCliFailure(new Error("spawn codex ENOENT")), {
    code: "PROVIDER_EXECUTABLE_MISSING",
    message: "Codex executable was not found. Check clawdrive.provider.codex.path and local installation.",
  });
  assert.deepEqual(
    classifyCodexCliFailure(new Error('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))')),
    {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while talking to a downstream service. Check external MCP or model-provider compatibility.",
    }
  );
  assert.deepEqual(classifyCodexCliFailure(new Error("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header")), {
    code: "PROVIDER_AUTH_FAILED",
    message: "Codex could not authenticate with the configured upstream model provider.",
  });
  assert.deepEqual(classifyCodexCliFailure(new Error("HTTP error: 500 Internal Server Error")), {
    code: "PROVIDER_UPSTREAM_UNAVAILABLE",
    message: "The upstream model provider is currently unavailable or unstable.",
  });
  assert.deepEqual(classifyCodexCliFailure(new Error("rejected: blocked by policy")), {
    code: "PROVIDER_COMMAND_POLICY_BLOCKED",
    message:
      "Codex tried to run a shell probe, but its execution policy blocked the command. Retry with a narrower prompt or continue without shell exploration.",
  });
  assert.deepEqual(classifyCodexCliFailure(new Error("unexpected argument '--output-schema' found")), {
    code: "PROVIDER_CLI_ARGS_UNSUPPORTED",
    message: "The installed Codex CLI does not support one or more arguments required by this provider.",
  });
  assert.deepEqual(
    classifyCodexCliFailure(new Error("Codex turn completed but no final result arrived before provider finalization timeout.")),
    {
      code: "PROVIDER_FINALIZATION_STALLED",
      message: "Codex finished its turn but never delivered the final result payload.",
    }
  );
  assert.deepEqual(classifyCodexCliFailure(new Error("Codex task stalled after turn start without producing a usable result.")), {
    code: "PROVIDER_RESULT_STALLED",
    message: "Codex started the task but stopped making usable progress before producing a result.",
  });
  assert.deepEqual(classifyCodexCliFailure(new Error("Codex returned an unusable plan result. Unexpected token x")), {
    code: "PROVIDER_OUTPUT_INVALID",
    message: "Codex returned output that could not be parsed as the expected JSON result.",
  });
});

test("classifyCodexRuntimeSignal recognizes warning, degraded, and fatal patterns", () => {
  assert.deepEqual(
    classifyCodexRuntimeSignal("WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell"),
    {
      code: "PROVIDER_SHELL_SNAPSHOT_WARNING",
      severity: "noise",
      summary: "Provider shell snapshot support is unavailable for this shell.",
      detail: "WARN codex_core::shell_snapshot: Failed to create shell snapshot for powershell",
    }
  );
  assert.deepEqual(
    classifyCodexRuntimeSignal("WARN codex_core::client: falling back to HTTP"),
    {
      code: "PROVIDER_TRANSPORT_FALLBACK",
      severity: "degraded",
      summary: "Provider transport fell back to a slower or narrower runtime path.",
      detail: "WARN codex_core::client: falling back to HTTP",
    }
  );
  assert.deepEqual(
    classifyCodexRuntimeSignal("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"),
    {
      code: "PROVIDER_AUTH_FAILED",
      severity: "fatal",
      summary: "Provider authentication failed while contacting the upstream model service.",
      detail: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    }
  );
});

test("sanitizeCodexConfig removes mcp server sections and keeps model config", () => {
  const raw = [
    'model_provider = "proxy"',
    'model = "gpt-5.4"',
    "",
    "[mcp_servers.unityMCP]",
    'url = "http://127.0.0.1:8080/mcp"',
    "",
    "[features]",
    "multi_agent = true",
    "",
    "[model_providers.proxy]",
    'name = "MyCodex"',
  ].join("\n");

  assert.equal(
    sanitizeCodexConfig(raw),
    [
      'model_provider = "proxy"',
      'model = "gpt-5.4"',
      "",
      "[features]",
      "multi_agent = true",
      "",
      "[model_providers.proxy]",
      'name = "MyCodex"',
      "",
    ].join("\n")
  );
});
