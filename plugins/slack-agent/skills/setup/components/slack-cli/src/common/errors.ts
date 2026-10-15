export enum ExitCode {
  OK = 0,
  User = 1,
  Auth = 2,
  RateLimit = 3,
  Internal = 4,
}

export class SlackCliError extends Error {
  public readonly exitCode: ExitCode;

  constructor(message: string, exitCode: ExitCode = ExitCode.Internal) {
    super(message);
    this.name = 'SlackCliError';
    this.exitCode = exitCode;
  }
}
