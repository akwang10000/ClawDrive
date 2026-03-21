import * as vscode from "vscode";
import { isUriInsideWorkspace } from "../guards/workspace-access";

export async function activeEditor(): Promise<{
  hasActiveEditor: boolean;
  path: string | null;
  uri: string | null;
  workspaceScoped: boolean;
  languageId: string | null;
  isDirty: boolean;
  version: number | null;
  selections: Array<{
    start: { line: number; character: number };
    end: { line: number; character: number };
    isReversed: boolean;
  }>;
}> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return {
      hasActiveEditor: false,
      path: null,
      uri: null,
      workspaceScoped: false,
      languageId: null,
      isDirty: false,
      version: null,
      selections: [],
    };
  }

  const document = editor.document;
  return {
    hasActiveEditor: true,
    path: document.uri.scheme === "file" ? document.uri.fsPath : null,
    uri: document.uri.toString(),
    workspaceScoped: isUriInsideWorkspace(document.uri),
    languageId: document.languageId,
    isDirty: document.isDirty,
    version: document.version,
    selections: editor.selections.map((selection) => ({
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      isReversed: selection.isReversed,
    })),
  };
}
