import * as fs from "fs/promises";
import * as path from "path";
import { commandFailure } from "../guards/errors";
import { assertMutationAllowed } from "../guards/policy";
import { resolveContainedPath } from "../guards/workspace-access";
import type { ApplyOperation, TaskApprovalRequest, TaskRunResult } from "./types";

interface PreparedFileChange {
  path: string;
  existed: boolean;
  originalContent: string | null;
  nextContent: string;
}

interface ApplyExecutorOptions {
  readFile?: (filePath: string) => Promise<string>;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
  stat?: (filePath: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

export class StructuredApplyExecutor {
  private readonly readFile: (filePath: string) => Promise<string>;
  private readonly writeFile: (filePath: string, content: string) => Promise<void>;
  private readonly unlink: (filePath: string) => Promise<void>;
  private readonly stat: (filePath: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;

  constructor(options?: ApplyExecutorOptions) {
    this.readFile = options?.readFile ?? (async (filePath) => await fs.readFile(filePath, "utf8"));
    this.writeFile = options?.writeFile ?? (async (filePath, content) => await fs.writeFile(filePath, content, "utf8"));
    this.unlink = options?.unlink ?? (async (filePath) => await fs.unlink(filePath));
    this.stat = options?.stat ?? (async (filePath) => await fs.stat(filePath));
  }

  async apply(request: TaskApprovalRequest): Promise<TaskRunResult> {
    assertMutationAllowed("task.apply");

    if (!request.operations.length) {
      throw commandFailure("APPLY_PRECONDITION_FAILED", "Apply approval did not include any operations.");
    }

    const preparedChanges = await this.prepareChanges(request.operations);
    const writtenPaths: string[] = [];

    try {
      for (const change of preparedChanges) {
        await this.writeFile(change.path, change.nextContent);
        writtenPaths.push(change.path);
      }
    } catch (error) {
      const rollbackFailure = await this.rollback(preparedChanges, writtenPaths);
      if (rollbackFailure) {
        throw commandFailure(
          "APPLY_ROLLBACK_FAILED",
          `${toErrorMessage(error)} Rollback also failed: ${rollbackFailure.message}`
        );
      }
      throw commandFailure("APPLY_EXECUTION_FAILED", toErrorMessage(error));
    }

    const filesChanged = preparedChanges.length;
    const operationsApplied = request.operations.length;
    return {
      summary: `Applied ${operationsApplied} operation(s) across ${filesChanged} file(s).`,
      output: formatApplyOutput(request.operations, preparedChanges.map((change) => change.path)),
      decision: null,
      approval: null,
    };
  }

  private async prepareChanges(operations: ApplyOperation[]): Promise<PreparedFileChange[]> {
    const changes = new Map<string, PreparedFileChange>();

    for (const operation of operations) {
      const target = resolveContainedPath(operation.path);
      const filePath = target.path;
      const current = changes.get(filePath) ?? (await this.loadFileState(filePath));

      if (operation.type === "write_file") {
        current.nextContent = operation.content;
      } else if (operation.type === "replace_text") {
        if (!current.existed) {
          throw commandFailure("APPLY_PRECONDITION_FAILED", `Cannot replace text in a missing file: ${operation.path}`);
        }
        const matches = countOccurrences(current.nextContent, operation.oldText);
        if (matches !== 1) {
          throw commandFailure(
            "APPLY_PRECONDITION_FAILED",
            matches === 0
              ? `Expected old text was not found exactly once in ${operation.path}.`
              : `Expected old text matched multiple times in ${operation.path}.`
          );
        }
        current.nextContent = current.nextContent.replace(operation.oldText, operation.newText);
      } else {
        throw commandFailure("APPLY_UNSUPPORTED_OPERATION", `Unsupported apply operation: ${(operation as { type?: string }).type ?? "unknown"}`);
      }

      changes.set(filePath, current);
    }

    return [...changes.values()];
  }

  private async loadFileState(filePath: string): Promise<PreparedFileChange> {
    const parentDir = path.dirname(filePath);
    try {
      const parentStat = await this.stat(parentDir);
      if (!parentStat.isDirectory()) {
        throw commandFailure("APPLY_PRECONDITION_FAILED", `Target parent is not a directory: ${parentDir}`);
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw commandFailure("APPLY_PRECONDITION_FAILED", `Target parent directory does not exist: ${parentDir}`);
      }
      throw error;
    }

    try {
      const stat = await this.stat(filePath);
      if (!stat.isFile()) {
        throw commandFailure("APPLY_PRECONDITION_FAILED", `Target is not a file: ${filePath}`);
      }
      const content = await this.readFile(filePath);
      return {
        path: filePath,
        existed: true,
        originalContent: content,
        nextContent: content,
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {
          path: filePath,
          existed: false,
          originalContent: null,
          nextContent: "",
        };
      }
      throw error;
    }
  }

  private async rollback(changes: PreparedFileChange[], writtenPaths: string[]): Promise<Error | null> {
    try {
      for (const filePath of [...writtenPaths].reverse()) {
        const change = changes.find((item) => item.path === filePath);
        if (!change) {
          continue;
        }
        if (change.existed) {
          await this.writeFile(change.path, change.originalContent ?? "");
        } else {
          await this.unlink(change.path);
        }
      }
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}

function countOccurrences(content: string, search: string): number {
  if (!search) {
    throw commandFailure("APPLY_PRECONDITION_FAILED", "replace_text requires a non-empty oldText value.");
  }
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const index = content.indexOf(search, offset);
    if (index < 0) {
      break;
    }
    count += 1;
    offset = index + search.length;
  }
  return count;
}

function formatApplyOutput(operations: ApplyOperation[], paths: string[]): string {
  const lines = [
    `Applied ${operations.length} operation(s) across ${paths.length} file(s).`,
    "",
    "Operations:",
  ];
  for (const operation of operations) {
    if (operation.type === "write_file") {
      lines.push(`- write_file ${operation.path}`);
    } else {
      lines.push(`- replace_text ${operation.path}`);
    }
  }
  return lines.join("\n");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
