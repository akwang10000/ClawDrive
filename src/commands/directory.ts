import * as vscode from "vscode";
import { commandFailure } from "../guards/errors";
import { resolveContainedDirectory } from "../guards/workspace-access";

function readOptionalPath(params: unknown): string | undefined {
  if (params === undefined || params === null) {
    return undefined;
  }
  if (typeof params !== "object") {
    throw commandFailure("INVALID_PARAMS", "Expected an object with an optional path field.");
  }

  const value = (params as Record<string, unknown>).path;
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw commandFailure("INVALID_PARAMS", "path must be a string when provided.");
  }
  return value.trim();
}

function fileTypeToLabel(type: vscode.FileType): "file" | "directory" | "symlink" | "unknown" {
  if ((type & vscode.FileType.Directory) !== 0) {
    return "directory";
  }
  if ((type & vscode.FileType.File) !== 0) {
    return "file";
  }
  if ((type & vscode.FileType.SymbolicLink) !== 0) {
    return "symlink";
  }
  return "unknown";
}

export async function directoryList(params: unknown): Promise<{
  path: string;
  workspaceFolder: string;
  entries: Array<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "unknown";
  }>;
}> {
  const target = await resolveContainedDirectory(readOptionalPath(params));
  const entries = await vscode.workspace.fs.readDirectory(target.uri);

  const mapped = entries
    .map(([name, type]) => ({
      name,
      path: `${target.path}${target.path.endsWith("\\") || target.path.endsWith("/") ? "" : pathSeparator()}${name}`,
      type: fileTypeToLabel(type),
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type.localeCompare(right.type);
      }
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });

  return {
    path: target.path,
    workspaceFolder: target.workspaceFolder.uri.fsPath,
    entries: mapped,
  };
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}
