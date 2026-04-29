import test from "node:test";
import assert from "node:assert/strict";

const {
  buildNodeInvokeRefs,
  invokeNodeCommandWithRecovery,
  rankCandidateNodes,
  resolveNodeRef,
  selectRefreshedNode,
} = require("../../scripts/selftest.js");

test("resolveNodeRef prefers display names for stable routing across node id churn", () => {
  const node = {
    nodeId: "ephemeral-node-id",
    displayName: "ClawDrive",
    connected: true,
  };

  assert.equal(resolveNodeRef(node, ""), "ClawDrive");
});

test("buildNodeInvokeRefs keeps id and display-name fallbacks for command retries", () => {
  const refs = buildNodeInvokeRefs({
    explicitNodeId: "",
    nodeRef: "ClawDrive",
    nodeId: "ephemeral-node-id",
    displayName: "ClawDrive",
  });

  assert.deepEqual(refs, ["ClawDrive", "ephemeral-node-id"]);
});

test("rankCandidateNodes prioritizes connected nodes that advertise the requested command", () => {
  const ranked = rankCandidateNodes(
    [
      {
        nodeId: "stale-clawdrive",
        displayName: "ClawDrive",
        connected: true,
        commands: [],
      },
      {
        nodeId: "healthy-clawdrive",
        displayName: "ClawDrive",
        connected: true,
        commands: ["vscode.agent.task.status"],
      },
    ],
    "ClawDrive",
    "vscode.agent.task.status"
  );

  assert.equal(ranked[0]?.nodeId, "healthy-clawdrive");
});

test("invokeNodeCommandWithRecovery retries after unknown-node and succeeds on a later attempt", () => {
  const runner = { command: "", baseArgs: [] };
  const gateway = { hasUrlOverride: false, token: "" };
  const nodeContext = {
    explicitNodeId: "",
    nameHint: "ClawDrive",
    nodeRef: "ClawDrive",
    nodeId: "ephemeral-node-id",
    displayName: "ClawDrive",
    node: { displayName: "ClawDrive", connected: true },
  };

  const originalSpawnSync = require("node:child_process").spawnSync;
  const childProcess = require("node:child_process");
  let invokeCount = 0;
  childProcess.spawnSync = (_command: string, args: string[]) => {
    const joined = args.join(" ");
    if (joined.includes("gateway call node.list")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          nodes: [
            {
              nodeId: "ephemeral-node-id",
              displayName: "ClawDrive",
              connected: true,
              commands: ["vscode.agent.task.status"],
            },
          ],
        }),
        stderr: "",
      };
    }
    invokeCount += 1;
    if (invokeCount === 1) {
      return {
        status: 1,
        stdout: "",
        stderr: "nodes invoke failed: Error: unknown node: ephemeral-node-id",
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify({ ok: true, payload: { state: "waiting_decision" } }),
      stderr: "",
    };
  };

  try {
    const result = invokeNodeCommandWithRecovery(runner, gateway, nodeContext, "vscode.agent.task.status", { taskId: "task-1" });
    assert.deepEqual(result, { state: "waiting_decision" });
  } finally {
    childProcess.spawnSync = originalSpawnSync;
  }
});

test("selectRefreshedNode prefers the current connected hinted node instead of switching to a disconnected hint match", () => {
  const connectedHinted = {
    nodeId: "clawdrive-node",
    displayName: "ClawDrive",
    connected: true,
  };
  const disconnectedHinted = {
    nodeId: "android-node",
    displayName: "sdk_gphone64_x86_64",
    connected: false,
  };

  const ranked = rankCandidateNodes([connectedHinted, disconnectedHinted], "ClawDrive", "vscode.agent.task.status");
  const selected = selectRefreshedNode(ranked, "ClawDrive");

  assert.equal(selected?.nodeId, "clawdrive-node");
});

test("selectRefreshedNode upgrades from a disconnected current node to a different connected candidate", () => {
  const disconnectedCurrent = {
    nodeId: "android-node",
    displayName: "sdk_gphone64_x86_64",
    connected: false,
  };
  const connectedClawDrive = {
    nodeId: "clawdrive-node",
    displayName: "ClawDrive",
    connected: true,
    commands: ["vscode.agent.task.status"],
  };

  const ranked = rankCandidateNodes([disconnectedCurrent, connectedClawDrive], "ClawDrive", "vscode.agent.task.status");
  const selected = selectRefreshedNode(ranked, "android-node");

  assert.equal(selected?.nodeId, "clawdrive-node");
});
