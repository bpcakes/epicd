const sensitiveAssignment =
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|client[_-]?secret|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;
const sensitiveFlag =
  /((?:--(?:api-key|api_key|apikey|access-token|access_token|auth-token|auth_token|token|password|client-secret|client_secret|secret|authorization))(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi;

export function redactSensitiveText(value: string, maxLength = 8_000): string {
  const redacted = value
    .replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(sensitiveAssignment, "$1[REDACTED]")
    .replace(sensitiveFlag, "$1[REDACTED]")
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@");
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength)}…`;
}

/** Diagnostic retention redacts complete input before clipping or paging it. Best effort, not a secret detector. */
export function redactDiagnosticText(value: string): string {
  return redactSensitiveText(
    value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(
        /("(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|session[_-]?token|token|password|client[_-]?secret|secret|authorization|cookie|set-cookie|private[_-]?key)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
        '$1"[REDACTED]"',
      )
      .replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@"),
    Infinity,
  );
}
