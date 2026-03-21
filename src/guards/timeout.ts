import { commandFailure } from "./errors";

export async function runWithCommandTimeout<T>(
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<T> {
  return await Promise.race([
    operation(),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(commandFailure("COMMAND_TIMEOUT", `Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }),
  ]);
}
