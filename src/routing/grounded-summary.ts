import * as path from "path";
import { getCurrentLocale } from "../i18n";
import type { FileReadPayload, WorkspaceInspector } from "./workspace-inspector";

export interface GroundedFileFinding {
  path: string;
  languageId: string;
  size: number;
  summary: string;
}

export interface GroundedSummaryResult {
  summary: string;
  findings: string[];
  files: GroundedFileFinding[];
  missingPaths: string[];
}

export interface GroundedDirectorySummaryResult {
  summary: string;
  findings: string[];
  directory: {
    path: string;
    workspaceFolder: string;
    fileCount: number;
    directoryCount: number;
    topDirectories: string[];
  };
  sampledFiles: GroundedFileFinding[];
}

export interface GroundedRepositorySummaryResult {
  summary: string;
  findings: string[];
  root: GroundedDirectorySummaryResult;
  children: GroundedDirectorySummaryResult[];
}

export async function inspectGroundedFiles(
  inspector: WorkspaceInspector,
  paths: string[],
  prompt?: string
): Promise<GroundedSummaryResult> {
  const uniquePaths = [...new Set(paths.map((value) => value.trim()).filter(Boolean))].slice(0, 4);
  const files: GroundedFileFinding[] = [];
  const missingPaths: string[] = [];

  for (const candidate of uniquePaths) {
    try {
      const document = await inspector.fileRead({ path: candidate });
      files.push(summarizeFile(document, prompt));
    } catch {
      missingPaths.push(candidate);
    }
  }

  const findings = [
    ...files.map((file) => file.summary),
    ...missingPaths.map((filePath) =>
      text(
        `I could not read ${filePath} from the current workspace.`,
        `我无法从当前工作区读取 ${filePath}。`
      )
    ),
  ];

  const summary =
    findings.join("\n") ||
    text("I did not find readable files to summarize.", "我没有找到可读取并总结的文件。");

  return {
    summary,
    findings,
    files,
    missingPaths,
  };
}

export async function inspectGroundedDirectory(
  inspector: WorkspaceInspector,
  targetPath: string,
  prompt?: string
): Promise<GroundedDirectorySummaryResult> {
  const listing = await inspector.directoryList({ path: targetPath });
  const directories = listing.entries.filter((entry) => entry.type === "directory");
  const files = listing.entries.filter((entry) => entry.type === "file");
  const sampleCandidates = chooseRepresentativeFiles(files, targetPath);
  const sampledFiles: GroundedFileFinding[] = [];

  for (const candidate of sampleCandidates) {
    try {
      const document = await inspector.fileRead({ path: candidate.path });
      sampledFiles.push(summarizeFile(document, prompt));
    } catch {
      // Keep the directory summary resilient; missing sample files should not fail the whole summary.
    }
  }

  const findings = [
    text(
      `${listing.path}: ${directories.length} directories and ${files.length} files at the top level.`,
      `${listing.path}：顶层有 ${directories.length} 个目录，${files.length} 个文件。`
    ),
    directories.length
      ? text(
          `Top directories: ${directories.slice(0, 6).map((entry) => entry.name).join(", ")}.`,
          `主要子目录：${directories.slice(0, 6).map((entry) => entry.name).join("、")}。`
        )
      : text("There are no top-level subdirectories.", "顶层没有子目录。"),
    ...sampledFiles.map((file) => file.summary),
  ];

  return {
    summary: findings.join("\n"),
    findings,
    directory: {
      path: listing.path,
      workspaceFolder: listing.workspaceFolder,
      fileCount: files.length,
      directoryCount: directories.length,
      topDirectories: directories.slice(0, 6).map((entry) => entry.name),
    },
    sampledFiles,
  };
}

