import type { ActionRecord } from "../domain/orchestration.js";
import { redactSensitiveText } from "../util/redact.js";

/** Diagnostic preview only. Never use a context copy to authorize an external effect. */
export function actionContextRecord(record: ActionRecord, preservePage: boolean): ActionRecord {
  const copy = structuredClone(record);
  if (
    copy.result?.status === "succeeded" &&
    copy.result.result.kind === "inspection" &&
    !(preservePage && ["inspect_observation", "inspect_action"].includes(copy.request.action.kind))
  ) {
    // Otherwise an inspect_run result recursively contains every preceding inspection result.
    const preview = redactSensitiveText(copy.result.result.text, 1500);
    copy.result.result.text =
      copy.result.result.text.length > 1500
        ? `${preview}\n[Preview only; use inspect_action ${copy.actionId} at offset 0 with expectedDigest null for the retained request/result.]`
        : preview;
  }
  return copy;
}
