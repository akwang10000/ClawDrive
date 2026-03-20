import { workspaceInfo } from "./workspace";

type CommandHandler = (params: unknown) => Promise<unknown>;

const handlers = new Map<string, CommandHandler>();

handlers.set("vscode.workspace.info", async () => workspaceInfo());

export function getRegisteredCommands(): string[] {
  return [...handlers.keys()];
}

export async function dispatchCommand(
  command: string,
  params: unknown,
  requestedTimeoutMs?: number
): Promise<
  | { ok: true; payload?: unknown }
  | { ok: false; error: { code: string; message: string } }
> {
  const handler = handlers.get(command);
  if (!handler) {
    return {
      ok: false,
      error: {
        code: "UNKNOWN_COMMAND",
        message: `Unknown command: ${command}`,
      },
    };
  }

  const timeoutMs = Math.max(1_000, Math.min(requestedTimeoutMs ?? 30_000, 30_000));
  try {
    const payload = await Promise.race([
      handler(params),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Command timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, payload };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        code: message.includes("timed out after") ? "COMMAND_TIMEOUT" : "COMMAND_ERROR",
        message,
      },
    };
  }
}