export async function inspectGroundedRepository(
  inspector: WorkspaceInspector,
  prompt?: string,
  focusPath?: string
): Promise<GroundedRepositorySummaryResult> {
  const workspace = await inspector.workspaceInfo();
  const rootPath = focusPath ?? workspace.rootPath ?? workspace.folders[0];
  if (!rootPath) {
    const emptySummary = text(
      "I could not summarize the repository because no workspace is open.",
      "当前没有打开工作区，无法总结仓库结构。"
    );
    const emptyDirectory: GroundedDirectorySummaryResult = {
      summary: emptySummary,
      findings: [emptySummary],
      directory: {
        path: "",
        workspaceFolder: "",
        fileCount: 0,
        directoryCount: 0,
        topDirectories: [],
      },
      sampledFiles: [],
    };
    return {
      summary: emptySummary,
      findings: [emptySummary],
      root: emptyDirectory,
      children: [],
    };
  }

  const root = await inspectGroundedDirectory(inspector, rootPath, prompt);
  const childPaths = chooseRelevantChildDirectories(root.directory.path, root.directory.topDirectories, prompt);
  const children: GroundedDirectorySummaryResult[] = [];

  for (const childPath of childPaths) {
    try {
      const child = await inspectGroundedDirectory(inspector, childPath, prompt);
      children.push(child);
    } catch {
      // Keep the repository summary resilient if a nominated child directory cannot be inspected.
    }
  }

  const findings = [
    ...root.findings,
    ...children.map((child) =>
      text(
        `Shallow follow-through for ${formatRepositoryChildLabel(root.directory.workspaceFolder, root.directory.path, child.directory.path)}:`,
        `对 ${normalizePathForDisplay(child.directory.path)} 的浅层跟进：`
      )
    ),
    ...children.flatMap((child) => child.findings),
  ];

  return {
    summary: findings.join("\n"),
    findings,
    root,
    children,
  };
}

function summarizeFile(document: FileReadPayload, prompt?: string): GroundedFileFinding {
  const basename = path.basename(document.path).toLowerCase();
  const languageId = document.languageId.toLowerCase();

  if (basename === "package.json") {
    return {
      path: document.path,
      languageId: document.languageId,
      size: document.size,
      summary: summarizePackageJson(document),
    };
  }

  if (languageId === "markdown" || basename.endsWith(".md")) {
    return {
      path: document.path,
      languageId: document.languageId,
      size: document.size,
      summary: summarizeMarkdown(document),
    };
  }

  if (["typescript", "javascript", "typescriptreact", "javascriptreact"].includes(languageId) || /\.(ts|tsx|js|jsx|cjs|mjs)$/.test(basename)) {
    return {
      path: document.path,
      languageId: document.languageId,
      size: document.size,
      summary: summarizeCode(document, prompt),
    };
  }

  if (languageId === "json" || basename.endsWith(".json")) {
    return {
      path: document.path,
      languageId: document.languageId,
      size: document.size,
      summary: summarizeJson(document),
    };
  }

  return {
    path: document.path,
    languageId: document.languageId,
    size: document.size,
    summary: summarizePlainText(document),
  };
}

function summarizePackageJson(document: FileReadPayload): string {
  try {
    const parsed = JSON.parse(document.content) as Record<string, unknown>;
    const activationEvents = Array.isArray(parsed.activationEvents)
      ? parsed.activationEvents.filter((value): value is string => typeof value === "string")
      : [];
    const contributes = isRecord(parsed.contributes) ? parsed.contributes : {};
    const commands = Array.isArray(contributes.commands) ? contributes.commands : [];
    const commandIds = commands
      .map((item) => (isRecord(item) && typeof item.command === "string" ? item.command : null))
      .filter((value): value is string => Boolean(value));
    return text(
      `${document.path}: package name = ${stringValue(parsed.name) ?? "(missing)"}, version = ${stringValue(parsed.version) ?? "(missing)"}, main = ${stringValue(parsed.main) ?? "(missing)"}, activationEvents = ${activationEvents.length}, contributes.commands = ${commandIds.length}.`,
      `${document.path}：package name = ${stringValue(parsed.name) ?? "（缺失）"}，version = ${stringValue(parsed.version) ?? "（缺失）"}，main = ${stringValue(parsed.main) ?? "（缺失）"}，activationEvents = ${activationEvents.length}，contributes.commands = ${commandIds.length}。`
    );
  } catch {
    return text(
      `${document.path}: package.json is not valid JSON.`,
      `${document.path}：package.json 不是合法 JSON。`
    );
  }
}

