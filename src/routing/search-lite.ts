import * as path from "path";
import { getCurrentLocale } from "../i18n";
import type { WorkspaceInspector } from "./workspace-inspector";

export interface SearchLiteMatch {
  path: string;
  kind: "content" | "filename";
  line: number | null;
  preview: string;
}

export interface SearchLiteResult {
  query: string;
  summary: string;
  findings: string[];
  matches: SearchLiteMatch[];
  scannedDirectories: number;
  scannedFiles: number;
  truncated: boolean;
}

interface QueueItem {
  path: string;
  depth: number;
}

const MAX_DEPTH = 3;
const MAX_DIRECTORIES = 20;
const MAX_CANDIDATE_FILES = 80;
const MAX_FILE_READS = 24;
const MAX_MATCHES = 5;
const SKIP_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage", "out-test"]);
const SEARCHABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md"]);

export async function inspectSearchLite(inspector: WorkspaceInspector, query: string): Promise<SearchLiteResult> {
  const workspace = await inspector.workspaceInfo();
  const root = workspace.rootPath ?? workspace.folders[0] ?? "";
  if (!root) {
    const summary = text("I could not run local search because no workspace is open.", "当前没有打开工作区，无法执行本地搜索。");
    return {
      query,
      summary,
      findings: [summary],
      matches: [],
      scannedDirectories: 0,
      scannedFiles: 0,
      truncated: false,
    };
  }

  const queue: QueueItem[] = [{ path: root, depth: 0 }];
  const visited = new Set<string>();
  const candidates: Array<{ path: string; score: number; filenameMatch: boolean }> = [];
  let scannedDirectories = 0;
  let truncated = false;

  while (queue.length && scannedDirectories < MAX_DIRECTORIES && candidates.length < MAX_CANDIDATE_FILES) {
    const current = queue.shift();
    if (!current || visited.has(current.path)) {
      continue;
    }
    visited.add(current.path);

    let listing;
    try {
      listing = await inspector.directoryList({ path: current.path });
    } catch {
      continue;
    }

    scannedDirectories += 1;

    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        if (current.depth >= MAX_DEPTH || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
          continue;
        }
        queue.push({ path: entry.path, depth: current.depth + 1 });
        continue;
      }

      if (entry.type !== "file" || !isSearchableFile(entry.name)) {
        continue;
      }

      const score = scoreCandidate(entry.path, query);
      if (score > 0 || candidates.length < MAX_CANDIDATE_FILES / 2) {
        candidates.push({
          path: entry.path,
          score,
          filenameMatch: score > 0,
        });
      }

      if (candidates.length >= MAX_CANDIDATE_FILES) {
        truncated = true;
        break;
      }
    }
  }

  if (queue.length) {
    truncated = true;
  }

  const orderedCandidates = candidates
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, MAX_FILE_READS);

  const matches: SearchLiteMatch[] = [];
  let scannedFiles = 0;

  for (const candidate of orderedCandidates) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }

    scannedFiles += 1;
    let document;
    try {
      document = await inspector.fileRead({ path: candidate.path });
    } catch {
      continue;
    }

    const contentMatch = findContentMatch(document.content, query);
    if (contentMatch) {
      matches.push({
        path: normalizePathForDisplay(candidate.path),
        kind: "content",
        line: contentMatch.line,
        preview: contentMatch.preview,
      });
      continue;
    }

    if (candidate.filenameMatch) {
      matches.push({
        path: normalizePathForDisplay(candidate.path),
        kind: "filename",
        line: null,
        preview: text("The filename is a likely match.", "文件名是一个可能匹配。"),
      });
    }
  }

  const findings =
    matches.length > 0
      ? [
          text(
            `I found ${matches.length} likely local match${matches.length === 1 ? "" : "es"} for ${query}.`,
            `我在受限本地搜索中找到了 ${matches.length} 个与 ${query} 相关的可能匹配。`
          ),
          ...matches.map((match) => formatMatch(match)),
        ]
      : [
          text(
            `I did not find an exact local match for ${query} in the bounded grounded search.`,
            `我在受限 grounded 本地搜索中没有找到 ${query} 的精确匹配。`
          ),
        ];

  if (truncated) {
    findings.push(
      text(
        "The search stayed bounded and may have skipped deeper or lower-priority files.",
        "本次搜索保持了受限范围，可能跳过了更深层或优先级更低的文件。"
      )
    );
  }

  return {
    query,
    summary: findings.join("\n"),
    findings,
    matches,
    scannedDirectories,
    scannedFiles,
    truncated,
  };
}

function findContentMatch(content: string, query: string): { line: number; preview: string } | null {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(query)) {
      return {
        line: index + 1,
        preview: line.trim().slice(0, 160),
      };
    }
  }
  return null;
}

function scoreCandidate(candidatePath: string, query: string): number {
  const normalizedPath = candidatePath.replace(/\\/g, "/").toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  const queryTail = normalizedQuery.split(/[./\\]/).filter(Boolean).pop() ?? normalizedQuery;
  let score = 0;

  if (normalizedPath.includes(normalizedQuery)) {
    score += 10;
  }
  if (queryTail && normalizedPath.includes(queryTail)) {
    score += 5;
  }
  if (path.basename(normalizedPath) === `${queryTail}.ts` || path.basename(normalizedPath) === `${queryTail}.js`) {
    score += 3;
  }
  return score;
}

function isSearchableFile(name: string): boolean {
  return SEARCHABLE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function normalizePathForDisplay(value: string): string {
  return value.replace(/\\/g, "/");
}

function formatMatch(match: SearchLiteMatch): string {
  if (match.kind === "content" && match.line) {
    return text(
      `${match.path}:${match.line} -> ${match.preview}`,
      `${match.path}:${match.line} -> ${match.preview}`
    );
  }
  return text(
    `${match.path} -> ${match.preview}`,
    `${match.path} -> ${match.preview}`
  );
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}
