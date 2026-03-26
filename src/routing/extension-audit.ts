import { getCurrentLocale } from "../i18n";
import type { FileReadPayload, WorkspaceInfoPayload, WorkspaceInspector } from "./workspace-inspector";

export interface ExtensionAuditResult {
  workspace: WorkspaceInfoPayload;
  summary: string;
  findings: string[];
  packageJson: {
    path: string;
    main: string | null;
    activationEvents: string[];
    commandIds: string[];
  } | null;
  sourceEntry: {
    path: string;
    hasActivate: boolean;
    hasDeactivate: boolean;
    registeredCommands: string[];
  } | null;
  buildEntry: {
    path: string;
    exists: boolean;
    hasActivateExport: boolean;
    hasDeactivateExport: boolean;
  } | null;
}

interface PackageJsonInfo {
  path: string;
  main: string | null;
  activationEvents: string[];
  commandIds: string[];
}

interface SourceEntryInfo {
  path: string;
  hasActivate: boolean;
  hasDeactivate: boolean;
  registeredCommands: string[];
}

interface BuildEntryInfo {
  path: string;
  exists: boolean;
  hasActivateExport: boolean;
  hasDeactivateExport: boolean;
}

export async function inspectExtensionWiring(inspector: WorkspaceInspector): Promise<ExtensionAuditResult> {
  const workspace = await inspector.workspaceInfo();
  const packageDocument = await tryReadFile(inspector, "package.json");

  if (!packageDocument) {
    const summary = text(
      "I could not audit the extension wiring because package.json was not readable from the workspace root.",
      "\u6211\u65e0\u6cd5\u5b8c\u6210\u6269\u5c55\u63a5\u7ebf\u5ba1\u8ba1\uff0c\u56e0\u4e3a\u5de5\u4f5c\u533a\u6839\u76ee\u5f55\u4e0b\u7684 package.json \u4e0d\u53ef\u8bfb\u3002"
    );
    return {
      workspace,
      summary,
      findings: [summary],
      packageJson: null,
      sourceEntry: null,
      buildEntry: null,
    };
  }

  const packageJson = readPackageJson(packageDocument);
  const sourceDocument = await findFirstReadable(inspector, ["src/extension.ts", "extension.ts", "src/extension.js", "extension.js"]);
  const sourceEntry = sourceDocument ? readSourceEntry(sourceDocument) : null;
  const buildPath = packageJson.main ? normalizeRelativePath(packageJson.main) : null;
  const buildDocument = buildPath ? await tryReadFile(inspector, buildPath) : null;
  const buildEntry = buildPath ? readBuildEntry(buildPath, buildDocument) : null;
  const findings = buildAuditFindings(packageJson, sourceEntry, buildEntry);

  return {
    workspace,
    summary: findings.join("\n"),
    findings,
    packageJson,
    sourceEntry,
    buildEntry,
  };
}

function readPackageJson(document: FileReadPayload): PackageJsonInfo {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(document.content) as Record<string, unknown>;
  } catch {
    return {
      path: document.path,
      main: null,
      activationEvents: [],
      commandIds: [],
    };
  }

  const contributes = isRecord(parsed.contributes) ? parsed.contributes : {};
  const commands = Array.isArray(contributes.commands) ? contributes.commands : [];

  return {
    path: document.path,
    main: typeof parsed.main === "string" ? parsed.main : null,
    activationEvents: Array.isArray(parsed.activationEvents)
      ? parsed.activationEvents.filter((value): value is string => typeof value === "string")
      : [],
    commandIds: commands
      .map((item) => (isRecord(item) && typeof item.command === "string" ? item.command : null))
      .filter((value): value is string => Boolean(value)),
  };
}