function summarizeMarkdown(document: FileReadPayload): string {
  const headings = document.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,6}\s+/.test(line))
    .slice(0, 5)
    .map((line) => line.replace(/^#{1,6}\s+/, ""));
  const headingPart = headings.length ? headings.join(", ") : text("no markdown headings", "没有 markdown 标题");
  return text(
    `${document.path}: markdown headings = ${headingPart}.`,
    `${document.path}：markdown 标题 = ${headingPart}。`
  );
}

function summarizeCode(document: FileReadPayload, prompt?: string): string {
  const exports = extractMatches(document.content, /\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g);
  const commandIds = extractMatches(document.content, /registerCommand\(\s*["'`]([^"'`]+)["'`]/g);
  const classNames = extractMatches(document.content, /\bclass\s+([A-Za-z0-9_]+)/g);
  const emphasis = prompt ?? "";

  const parts: string[] = [];
  if (exports.length) {
    parts.push(text(`exports ${exports.join(", ")}`, `导出 ${exports.join("、")}`));
  }
  if (commandIds.length) {
    parts.push(text(`registerCommand = ${commandIds.length}`, `registerCommand = ${commandIds.length}`));
  }
  if (classNames.length && !/\b(register|command|activate|deactivate)\b/i.test(emphasis)) {
    parts.push(text(`classes ${classNames.slice(0, 4).join(", ")}`, `类 ${classNames.slice(0, 4).join("、")}`));
  }
  if (!parts.length) {
    const preview = firstMeaningfulLine(document.content);
    parts.push(text(`first line = ${preview}`, `首行 = ${preview}`));
  }

  return text(
    `${document.path}: ${parts.join("; ")}.`,
    `${document.path}：${parts.join("；")}。`
  );
}

function summarizeJson(document: FileReadPayload): string {
  try {
    const parsed = JSON.parse(document.content) as Record<string, unknown>;
    const keys = Object.keys(parsed).slice(0, 8);
    return text(
      `${document.path}: top-level keys = ${keys.join(", ") || "(none)"}.`,
      `${document.path}：顶层键 = ${keys.join("、") || "（无）"}。`
    );
  } catch {
    return text(
      `${document.path}: JSON parse failed.`,
      `${document.path}：JSON 解析失败。`
    );
  }
}

function summarizePlainText(document: FileReadPayload): string {
  const preview = document.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" / ");
  return text(
    `${document.path}: preview = ${preview || "(empty file)"}.`,
    `${document.path}：预览 = ${preview || "（空文件）"}。`
  );
}

function chooseRepresentativeFiles(
  entries: Array<{ name: string; path: string; type: "file" | "directory" | "symlink" | "unknown" }>,
  directoryPath: string
): Array<{ name: string; path: string; type: "file" | "directory" | "symlink" | "unknown" }> {
  const preferredNames = new Set([
    "readme.md",
    "index.ts",
    "index.js",
    "extension.ts",
    "extension.js",
    "package.json",
    `${path.basename(directoryPath).toLowerCase()}.ts`,
    `${path.basename(directoryPath).toLowerCase()}.js`,
  ]);

  const preferred = entries.filter((entry) => preferredNames.has(entry.name.toLowerCase()));
  const codeFiles = entries.filter((entry) => /\.(ts|tsx|js|jsx|json|md)$/i.test(entry.name));
  const merged = [...preferred, ...codeFiles].filter(
    (entry, index, array) => array.findIndex((candidate) => candidate.path === entry.path) === index
  );
  return merged.slice(0, 3);
}

function chooseRelevantChildDirectories(basePath: string, topDirectories: string[], prompt?: string): string[] {
  const lowerPrompt = (prompt ?? "").toLowerCase();
  const prioritized = [...topDirectories].sort((left, right) => {
    return scoreDirectoryName(right, lowerPrompt) - scoreDirectoryName(left, lowerPrompt);
  });
  return prioritized.slice(0, 2).map((name) => joinPath(basePath, name));
}

function scoreDirectoryName(name: string, prompt: string): number {
  const normalized = name.toLowerCase();
  let score = 0;
  if (prompt.includes(normalized)) {
    score += 10;
  }
  if (normalized === "src") {
    score += 6;
  }
  if (normalized === "routing" || normalized === "tasks" || normalized === "commands") {
    score += 4;
  }
  if (normalized === "docs") {
    score += 2;
  }
  return score;
}

function joinPath(basePath: string, child: string): string {
  if (!basePath) {
    return child;
  }
  if (/[\\/]$/.test(basePath)) {
    return `${basePath}${child}`;
  }
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath}${separator}${child}`;
}

function normalizePathForDisplay(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatRepositoryChildLabel(workspaceFolder: string, rootPath: string, childPath: string): string {
  const normalizedChild = normalizePathForDisplay(childPath);
  const candidateBases = [rootPath, workspaceFolder]
    .map((value) => normalizePathForDisplay(value))
    .filter(Boolean);

  for (const base of candidateBases) {
    if (normalizedChild === base) {
      continue;
    }
    if (normalizedChild.startsWith(`${base}/`)) {
      return normalizedChild.slice(base.length + 1);
    }
  }

  return normalizedChild;
}

function extractMatches(content: string, pattern: RegExp): string[] {
  const matches = new Set<string>();
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    matches.add(match[1]);
    match = pattern.exec(content);
  }
  return [...matches];
}

function firstMeaningfulLine(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? text("(empty file)", "（空文件）");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}
