import { commandFailure } from "./errors";

export interface CommandPolicyShape {
  command: string;
  mutating: boolean;
}

export function assertMutationAllowed(source: string): void {
  const value = source.trim();
  if (!value) {
    throw commandFailure("COMMAND_DISABLED", "Mutation source must be specified.");
  }
}

export function assertCommandAllowed(definition: CommandPolicyShape): void {
  if (definition.mutating) {
    throw commandFailure("COMMAND_DISABLED", `Mutating command is disabled in Phase 2: ${definition.command}`);
  }
}
