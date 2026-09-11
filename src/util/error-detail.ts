/** Diagnostics must never replace an original failure with a conversion error. */
export function errorDetail(cause: unknown): string {
  try {
    return String(cause instanceof Error ? cause.message : cause);
  } catch {
    return "Unknown failure";
  }
}
