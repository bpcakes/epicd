import { z } from "zod";
import { TrackerIdSchema } from "./tracker.js";
import { IssueStatusSchema } from "./types.js";

/** Verified tracker fields for browsing; null title means it was not loaded. */
export const EpicMetadataSchema = z.object({
  id: TrackerIdSchema,
  title: z.string().min(1).nullable(),
  priority: z.number().int().min(0).max(4),
  status: IssueStatusSchema,
});
export type EpicMetadata = z.infer<typeof EpicMetadataSchema>;

/** Discovery is not a full tracker Issue and grants no authority to operate a saved run. */
export type DiscoveredEpic = EpicMetadata &
  (
    | { details: "available"; parentIds: string[] }
    | { details: "too_large" | "budget_exhausted"; parentIds: null }
  );

export const EPIC_PAGE_SIZE = 50;
export type EpicPageRequest = { offset?: number; search?: string };
export type EpicPage = {
  epics: DiscoveredEpic[];
  offset: number;
  nextOffset: number | null;
};
