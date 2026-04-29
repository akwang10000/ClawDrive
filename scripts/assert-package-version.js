const fs = require("fs");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(workspaceRoot, "package.json");
const packageLockPath = path.join(workspaceRoot, "package-lock.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(`Packaging guard failed: ${message}`);
  process.exit(1);
}

const packageJson = readJson(packageJsonPath);
const packageLock = readJson(packageLockPath);
const packageVersion = packageJson.version;
const lockVersion = packageLock.version;
const lockRootVersion = packageLock.packages?.[""]?.version;

if (!packageVersion || typeof packageVersion !== "string") {
  fail("package.json is missing a valid version string.");
}

if (lockVersion !== packageVersion) {
  fail(`package-lock.json version (${lockVersion ?? "missing"}) does not match package.json (${packageVersion}).`);
}

if (lockRootVersion !== packageVersion) {
  fail(`package-lock.json root package version (${lockRootVersion ?? "missing"}) does not match package.json (${packageVersion}).`);
}

const existingVsix = path.join(workspaceRoot, `clawdrive-vscode-${packageVersion}.vsix`);
if (fs.existsSync(existingVsix)) {
  fail(`clawdrive-vscode-${packageVersion}.vsix already exists. Bump the extension version before packaging again.`);
}
