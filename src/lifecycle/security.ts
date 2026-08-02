const SECRET_FLAG =
  /(--?(?:pass(?:word|phrase)?|token|secret|credential|authorization|api[-_]?key)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^@\s/]+)(@)/gi;

export function redactCommand(command: string): string {
  return command
    .replace(SECRET_FLAG, '$1[REDACTED]')
    .replace(URL_CREDENTIALS, '$1[REDACTED]$3')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]'
    );
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactCommand(message).slice(0, 4000);
}
