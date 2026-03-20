import * as vscode from "vscode";

export async function workspaceInfo(): Promise<{
  name: string | null;
  rootPath: string | null;
  folders: string[];
}> {
  const folders = vscode.workspace.workspaceFolders;
  return {
    name: vscode.workspace.name ?? null,
    rootPath: folders?.[0]?.uri.fsPath ?? null,
    folders: folders?.map((folder) => folder.uri.fsPath) ?? [],
  };
}
