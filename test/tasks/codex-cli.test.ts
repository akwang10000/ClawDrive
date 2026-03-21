import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCodexExecArgs,
  buildCodexResumeArgs,
  classifyCodexCliFailure,
  detectCodexCliCapabilities,
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
  assert.deepEqual(classifyCodexCliFailure(new Error("unexpected argument '--output-schema' found")), {
    code: "PROVIDER_CLI_ARGS_UNSUPPORTED",
    message: "The installed Codex CLI does not support one or more arguments required by this provider.",
  });
});
