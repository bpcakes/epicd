import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

/**
 * Configuration owned by one agent generation.  Credentials deliberately do
 * not appear here; the agent's accountBinding remains the only credential
 * reference in the durable record.
 */
export const AgentExecutionPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) => isAbsolute(path) && resolve(path) === path && path !== "/" && !path.includes("\0"),
    "Execution paths must be canonical absolute paths",
  );

export const AgentExecutionSchema = z
  .strictObject({
    executable: AgentExecutionPathSchema,
    runtimeRoot: AgentExecutionPathSchema,
    turnTimeoutMs: z.number().int().min(1).max(21_600_000),
    herdr: z
      .strictObject({
        executable: AgentExecutionPathSchema,
        sessionName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
        workspaceId: z.string().min(1).max(256),
      })
      .nullable(),
  })
  .readonly();

export type AgentExecution = z.infer<typeof AgentExecutionSchema>;