function readSourceEntry(document: FileReadPayload): SourceEntryInfo {
  const content = document.content;
  return {
    path: document.path,
    hasActivate: /\bexport\s+(async\s+)?function\s+activate\s*\(/.test(content) || /\bfunction\s+activate\s*\(/.test(content),
    hasDeactivate: /\bexport\s+function\s+deactivate\s*\(/.test(content) || /\bfunction\s+deactivate\s*\(/.test(content),
    registeredCommands: extractRegisteredCommands(content),
  };
}

function readBuildEntry(path: string, document: FileReadPayload | null): BuildEntryInfo {
  if (!document) {
    return {
      path,
      exists: false,
      hasActivateExport: false,
      hasDeactivateExport: false,
    };
  }

  return {
    path: document.path,
    exists: true,
    hasActivateExport:
      /\bexports\.activate\b/.test(document.content) ||
      /\bmodule\.exports\.activate\b/.test(document.content) ||
      /\bfunction\s+activate\s*\(/.test(document.content),
    hasDeactivateExport:
      /\bexports\.deactivate\b/.test(document.content) ||
      /\bmodule\.exports\.deactivate\b/.test(document.content) ||
      /\bfunction\s+deactivate\s*\(/.test(document.content),
  };
}

function buildAuditFindings(
  packageJson: PackageJsonInfo,
  sourceEntry: SourceEntryInfo | null,
  buildEntry: BuildEntryInfo | null
): string[] {
  const findings: string[] = [];

  findings.push(
    text(
      `package.json main = ${packageJson.main ?? "(missing)"}. activationEvents = ${packageJson.activationEvents.length}. contributes.commands = ${packageJson.commandIds.length}.`,
      `package.json \u7684 main = ${packageJson.main ?? "\uff08\u7f3a\u5931\uff09"}\uff0cactivationEvents = ${packageJson.activationEvents.length}\uff0ccontributes.commands = ${packageJson.commandIds.length}\u3002`
    )
  );

  if (!sourceEntry) {
    findings.push(
      text(
        "A source entry file was not found in the common extension locations (src/extension.ts, extension.ts, src/extension.js, extension.js).",
        "\u5728\u5e38\u89c1\u7684\u6269\u5c55\u6e90\u7801\u5165\u53e3\u4f4d\u7f6e\uff08src/extension.ts\u3001extension.ts\u3001src/extension.js\u3001extension.js\uff09\u6ca1\u6709\u627e\u5230\u53ef\u8bfb\u7684\u5165\u53e3\u6587\u4ef6\u3002"
      )
    );
  } else {
    findings.push(
      text(
        `${sourceEntry.path} exports activate = ${boolLabel(sourceEntry.hasActivate, "en")}, deactivate = ${boolLabel(sourceEntry.hasDeactivate, "en")}, registerCommand calls = ${sourceEntry.registeredCommands.length}.`,
        `${sourceEntry.path} \u4e2d activate = ${boolLabel(sourceEntry.hasActivate, "zh")}\uff0cdeactivate = ${boolLabel(sourceEntry.hasDeactivate, "zh")}\uff0cregisterCommand \u8c03\u7528 = ${sourceEntry.registeredCommands.length}\u3002`
      )
    );

    const missingInSource = packageJson.commandIds.filter((commandId) => !sourceEntry.registeredCommands.includes(commandId));
    const extraInSource = sourceEntry.registeredCommands.filter((commandId) => !packageJson.commandIds.includes(commandId));
    if (!missingInSource.length && !extraInSource.length) {
      findings.push(
        text(
          "Command registration is aligned between contributes.commands and the source entry.",
          "\u547d\u4ee4\u6ce8\u518c\u5728 contributes.commands \u548c\u6e90\u7801\u5165\u53e3\u4e4b\u95f4\u662f\u5bf9\u9f50\u7684\u3002"
        )
      );
    } else {
      if (missingInSource.length) {
        findings.push(
          text(
            `Commands declared in package.json but not registered in the source entry: ${missingInSource.join(", ")}.`,
            `package.json \u58f0\u660e\u4f46\u6e90\u7801\u5165\u53e3\u6ca1\u6709\u6ce8\u518c\u7684\u547d\u4ee4\uff1a${missingInSource.join(", ")}\u3002`
          )
        );
      }
      if (extraInSource.length) {
        findings.push(
          text(
            `Commands registered in the source entry but not declared in package.json: ${extraInSource.join(", ")}.`,
            `\u6e90\u7801\u5165\u53e3\u5df2\u6ce8\u518c\u4f46 package.json \u6ca1\u6709\u58f0\u660e\u7684\u547d\u4ee4\uff1a${extraInSource.join(", ")}\u3002`
          )
        );
      }
    }
  }

  if (!buildEntry) {
    findings.push(
      text(
        "package.json does not declare a main entry, so build output consistency could not be checked.",
        "package.json \u6ca1\u6709\u58f0\u660e main \u5165\u53e3\uff0c\u56e0\u6b64\u65e0\u6cd5\u68c0\u67e5\u6784\u5efa\u4ea7\u7269\u662f\u5426\u5bf9\u9f50\u3002"
      )
    );
  } else if (!buildEntry.exists) {
    findings.push(
      text(
        `The build entry declared by package.json is not readable: ${buildEntry.path}.`,
        `package.json \u58f0\u660e\u7684\u6784\u5efa\u5165\u53e3\u4e0d\u53ef\u8bfb\uff1a${buildEntry.path}\u3002`
      )
    );
  } else {
    findings.push(
      text(
        `Build output ${buildEntry.path} is readable. activate export = ${boolLabel(buildEntry.hasActivateExport, "en")}, deactivate export = ${boolLabel(buildEntry.hasDeactivateExport, "en")}.`,
        `\u6784\u5efa\u4ea7\u7269 ${buildEntry.path} \u53ef\u8bfb\uff0cactivate \u5bfc\u51fa = ${boolLabel(buildEntry.hasActivateExport, "zh")}\uff0cdeactivate \u5bfc\u51fa = ${boolLabel(buildEntry.hasDeactivateExport, "zh")}\u3002`
      )
    );
  }

  return findings;
}

function extractRegisteredCommands(content: string): string[] {
  const commands = new Set<string>();
  const pattern = /registerCommand\(\s*["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match) {
    commands.add(match[1]);
    match = pattern.exec(content);
  }
  return [...commands];
}

async function findFirstReadable(inspector: WorkspaceInspector, candidates: string[]): Promise<FileReadPayload | null> {
  for (const candidate of candidates) {
    const document = await tryReadFile(inspector, candidate);
    if (document) {
      return document;
    }
  }
  return null;
}

async function tryReadFile(inspector: WorkspaceInspector, filePath: string): Promise<FileReadPayload | null> {
  try {
    return await inspector.fileRead({ path: filePath });
  } catch {
    return null;
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/^[.][\\/]/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function text(en: string, zh: string): string {
  return getCurrentLocale() === "en" ? en : zh;
}

function boolLabel(value: boolean, locale: "en" | "zh"): string {
  if (locale === "en") {
    return value ? "yes" : "no";
  }
  return value ? "\u662f" : "\u5426";
}
