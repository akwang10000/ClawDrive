import * as vscode from "vscode";
import { commandFailure } from "../guards/errors";
import { hasOpenWorkspace, isUriInsideWorkspace, resolveContainedFile } from "../guards/workspace-access";

type DiagnosticSeverityLabel = "error" | "warning" | "information" | "hint";

interface DiagnosticItem {
  severity: DiagnosticSeverityLabel;
  message: string;
  source: string | null;
  code: string | number | null;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

function severityToLabel(severity: vscode.DiagnosticSeverity): DiagnosticSeverityLabel {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function summarizeItems(items: DiagnosticItem[]) {
  return {
    errorCount: items.filter((item) => item.severity === "error").length,
    warningCount: items.filter((item) => item.severity === "warning").length,
    informationCount: items.filter((item) => item.severity === "information").length,
    hintCount: items.filter((item) => item.severity === "hint").length,
  };
}

function normalizeDiagnosticCode(code: vscode.Diagnostic["code"]): string | number | null {
  if (typeof code === "string" || typeof code === "number") {
    return code;
  }
  if (code && typeof code === "object" && "value" in code) {
    const value = code.value;
    return typeof value === "string" || typeof value === "number" ? value : null;
  }
  return null;
}

function mapDiagnostics(uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): {
  path: string | null;
  uri: string;
  items: DiagnosticItem[];
  summary: ReturnType<typeof summarizeItems>;
} {
  const items = diagnostics.map((diagnostic) => ({
    severity: severityToLabel(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? null,
    code: normalizeDiagnosticCode(diagnostic.code),
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
  }));

  return {
    path: uri.scheme === "file" ? uri.fsPath : null,
    uri: uri.toString(),
    items,
    summary: summarizeItems(items),
  };
}

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

export async function diagnosticsGet(params: unknown): Promise<{
  scope: "path" | "activeEditor" | "workspace";
  targetPath: string | null;
  items: DiagnosticItem[];
  files: Array<{
    path: string | null;
    uri: string;
    diagnosticCount: number;
    summary: ReturnType<typeof summarizeItems>;
  }>;
  summary: ReturnType<typeof summarizeItems>;
}> {
  const rawPath = readOptionalPath(params);
  if (rawPath) {
    const target = await resolveContainedFile(rawPath);
    const mapped = mapDiagnostics(target.uri, vscode.languages.getDiagnostics(target.uri));
    return {
      scope: "path",
      targetPath: target.path,
      items: mapped.items,
      files: [
        {
          path: mapped.path,
          uri: mapped.uri,
          diagnosticCount: mapped.items.length,
          summary: mapped.summary,
        },
      ],
      summary: mapped.summary,
    };
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && isUriInsideWorkspace(activeEditor.document.uri)) {
    const mapped = mapDiagnostics(activeEditor.document.uri, vscode.languages.getDiagnostics(activeEditor.document.uri));
    return {
      scope: "activeEditor",
      targetPath: mapped.path,
      items: mapped.items,
      files: [
        {
          path: mapped.path,
          uri: mapped.uri,
          diagnosticCount: mapped.items.length,
          summary: mapped.summary,
        },
      ],
      summary: mapped.summary,
    };
  }

  if (!hasOpenWorkspace()) {
    throw commandFailure("NO_WORKSPACE", "No workspace folder is open.");
  }

  const fileSummaries = vscode.languages
    .getDiagnostics()
    .filter(([uri]) => isUriInsideWorkspace(uri))
    .map(([uri, diagnostics]) => mapDiagnostics(uri, diagnostics))
    .map((mapped) => ({
      path: mapped.path,
      uri: mapped.uri,
      diagnosticCount: mapped.items.length,
      summary: mapped.summary,
    }))
    .sort((left, right) => (left.path ?? left.uri).localeCompare(right.path ?? right.uri, undefined, { sensitivity: "base" }));

  const summary = {
    errorCount: fileSummaries.reduce((sum, item) => sum + item.summary.errorCount, 0),
    warningCount: fileSummaries.reduce((sum, item) => sum + item.summary.warningCount, 0),
    informationCount: fileSummaries.reduce((sum, item) => sum + item.summary.informationCount, 0),
    hintCount: fileSummaries.reduce((sum, item) => sum + item.summary.hintCount, 0),
  };

  return {
    scope: "workspace",
    targetPath: null,
    items: [],
    files: fileSummaries,
    summary,
  };
}
