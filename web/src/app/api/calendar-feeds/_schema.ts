import { z } from "zod";

/**
 * A feed names what the subscriber sees in their calendar app. project_id
 * omitted or null covers the whole workspace; a value narrows the feed to one
 * project's milestones (existence is checked in the route, not here, because
 * it needs the workspace).
 */
export const createCalendarFeedSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(255),
  project_id: z.string().uuid("project_id must be a UUID").nullable().optional(),
});

export type CreateCalendarFeedInput = z.infer<typeof createCalendarFeedSchema>;
