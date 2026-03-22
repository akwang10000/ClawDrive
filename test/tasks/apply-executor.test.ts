import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { StructuredApplyExecutor } from "../../src/tasks/apply-executor";
import { makeTempDir, setWorkspaceRoot } from "../test-utils";

test("StructuredApplyExecutor writes and replaces files inside the workspace", async () => {
  const rootPath = await makeTempDir("clawdrive-apply-executor");
  setWorkspaceRoot(rootPath);
  await fs.writeFile(path.join(rootPath, "README.md"), "hello old world", "utf8");

  const executor = new StructuredApplyExecutor();
  const result = await executor.apply({
    summary: "Update README and add notes.",
    operations: [
      { type: "replace_text", path: "README.md", oldText: "old", newText: "new" },
      { type: "write_file", path: "notes.txt", content: "note" },
    ],
  });

  assert.match(result.summary, /Applied 2 operation/);
  assert.equal(await fs.readFile(path.join(rootPath, "README.md"), "utf8"), "hello new world");
  assert.equal(await fs.readFile(path.join(rootPath, "notes.txt"), "utf8"), "note");
});

test("StructuredApplyExecutor rejects paths outside the workspace", async () => {
  const rootPath = await makeTempDir("clawdrive-apply-outside");
  setWorkspaceRoot(rootPath);

  const executor = new StructuredApplyExecutor();
  await assert.rejects(
    executor.apply({
      summary: "Outside write",
      operations: [{ type: "write_file", path: path.join(rootPath, "..", "outside.txt"), content: "nope" }],
    }),
    (error: Error & { code?: string }) => error.code === "PATH_OUTSIDE_WORKSPACE"
  );
});

test("StructuredApplyExecutor fails when replace_text matches multiple times", async () => {
  const rootPath = await makeTempDir("clawdrive-apply-multi");
  setWorkspaceRoot(rootPath);
  await fs.writeFile(path.join(rootPath, "README.md"), "dup dup", "utf8");

  const executor = new StructuredApplyExecutor();
  await assert.rejects(
    executor.apply({
      summary: "Duplicate replacement",
      operations: [{ type: "replace_text", path: "README.md", oldText: "dup", newText: "x" }],
    }),
    (error: Error & { code?: string }) => error.code === "APPLY_PRECONDITION_FAILED"
  );
});

test("StructuredApplyExecutor rolls back files when a later write fails", async () => {
  const rootPath = await makeTempDir("clawdrive-apply-rollback");
  setWorkspaceRoot(rootPath);
  await fs.writeFile(path.join(rootPath, "README.md"), "before", "utf8");

  let writes = 0;
  const executor = new StructuredApplyExecutor({
    writeFile: async (filePath, content) => {
      writes += 1;
      if (writes === 2) {
        throw Object.assign(new Error("disk full"), { code: "EIO" });
      }
      await fs.writeFile(filePath, content, "utf8");
    },
  });

  await assert.rejects(
    executor.apply({
      summary: "Two writes",
      operations: [
        { type: "write_file", path: "README.md", content: "after" },
        { type: "write_file", path: "notes.txt", content: "note" },
      ],
    }),
    (error: Error & { code?: string }) => error.code === "APPLY_EXECUTION_FAILED"
  );

  assert.equal(await fs.readFile(path.join(rootPath, "README.md"), "utf8"), "before");
  await assert.rejects(fs.readFile(path.join(rootPath, "notes.txt"), "utf8"));
});
