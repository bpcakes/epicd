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
