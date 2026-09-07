import type { ActionRecord } from "../domain/orchestration.js";
import { redactSensitiveText } from "../util/redact.js";

/** Diagnostic preview only. Never use a context copy to authorize an external effect. */
export function actionContextRecord(record: ActionRecord): ActionRecord {
  const copy = structuredClone(record);
  if (copy.result?.status === "succeeded" && copy.result.result.kind === "inspection") {
    // Otherwise an inspect_run result recursively contains every preceding inspection result.
    copy.result.result.text = redactSensitiveText(copy.result.result.text, 1500);
  }
  return copy;
}
