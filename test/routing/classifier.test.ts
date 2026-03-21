import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent, shouldUseRecommended } from "../../src/routing/classifier";

test("classifier routes analyze prompts", () => {
  assert.deepEqual(classifyIntent("解释一下这个仓库", []), { type: "analyze" });
});

test("classifier routes plan prompts", () => {
  assert.deepEqual(classifyIntent("给我两个方案，先别改", []), { type: "plan" });
});

test("classifier routes continue prompts and recommended follow-up", () => {
  assert.deepEqual(classifyIntent("继续", []), { type: "continue" });
  assert.equal(shouldUseRecommended("用推荐方案"), true);
});

test("classifier blocks write intents", () => {
  assert.deepEqual(classifyIntent("修这个 bug", []), { type: "blocked" });
});

test("classifier maps direct inspect prompts conservatively", () => {
  assert.deepEqual(classifyIntent("读取 README.md", ["README.md"]), {
    type: "inspect",
    action: { type: "file", path: "README.md" },
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
