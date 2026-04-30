import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, shouldUseRecommended } from "../../src/routing/classifier";

test("classifier routes analyze prompts", () => {
  assert.deepEqual(classifyIntent("解释一下这个仓库", []), { type: "analyze" });
});

test("classifier keeps read-only analysis prompts on analyze", () => {
  assert.deepEqual(classifyIntent("Analyze the repository purpose and top-level modules. Do not modify files.", []), {
    type: "analyze",
  });
  assert.deepEqual(classifyIntent("先别改，分析一下这个仓库的结构。", []), { type: "analyze" });
});

test("classifier routes plan prompts", () => {
  assert.deepEqual(classifyIntent("给我两个方案，先别改", []), { type: "plan" });
  assert.deepEqual(classifyIntent("Give me two safe next-step options for investigating this workspace. Do not modify anything.", []), {
    type: "plan",
  });
  assert.deepEqual(
    classifyIntent(
      "Give me three feasible next-step options for this workspace, explain impact scope and main risks, and do not modify anything yet.",
      []
    ),
    { type: "plan" }
  );
  assert.deepEqual(classifyIntent("What are the options for investigating this task? Do not modify anything.", []), {
    type: "plan",
  });
  assert.deepEqual(classifyIntent("Compare implementation options before changing code.", []), { type: "plan" });
});


test("classifier keeps broad read-only analysis prompts on analyze unless option intent is explicit", () => {
  assert.deepEqual(classifyIntent("Analyze the best next step for this workspace without changing code.", []), {
    type: "analyze",
  });
  assert.deepEqual(classifyIntent("Explain the safest way to investigate this bug first. Do not modify anything yet.", []), {
    type: "analyze",
  });
  assert.deepEqual(classifyIntent("Compare the provider abstraction across the repository and explain the gaps.", []), {
    type: "analyze",
  });
});
test("classifier keeps provider architecture analysis out of plan and diagnose", () => {
  assert.deepEqual(classifyIntent("Analyze the Claude provider architecture and explain the task flow.", []), {
    type: "analyze",
  });
  assert.deepEqual(classifyIntent("Review the provider finalization path without changing files.", []), {
    type: "analyze",
  });
  assert.deepEqual(classifyIntent("Compare provider evidence handling across code and docs, but do not propose options.", []), {
    type: "analyze",
  });
});

test("classifier routes explicit decision and tradeoff requests to plan", () => {
  assert.deepEqual(classifyIntent("Give me two implementation options for hardening provider finalization.", []), {
    type: "plan",
  });
  assert.deepEqual(classifyIntent("Compare options and tradeoffs before changing the router.", []), {
    type: "plan",
  });
  assert.deepEqual(classifyIntent("Let me decide between safe next-step options.", []), {
    type: "plan",
  });
});

test("classifier keeps operational provider health prompts on diagnose", () => {
  assert.deepEqual(classifyIntent("Why did the Claude provider task fail last time?", []), {
    type: "diagnose",
  });
  assert.deepEqual(classifyIntent("Check provider readiness and connection status.", []), {
    type: "diagnose",
  });
  assert.deepEqual(classifyIntent("Diagnose the latest degraded task result.", []), {
    type: "diagnose",
  });
});



test("classifier routes apply prompts", () => {
  assert.deepEqual(classifyIntent("修这个 bug", []), { type: "apply" });
});

test("classifier routes continue prompts and recommended follow-up", () => {
  assert.deepEqual(classifyIntent("继续", []), { type: "continue" });
  assert.deepEqual(classifyIntent("批准执行", []), { type: "continue" });
  assert.equal(shouldUseRecommended("用推荐方案"), true);
});

test("classifier routes explicit Claude Code for VS Code handoff prompts", () => {
  assert.deepEqual(classifyIntent("Open this in Claude Code for VS Code and continue there.", []), {
    type: "claude_vscode",
  });
  assert.deepEqual(classifyIntent("在 Claude Code 里打开并继续处理这个任务", []), {
    type: "claude_vscode",
  });
});

test("classifier blocks unsupported destructive intents", () => {
  assert.deepEqual(classifyIntent("删除这个文件", []), { type: "blocked" });
});

test("classifier maps direct inspect prompts conservatively", () => {
  assert.deepEqual(classifyIntent("读取 README.md", ["README.md"]), {
    type: "inspect",
    action: { type: "file", path: "README.md" },
  });
  assert.deepEqual(classifyIntent("Where is `vscode.agent.route` wired up?", []), {
    type: "inspect",
    action: { type: "search_lite", query: "vscode.agent.route" },
  });
  assert.deepEqual(classifyIntent("Read README.md and summarize installation.", []), {
    type: "inspect",
    action: { type: "grounded_summary", paths: ["README.md"] },
  });
  assert.deepEqual(classifyIntent("Compare package.json and src/extension.ts.", []), {
    type: "inspect",
    action: { type: "grounded_summary", paths: ["package.json", "src/extension.ts"] },
  });
  assert.deepEqual(classifyIntent("Summarize this repository structure.", []), {
    type: "inspect",
    action: { type: "repository_summary", focusPath: undefined },
  });
  assert.deepEqual(classifyIntent("Look at src and explain the main modules.", []), {
    type: "inspect",
    action: { type: "repository_summary", focusPath: "src" },
  });
  assert.deepEqual(classifyIntent("Explain how route, task service, and provider fit together.", []), {
    type: "inspect",
    action: { type: "runtime_flow_audit" },
  });
  assert.deepEqual(classifyIntent("Summarize the src directory.", []), {
    type: "inspect",
    action: { type: "directory_summary", path: "src" },
  });
  assert.deepEqual(classifyIntent("列出 src", ["src"]), {
    type: "inspect",
    action: { type: "directory", path: "src" },
  });
  assert.deepEqual(classifyIntent("看当前诊断", []), {
    type: "inspect",
    action: { type: "diagnostics", path: undefined },
  });
});

test("classifier routes diagnose prompts", () => {
  assert.deepEqual(classifyIntent("为什么失败", []), { type: "diagnose" });
  assert.deepEqual(classifyIntent("现在什么状态", []), { type: "diagnose" });
});

test("classifier does not treat generic provider architecture prompts as diagnosis", () => {
  assert.deepEqual(classifyIntent("Explain the provider contract in this repo.", []), { type: "analyze" });
  assert.notEqual(classifyIntent("Compare the provider abstraction in docs and code.", []).type, "diagnose");
  assert.notEqual(classifyIntent("Why does this repo use a provider abstraction?", []).type, "diagnose");
  assert.notEqual(classifyIntent("Why is the provider interface shaped this way?", []).type, "diagnose");
  assert.notEqual(classifyIntent("检查 provider 抽象设计", []).type, "diagnose");
  assert.notEqual(classifyIntent("检查 provider 接口契约", []).type, "diagnose");
});

test("classifier keeps explicit provider status and failure prompts on diagnose", () => {
  assert.deepEqual(classifyIntent("Check provider status.", []), { type: "diagnose" });
  assert.deepEqual(classifyIntent("Why did the provider fail to connect?", []), { type: "diagnose" });
  assert.deepEqual(classifyIntent("检查 provider 状态", []), { type: "diagnose" });
  assert.deepEqual(classifyIntent("为什么 provider 连不上", []), { type: "diagnose" });
});
