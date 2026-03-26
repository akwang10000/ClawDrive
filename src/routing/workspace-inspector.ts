import { diagnosticsGet } from "../commands/diagnostics";
import { directoryList } from "../commands/directory";
import { activeEditor } from "../commands/editor";
import { fileRead } from "../commands/file";
import { workspaceInfo } from "../commands/workspace";

export interface WorkspaceInfoPayload {
  name: string | null;
  rootPath: string | null;
  folders: string[];
}

export interface FileReadPayload {
  path: string;
  workspaceFolder: string;
  content: string;
  languageId: string;
  size: number;
  modifiedTimeMs: number;
}

export interface DirectoryListPayload {
  path: string;
  workspaceFolder: string;
  entries: Array<{
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "unknown";
  }>;
}

export interface WorkspaceInspector {
  workspaceInfo(): Promise<WorkspaceInfoPayload>;
  activeEditor(): Promise<unknown>;
  diagnosticsGet(params?: { path?: string }): Promise<unknown>;
  fileRead(params: { path: string }): Promise<FileReadPayload>;
  directoryList(params?: { path?: string }): Promise<DirectoryListPayload>;
}

export function createWorkspaceInspector(): WorkspaceInspector {
  return {
    workspaceInfo: () => workspaceInfo(),
    activeEditor: () => activeEditor(),
    diagnosticsGet: (params) => diagnosticsGet(params),
    fileRead: (params) => fileRead(params),
    directoryList: (params) => directoryList(params),
  };
}
