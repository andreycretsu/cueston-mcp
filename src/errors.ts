/** A failure to report to the person: printed without a stack trace, exit code 1. */
export class CliError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
    public readonly exitCode = 1
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Wrong arguments or flags: exit code 2. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, hint, 2);
    this.name = "UsageError";
  }
}

/** An error response from the Cueston API (`{ error, code, details? }`). */
export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: string[] = [],
    public readonly body: unknown = null,
    hint?: string
  ) {
    super(message, hint);
    this.name = "ApiError";
  }
}
