import * as vscode from "vscode";
import { commandFailure } from "../guards/errors";
import { resolveContainedFile } from "../guards/workspace-access";

function readPathParam(params: unknown): string {
  if (!params || typeof params !== "object") {
    throw commandFailure("INVALID_PARAMS", "Expected an object with a path field.");
  }

  const value = (params as Record<string, unknown>).path;
  if (typeof value !== "string" || !value.trim()) {
    throw commandFailure("INVALID_PARAMS", "path must be a non-empty string.");
  }
  return value.trim();
}

export async function fileRead(params: unknown): Promise<{
  path: string;
  workspaceFolder: string;
  content: string;
  languageId: string;
  size: number;
  modifiedTimeMs: number;
}> {
  const target = await resolveContainedFile(readPathParam(params));
  const document = await vscode.workspace.openTextDocument(target.uri);

  return {
    path: target.path,
    workspaceFolder: target.workspaceFolder.uri.fsPath,
    content: document.getText(),
    languageId: document.languageId,
    size: target.stat.size,
    modifiedTimeMs: target.stat.mtime,
  };
}
