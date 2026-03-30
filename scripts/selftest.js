/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 1_500;
const DEFAULT_POLL_LIMIT_MS = 120_000;

function readOpenClawConfig() {
  const filePath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "openclaw.json");
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function parseBooleanish(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveGatewayConfig() {
  const cfg = readOpenClawConfig();
  const hasUrlOverride = Boolean(
    process.env.CLAWDRIVE_GATEWAY_HOST ||
    process.env.CLAWDRIVE_GATEWAY_PORT ||
    process.env.CLAWDRIVE_GATEWAY_TLS
  );
  const host = process.env.CLAWDRIVE_GATEWAY_HOST || cfg?.gateway?.host || "127.0.0.1";
  const port = Number(process.env.CLAWDRIVE_GATEWAY_PORT || cfg?.gateway?.port || 18789);
  const tls = parseBooleanish(process.env.CLAWDRIVE_GATEWAY_TLS) || cfg?.gateway?.tls === true;
  const token = process.env.CLAWDRIVE_GATEWAY_TOKEN || cfg?.gateway?.auth?.token || cfg?.gateway?.token || "";
  const url = `${tls ? "wss" : "ws"}://${host}:${port}`;
  return { host, port, tls, token, url, hasUrlOverride };
}

function resolveOpenClawRunner() {
  const override = process.env.OPENCLAW_BIN?.trim();
  if (override) {
    if (override.endsWith(".mjs")) {
      return { command: process.execPath, baseArgs: [override], display: override };
    }
    return { command: override, baseArgs: [], display: override };
  }

  if (process.platform === "win32") {
    const located = spawnSync("where.exe", ["openclaw.cmd"], { encoding: "utf8" });
    const wrapperPath = located.status === 0
      ? located.stdout.split(/\r?\n/).map((entry) => entry.trim()).find(Boolean)
      : null;
    if (!wrapperPath) {
      throw new Error("openclaw.cmd not found in PATH.");
    }
    const scriptPath = path.join(path.dirname(wrapperPath), "node_modules", "openclaw", "openclaw.mjs");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`OpenClaw entry script not found: ${scriptPath}`);
    }
    return { command: process.execPath, baseArgs: [scriptPath], display: scriptPath };
  }

  return { command: "openclaw", baseArgs: [], display: "openclaw" };
}

