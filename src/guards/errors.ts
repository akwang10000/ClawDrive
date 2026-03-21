export class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "CommandFailure";
  }
}

export function commandFailure(code: string, message: string): CommandFailure {
  return new CommandFailure(code, message);
}

export function isCommandFailure(error: unknown): error is CommandFailure {
  return error instanceof CommandFailure;
}

export function mapUnknownCommandError(error: unknown): CommandFailure {
  if (isCommandFailure(error)) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return commandFailure("COMMAND_ERROR", message);
}
