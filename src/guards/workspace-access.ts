import * as path from "path";
import * as vscode from "vscode";
import { commandFailure } from "./errors";

export interface WorkspaceTarget {
  path: string;
  uri: vscode.Uri;
  workspaceFolder: vscode.WorkspaceFolder;
}

export interface FileTarget extends WorkspaceTarget {
  stat: vscode.FileStat;
}

export interface DirectoryTarget extends WorkspaceTarget {
  stat: vscode.FileStat;
}

function normalizeFsPath(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithinWorkspace(candidatePath: string, workspaceRootPath: string): boolean {
  const candidate = normalizeFsPath(candidatePath);
  const workspaceRoot = normalizeFsPath(workspaceRootPath);
  return candidate === workspaceRoot || candidate.startsWith(`${workspaceRoot}${path.sep}`);
}

function getWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

function requireWorkspaceFolders(): readonly vscode.WorkspaceFolder[] {
  const folders = getWorkspaceFolders();
  if (!folders.length) {
    throw commandFailure("NO_WORKSPACE", "No workspace folder is open.");
  }
  return folders;
}

export function hasOpenWorkspace(): boolean {
  return getWorkspaceFolders().length > 0;
}

export function isUriInsideWorkspace(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") {
    return false;
  }

  const targetPath = uri.fsPath;
  return getWorkspaceFolders().some((folder) => isWithinWorkspace(targetPath, folder.uri.fsPath));
}

function findWorkspaceByName(folderName: string): vscode.WorkspaceFolder | undefined {
  return getWorkspaceFolders().find((folder) => folder.name === folderName);
}

function pickWorkspaceAndRelativePath(rawPath: string, folders: readonly vscode.WorkspaceFolder[]) {
  const segments = rawPath.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 0) {
    const namedFolder = findWorkspaceByName(segments[0]);
    if (namedFolder) {
      return {
        workspaceFolder: namedFolder,
        relativePath: segments.slice(1).join(path.sep),
      };
    }
  }

  return {
    workspaceFolder: folders[0],
    relativePath: rawPath,
  };
}

export function resolveContainedPath(rawPath: string): WorkspaceTarget {
  const input = rawPath.trim();
  if (!input) {
    throw commandFailure("INVALID_PARAMS", "Path is required.");
  }

  const folders = requireWorkspaceFolders();
  let absolutePath: string;
  let workspaceFolder: vscode.WorkspaceFolder | undefined;

  if (path.isAbsolute(input)) {
    absolutePath = path.resolve(input);
    workspaceFolder = folders.find((folder) => isWithinWorkspace(absolutePath, folder.uri.fsPath));
  } else {
    const picked = pickWorkspaceAndRelativePath(input, folders);
    workspaceFolder = picked.workspaceFolder;
    absolutePath = path.resolve(workspaceFolder.uri.fsPath, picked.relativePath);
  }

  if (!workspaceFolder || !isWithinWorkspace(absolutePath, workspaceFolder.uri.fsPath)) {
    throw commandFailure("PATH_OUTSIDE_WORKSPACE", `Path is outside the open workspace: ${rawPath}`);
  }

  return {
    path: absolutePath,
    uri: vscode.Uri.file(absolutePath),
    workspaceFolder,
  };
}

async function statTarget(target: WorkspaceTarget): Promise<vscode.FileStat> {
  try {
    return await vscode.workspace.fs.stat(target.uri);
  } catch {
    throw commandFailure("FILE_NOT_FOUND", `Target does not exist: ${target.path}`);
  }
}

export async function resolveContainedFile(rawPath: string): Promise<FileTarget> {
  const target = resolveContainedPath(rawPath);
  const stat = await statTarget(target);
  if ((stat.type & vscode.FileType.File) === 0) {
    throw commandFailure("NOT_A_FILE", `Target is not a file: ${target.path}`);
  }
  return { ...target, stat };
}

export async function resolveContainedDirectory(rawPath?: string): Promise<DirectoryTarget> {
  const target =
    rawPath && rawPath.trim()
      ? resolveContainedPath(rawPath)
      : (() => {
          const folder = requireWorkspaceFolders()[0];
          return {
            path: folder.uri.fsPath,
            uri: folder.uri,
            workspaceFolder: folder,
          };
        })();

  const stat = await statTarget(target);
  if ((stat.type & vscode.FileType.Directory) === 0) {
    throw commandFailure("NOT_A_DIRECTORY", `Target is not a directory: ${target.path}`);
  }
  return { ...target, stat };
}
