/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const WebSocket = require("ws");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_POLL_LIMIT_MS = 120000;

function readOpenClawConfig() {
  const filePath = path.join(process.env.USERPROFILE || process.env.HOME || "", ".openclaw", "openclaw.json");
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveGatewayConfig() {
  const cfg = readOpenClawConfig();
  const host = process.env.CLAWDRIVE_GATEWAY_HOST || cfg?.gateway?.host || "127.0.0.1";
  const port = Number(process.env.CLAWDRIVE_GATEWAY_PORT || cfg?.gateway?.port || 18789);
  const tls = (process.env.CLAWDRIVE_GATEWAY_TLS || cfg?.gateway?.tls || false) === true;
  const token =
    process.env.CLAWDRIVE_GATEWAY_TOKEN ||
    cfg?.gateway?.auth?.token ||
    cfg?.gateway?.token ||
    "";
  return { host, port, tls, token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeId() {
  return crypto.randomUUID();
}

class GatewayRpcClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.connected = false;
    this.events = [];
    this.connectNonce = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {
        this.connected = true;
        resolve();
      });
      ws.on("close", (code, reason) => {
        this.connected = false;
        this.events.push({ type: "close", code, reason: reason?.toString?.() || "" });
      });
      ws.on("error", reject);
      ws.on("message", (data) => this.handleMessage(data.toString()));
    });
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (parsed?.type === "event" || parsed?.event) {
      this.events.push(parsed);
      if (parsed.event === "connect.challenge") {
        this.connectNonce = parsed?.payload?.nonce || null;
      }
    }
    if (parsed?.type === "res" || parsed?.id) {
      const id = parsed.id;
      const pending = this.pending.get(id);
      if (!pending) {
        return;
      }
      this.pending.delete(id);
      if (parsed.ok) {
        pending.resolve(parsed.payload ?? parsed);
      } else {
        const message =
          parsed?.error?.message ||
          parsed?.payload?.error?.message ||
          parsed?.message ||
          "unknown error";
        pending.reject(new Error(message));
      }
    }
  }

  request(method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.connected) {
        reject(new Error("gateway not connected"));
        return;
      }
      const id = makeId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}

async function tryConnect(rpc, token) {
  try {
    const identity = loadOrCreateIdentity();
    const signedAtMs = Date.now();
    const nonce = rpc.connectNonce || undefined;
    const version = nonce ? "v2" : "v1";
    const clientId = "selftest";
    const payloadParts = [
      version,
      identity.deviceId,
      clientId,
      "client",
      "client",
      "",
      String(signedAtMs),
      token ?? "",
    ];
    if (nonce) {
      payloadParts.push(nonce);
    }
    const payload = payloadParts.join("|");
    const signature = signPayload(identity.privateKeyPem, payload);

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "selftest",
        displayName: "ClawDrive Selftest",
        version: "0.1.0",
        platform: process.platform,
        mode: "client",
        instanceId: makeId(),
      },
      role: "client",
      caps: ["node.invoke"],
      scopes: [],
      auth: token ? { token } : undefined,
      device: {
        id: identity.deviceId,
        publicKey: publicKeyRawBase64Url(identity.publicKeyPem),
        signature,
        signedAt: signedAtMs,
        nonce,
      },
    };
    await rpc.request("connect", params);
    return true;
  } catch {
    return false;
  }
}

async function discoverNodes(rpc) {
  const methods = ["nodes.list", "node.list", "nodes.status", "node.status"];
  for (const method of methods) {
    try {
      const payload = await rpc.request(method, {});
      if (Array.isArray(payload?.nodes)) {
        return payload.nodes;
      }
      if (Array.isArray(payload)) {
        return payload;
      }
    } catch {
      continue;
    }
  }
  return [];
}

function selectNode(nodes, nameHint) {
  if (!nodes || !nodes.length) {
    return null;
  }
  if (nameHint) {
    const match = nodes.find((node) => `${node.displayName || node.name || ""}`.includes(nameHint));
    if (match) {
      return match;
    }
  }
  return nodes[0];
}

async function invokeCommand(rpc, nodeId, command, params) {
  const methods = ["node.invoke", "nodes.invoke", "node.invoke.request"];
  for (const method of methods) {
    try {
      const payload =
        nodeId !== undefined && nodeId !== null && String(nodeId).length > 0
          ? await rpc.request(method, { nodeId, command, params })
          : await rpc.request(method, { command, params });
      return { method, payload };
    } catch (error) {
      if (method === methods[methods.length - 1]) {
        throw error;
      }
    }
  }
  throw new Error("invoke method not supported by gateway");
}

async function waitForTask(rpc, nodeId, taskId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_POLL_LIMIT_MS) {
    const status = await invokeCommand(rpc, nodeId, "vscode.agent.task.status", { taskId });
    const snapshot = status.payload;
    if (snapshot?.state && snapshot.state !== "running" && snapshot.state !== "queued") {
      return snapshot;
    }
    await sleep(DEFAULT_POLL_MS);
  }
  return null;
}

