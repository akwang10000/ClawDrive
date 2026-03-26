import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, shouldUseRecommended } from "../../src/routing/classifier";

test("classifier routes analyze prompts", () => {
  assert.deepEqual(classifyIntent("解释一下这个仓库", []), { type: "analyze" });
});

test("classifier routes plan prompts", () => {
  assert.deepEqual(classifyIntent("给我两个方案，先别改", []), { type: "plan" });
});

test("classifier routes apply prompts", () => {
  assert.deepEqual(classifyIntent("修这个 bug", []), { type: "apply" });
});

test("classifier routes continue prompts and recommended follow-up", () => {
  assert.deepEqual(classifyIntent("继续", []), { type: "continue" });
  assert.deepEqual(classifyIntent("批准执行", []), { type: "continue" });
  assert.equal(shouldUseRecommended("用推荐方案"), true);
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
