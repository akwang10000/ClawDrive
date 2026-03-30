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
    "-c",
    "windows.sandbox=unelevated",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.shell_snapshot=false",
    "-C",
    "H:\\workspace\\clawdrive-vscode",
    "-m",
    "gpt-5.4",
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--output-schema",
    "C:\\temp\\schema.json",
    "Explain this repository.",
  ]);
});

test("buildCodexExecArgs allows custom sandbox modes", () => {
  const args = buildCodexExecArgs({
    workspacePath: null,
    prompt: "Output exactly: OK",
    sandboxMode: "workspace-write",
    capabilities: fullCapabilities,
  });

  const sandboxIndex = args.findIndex((value) => value === "--sandbox");
  assert.ok(sandboxIndex >= 0);
  assert.equal(args[sandboxIndex + 1], "workspace-write");
});

test("buildCodexExecArgs allows task startup features to remain enabled when disableFeatures is empty", () => {
  const args = buildCodexExecArgs({
    workspacePath: null,
    prompt: "Output exactly: OK",
    disabledFeatures: [],
    capabilities: fullCapabilities,
  });

  assert.ok(!args.some((value) => /^features\./.test(value)));
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
    "-c",
    "windows.sandbox=unelevated",
    "-c",
    "features.multi_agent=false",
    "-c",
    "features.plugins=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.shell_snapshot=false",
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

test("buildCodexExecArgs keeps skip-git-repo-check even when a workspace path is present", () => {
  const args = buildCodexExecArgs({
    workspacePath: "H:\\workspace\\clawdrive-vscode",
    prompt: "Output exactly: OK",
    capabilities: fullCapabilities,
  });

  assert.ok(args.includes("--skip-git-repo-check"));
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
        "Codex transport received an invalid downstream response (missing content-type or empty body). Check downstream MCP, relay, or model-provider compatibility.",
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
  assert.deepEqual(
    classifyCodexCliFailure(
      new Error("Reconnecting... 1/5 (stream disconnected before completion: Transport error: network error: error decoding response body)")
    ),
    {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while decoding a downstream streaming response. Check the configured relay, proxy, or model-provider compatibility.",
    }
  );
  assert.deepEqual(
    classifyCodexCliFailure(new Error("stream disconnected before completion: stream closed before response.completed")),
    {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while talking to a downstream service. Check external MCP or model-provider compatibility.",
    }
  );
  assert.deepEqual(
    classifyCodexCliFailure(
      new Error(
        "Reconnecting... 1/5 (stream disconnected before completion: stream closed before response.completed); Codex turn did not complete within 240s after turn start."
      )
    ),
    {
      code: "PROVIDER_TRANSPORT_FAILED",
      message:
        "Codex transport failed while talking to a downstream service. Check external MCP or model-provider compatibility.",
    }
  );
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
    classifyCodexCliFailure(
      new Error(
        'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header; worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'
      )
    ),
    {
      code: "PROVIDER_AUTH_FAILED",
      message: "Codex could not authenticate with the configured upstream model provider.",
    }
  );
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
    classifyCodexRuntimeSignal(
      'error=execution error: Io(Custom { kind: Other, error: "windows sandbox: helper_firewall_rule_create_or_add_failed: SetRemoteAddresses failed" })'
    ),
    {
      code: "PROVIDER_WINDOWS_SANDBOX_WARNING",
      severity: "degraded",
      summary: "Windows sandbox helper blocked command execution; provider fell back to best-effort reasoning.",
      detail:
        'error=execution error: Io(Custom { kind: Other, error: "windows sandbox: helper_firewall_rule_create_or_add_failed: SetRemoteAddresses failed" })',
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
    classifyCodexRuntimeSignal('worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))'),
    {
      code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
      severity: "degraded",
      summary: "Provider transport received an invalid or empty downstream response.",
      detail: 'worker quit with fatal: Transport channel closed, when UnexpectedContentType(Some("missing-content-type; body: "))',
    }
  );
  assert.deepEqual(classifyCodexRuntimeSignal("stream closed before response.completed"), {
    code: "PROVIDER_TRANSPORT_RUNTIME_WARNING",
    severity: "degraded",
    summary: "Provider transport channel closed before the result stream completed.",
    detail: "stream closed before response.completed",
  });
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

test("buildCodexExecArgs disables non-interactive startup features that destabilize task runs", () => {
  const args = buildCodexExecArgs({
    workspacePath: "H:\\workspace\\clawdrive-vscode",
    prompt: "Explain this repository.",
    capabilities: fullCapabilities,
  });

  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("features.plugins=false"));
  assert.ok(args.includes("features.apps=false"));
  assert.ok(args.includes("features.shell_snapshot=false"));
});

test("sanitizeCodexConfig removes task-unsafe feature and mcp sections while keeping model config", () => {
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
      "[model_providers.proxy]",
      'name = "MyCodex"',
      "",
    ].join("\n")
  );
});