async function run() {
  const { host, port, tls, token } = resolveGatewayConfig();
  const nodeIdOverride = process.env.CLAWDRIVE_NODE_ID || "";
  const nodeNameHint = process.env.CLAWDRIVE_NODE_NAME || "ClawDrive";
  const url = `${tls ? "wss" : "ws"}://${host}:${port}`;
  const rpc = new GatewayRpcClient(url);
  const report = {
    gateway: { host, port, tls, url },
    connectOk: false,
    node: null,
    cases: [],
    errors: [],
    events: [],
  };

  await rpc.connect();
  report.connectOk = await tryConnect(rpc, token);
  report.events = rpc.events.slice(0, 20);
  if (!report.connectOk) {
    report.errors.push("connect rejected or unsupported; check gateway token or protocol.");
    rpc.close();
    saveReport(report);
    printSummary(report);
    console.log("Tip: run 'ClawDrive: Run Selftest' from VS Code Command Palette to test locally.");
    process.exit(2);
  }

  const nodes = nodeIdOverride ? [] : await discoverNodes(rpc);
  const node = nodeIdOverride
    ? { id: nodeIdOverride, displayName: nodeIdOverride }
    : selectNode(nodes, nodeNameHint);

  let nodeId = node?.id || node?.nodeId || null;
  if (!nodeId) {
    report.errors.push("No node found. Will attempt blind invoke without nodeId.");
  } else {
    report.node = { id: nodeId, displayName: node.displayName || node.name || "" };
  }

  const prompts = [
    { name: "inspect", prompt: "列出 src 目录" },
    { name: "analyze", prompt: "解释这个仓库做什么" },
    { name: "plan", prompt: "给我两个方案，先别改" },
    { name: "plan_complex", prompt: "给我三个可行方案，说明影响范围和主要风险，先别改" },
  ];

  for (const entry of prompts) {
    const caseResult = { name: entry.name, prompt: entry.prompt, route: null, taskId: null, result: null, error: null };
    try {
      const route = await invokeCommand(rpc, nodeId, "vscode.agent.route", { prompt: entry.prompt });
      caseResult.route = route.payload;
      if (route.payload?.kind === "task" || route.payload?.kind === "task_result") {
        const taskId = route.payload?.data?.taskId || route.payload?.data?.snapshot?.taskId;
        if (taskId) {
          caseResult.taskId = taskId;
          const finalSnapshot = await waitForTask(rpc, nodeId, taskId);
          if (finalSnapshot) {
            const result = await invokeCommand(rpc, nodeId, "vscode.agent.task.result", { taskId });
            caseResult.result = result.payload;
          } else {
            caseResult.error = "task timeout waiting for completion";
          }
        }
      }
    } catch (error) {
      caseResult.error = String(error?.message || error);
    }
    report.cases.push(caseResult);
  }

  rpc.close();
  saveReport(report);
  printSummary(report);
}

function saveReport(report) {
  const outPath = path.join(process.cwd(), "selftest-report.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
}

function printSummary(report) {
  console.log("Selftest summary:");
  console.log(`Gateway: ${report.gateway.url}`);
  if (report.node) {
    console.log(`Node: ${report.node.displayName || report.node.id}`);
  }
  for (const entry of report.cases) {
    const status = entry.error
      ? `error: ${entry.error}`
      : entry.result?.snapshot?.state || entry.route?.kind || "unknown";
    console.log(`- ${entry.name}: ${status}`);
  }
  console.log("Report written to selftest-report.json");
}

run().catch((error) => {
  console.error(`Selftest failed: ${error?.message || error}`);
  process.exit(1);
});

function loadOrCreateIdentity() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const legacyPath = path.join(home, ".openclaw-vscode", "device.json");
  const preferredPath = legacyPath;
  const identity = tryLoadIdentity(preferredPath);
  if (identity) {
    return identity;
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const deviceId = fingerprintPublicKey(publicKeyPem);
  const created = { version: 1, deviceId, privateKeyPem, publicKeyPem, createdAtMs: Date.now() };
  fs.mkdirSync(path.dirname(preferredPath), { recursive: true });
  fs.writeFileSync(preferredPath, `${JSON.stringify(created, null, 2)}\n`, "utf8");
  return { deviceId, privateKeyPem, publicKeyPem };
}

function tryLoadIdentity(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.publicKeyPem !== "string" || typeof parsed.privateKeyPem !== "string") {
      return null;
    }
    const deviceId = fingerprintPublicKey(parsed.publicKeyPem);
    return {
      deviceId,
      privateKeyPem: parsed.privateKeyPem,
      publicKeyPem: parsed.publicKeyPem,
    };
  } catch {
    return null;
  }
}

function fingerprintPublicKey(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const raw = spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)
    ? spki.subarray(prefix.length)
    : spki;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function publicKeyRawBase64Url(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  const raw = spki.length === prefix.length + 32 && spki.subarray(0, prefix.length).equals(prefix)
    ? spki.subarray(prefix.length)
    : spki;
  return base64UrlEncode(raw);
}

function signPayload(privateKeyPem, payload) {
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), crypto.createPrivateKey(privateKeyPem));
  return base64UrlEncode(signature);
}

function base64UrlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