function buildGatewayCliArgs(gateway) {
  const args = ["--json"];
  if (gateway.hasUrlOverride) {
    args.push("--url", gateway.url);
  }
  if (gateway.token) {
    args.push("--token", gateway.token);
  }
  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeOutput(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  return lines.slice(-20).join("\n");
}

function extractLastJsonValue(text) {
  const raw = String(text || "");
  const starts = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if ((char === "{" || char === "[") && (i === 0 || raw[i - 1] === "\n" || raw[i - 1] === "\r")) {
      starts.push(i);
    }
  }
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const candidate = raw.slice(starts[i]).trim();
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function runOpenClawJson(runner, args, label) {
  const result = spawnSync(runner.command, [...runner.baseArgs, ...args], {
    encoding: "utf8",
    timeout: DEFAULT_POLL_LIMIT_MS + DEFAULT_TIMEOUT_MS,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }

  const combined = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n");
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${summarizeOutput(combined) || `exit ${result.status}`}`);
  }

  const parsed = extractLastJsonValue(result.stdout || combined);
  if (parsed === null) {
    throw new Error(`${label} did not return JSON: ${summarizeOutput(combined)}`);
  }

  return parsed;
}

function selectNode(nodes, explicitNodeId, nameHint) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return null;
  }

  if (explicitNodeId) {
    return nodes.find((node) => `${node.nodeId || node.id || ""}` === explicitNodeId) || null;
  }

  const normalizedHint = (nameHint || "").trim().toLowerCase();
  if (normalizedHint) {
    const hinted = nodes.filter((node) =>
      `${node.displayName || node.name || ""}`.toLowerCase().includes(normalizedHint)
    );
    const connectedHinted = hinted.find((node) => node.connected);
    if (connectedHinted) {
      return connectedHinted;
    }
    if (hinted.length > 0) {
      return hinted[0];
    }
  }

  return nodes.find((node) => node.connected) || nodes[0];
}

function resolveNodeRef(node, explicitNodeId) {
  if (explicitNodeId) {
    return explicitNodeId;
  }
  return `${node?.displayName || node?.name || node?.nodeId || node?.id || ""}`;
}

function listNodes(runner, gateway) {
  const sharedArgs = buildGatewayCliArgs(gateway);
  const statusPayload = runOpenClawJson(runner, ["nodes", "status", ...sharedArgs], "nodes status");
  if (Array.isArray(statusPayload?.nodes)) {
    return statusPayload.nodes;
  }

  const fallback = runOpenClawJson(runner, ["gateway", "call", "node.list", ...sharedArgs], "gateway call node.list");
  if (Array.isArray(fallback?.nodes)) {
    return fallback.nodes;
  }
  if (Array.isArray(fallback)) {
    return fallback;
  }
  return [];
}

function invokeNodeCommand(runner, gateway, nodeContext, command, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const invokeArgs = (nodeRef) => [
    "nodes",
    "invoke",
    ...buildGatewayCliArgs(gateway),
    "--node",
    nodeRef,
    "--command",
    command,
    "--params",
    JSON.stringify(params || {}),
    "--timeout",
    String(Math.max(timeoutMs, DEFAULT_TIMEOUT_MS)),
    "--invoke-timeout",
    String(Math.max(timeoutMs, DEFAULT_TIMEOUT_MS)),
  ];
  const unwrapPayload = (value) => (value?.payload !== undefined ? value.payload : value);

  try {
    return unwrapPayload(runOpenClawJson(runner, invokeArgs(nodeContext.nodeRef), `nodes invoke ${command}`));
  } catch (error) {
    if (nodeContext.explicitNodeId || !/unknown node/i.test(String(error?.message || error))) {
      throw error;
    }
    const refreshed = selectNode(listNodes(runner, gateway), "", nodeContext.nameHint);
    const refreshedRef = resolveNodeRef(refreshed, "");
    if (!refreshed || !refreshedRef || refreshedRef === nodeContext.nodeRef) {
      throw error;
    }
    nodeContext.node = refreshed;
    nodeContext.nodeRef = refreshedRef;
    nodeContext.nodeId = refreshed.nodeId || refreshed.id || nodeContext.nodeId;
    nodeContext.displayName = refreshed.displayName || refreshed.name || nodeContext.displayName;
    return unwrapPayload(runOpenClawJson(runner, invokeArgs(nodeContext.nodeRef), `nodes invoke ${command}`));
  }
}

async function waitForTask(runner, gateway, nodeContext, taskId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_POLL_LIMIT_MS) {
    const snapshot = invokeNodeCommand(runner, gateway, nodeContext, "vscode.agent.task.status", { taskId });
    if (snapshot?.state && snapshot.state !== "running" && snapshot.state !== "queued") {
      return snapshot;
    }
    await sleep(DEFAULT_POLL_MS);
  }
  return null;
}

function saveReport(report) {
  const outPath = path.join(process.cwd(), "selftest-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
}

function printSummary(report) {
  console.log("Selftest summary:");
  console.log(`Gateway: ${report.gateway.url}`);
  console.log(`Driver: ${report.driver}`);
  if (report.node) {
    console.log(`Node: ${report.node.displayName || report.node.id}`);
  }
  for (const entry of report.cases) {
    const status = entry.error
      ? `error: ${entry.error}`
      : entry.result?.snapshot?.state || entry.snapshot?.state || entry.route?.kind || "unknown";
    console.log(`- ${entry.name}: ${status}`);
  }
  console.log("Report written to selftest-report.json");
}

async function run() {
  const gateway = resolveGatewayConfig();
  const runner = resolveOpenClawRunner();
  const nodeIdOverride = process.env.CLAWDRIVE_NODE_ID || "";
  const nodeNameHint = process.env.CLAWDRIVE_NODE_NAME || "ClawDrive";
  const report = {
    gateway,
    driver: runner.display,
    connectOk: false,
    node: null,
    cases: [],
    errors: [],
    events: [],
  };

  try {
    const nodes = listNodes(runner, gateway);
    report.connectOk = true;
    const node = selectNode(nodes, nodeIdOverride, nodeNameHint);

    if (!node) {
      const available = nodes.map((entry) => entry.displayName || entry.nodeId || entry.id).filter(Boolean);
      report.errors.push(
        available.length > 0
          ? `No matching node found. Available nodes: ${available.join(", ")}`
          : "No nodes reported by OpenClaw."
      );
      saveReport(report);
      printSummary(report);
      process.exit(3);
    }

    const nodeContext = {
      explicitNodeId: nodeIdOverride,
      nameHint: nodeNameHint,
      node,
      nodeRef: resolveNodeRef(node, nodeIdOverride),
      nodeId: node.nodeId || node.id || null,
      displayName: node.displayName || node.name || null,
    };

    report.node = {
      id: node.nodeId || node.id || nodeContext.nodeRef,
      displayName: node.displayName || node.name || nodeContext.nodeRef,
      connected: node.connected === true,
      paired: node.paired === true,
    };

    const prompts = [
      { name: "inspect", prompt: "List the top-level folders and files in the current workspace." },
      {
        name: "analyze",
        prompt: "Explain why this workspace is structured this way and what design constraints it appears to optimize for.",
      },
      { name: "plan", prompt: "Give me two safe next-step options for investigating this workspace. Do not modify anything." },
      {
        name: "plan_complex",
        prompt: "Give me three feasible next-step options for this workspace, explain impact scope and main risks, and do not modify anything yet.",
      },
    ];

    for (const entry of prompts) {
      const caseResult = {
        name: entry.name,
        prompt: entry.prompt,
        route: null,
        taskId: null,
        snapshot: null,
        result: null,
        error: null,
      };

      try {
        const route = invokeNodeCommand(runner, gateway, nodeContext, "vscode.agent.route", { prompt: entry.prompt }, 30_000);
        caseResult.route = route;

        if (route?.kind === "task" || route?.kind === "task_result") {
          const taskId = route?.data?.taskId || route?.data?.snapshot?.taskId || null;
          if (taskId) {
            caseResult.taskId = taskId;
            const finalSnapshot = await waitForTask(runner, gateway, nodeContext, taskId);
            if (finalSnapshot) {
              caseResult.snapshot = finalSnapshot;
              caseResult.result = invokeNodeCommand(
                runner,
                gateway,
                nodeContext,
                "vscode.agent.task.result",
                { taskId },
                30_000
              );
            } else {
              caseResult.error = "task timeout waiting for completion";
            }
          }
        } else if (route?.kind === "task_result") {
          caseResult.snapshot = route?.data?.snapshot || null;
          caseResult.result = route?.data || null;
        }
      } catch (error) {
        caseResult.error = String(error?.message || error);
      }

      report.cases.push(caseResult);
    }

    report.node = {
      id: nodeContext.nodeId || nodeContext.nodeRef,
      displayName: nodeContext.displayName || nodeContext.nodeRef,
      connected: nodeContext.node?.connected === true,
      paired: nodeContext.node?.paired === true,
    };
  } catch (error) {
    report.errors.push(String(error?.message || error));
    saveReport(report);
    printSummary(report);
    console.log("Tip: run 'ClawDrive: Run Selftest' from VS Code Command Palette to test locally.");
    process.exit(2);
  }

  saveReport(report);
  printSummary(report);
}

run().catch((error) => {
  console.error(`Selftest failed: ${error?.message || error}`);
  process.exit(1);
});
