import { z } from "zod";

/** Physical identity shared by state attachment and private I/O control storage. */
export const StateFileIdentitySchema = z.strictObject({
  path: z.string().startsWith("/").max(2048),
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
});
export type StateFileIdentity = z.infer<typeof StateFileIdentitySchema>;
