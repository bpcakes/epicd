import { z } from "zod";

/** Retained domain records, not arbitrary tables, paths or current authority. */
export const JournalRecordTargetSchema = z.strictObject({
  recordKind: z.enum([
    "validation",
    "review",
    "agent_turn",
    "commit",
    "publication",
    "tracker_operation",
    "fixture_creation",
    "fixture_access",
    "fixture_grant",
    "fixture_sql_grant",
  ]),
  recordId: z.string().min(1).max(256),
});
export type JournalRecordTarget = z.infer<typeof JournalRecordTargetSchema>;
