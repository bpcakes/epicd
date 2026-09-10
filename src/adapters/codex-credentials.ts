import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { open, realpath } from "node:fs/promises";
import { z } from "zod";

/** Ephemeral access-token input. Managed refresh-token state remains with its existing owner. */
export async function readCodexAccessToken(authCachePath: string): Promise<string> {
  return (await readCodexAccessCache(authCachePath)).tokens.access_token;
}

const accessCacheError = () =>
  new Error(
    "Unable to load a supported Codex access token; refresh the existing login or configure supported authentication",
  );
export async function readCodexAccessCache(authCachePath: string) {
  try {
    return parseAccessCache(await readOwnerFile(authCachePath, 64 * 1024));
  } catch {
    throw accessCacheError();
  }
}
/** Bounded local read at synchronous assignment reservation; launch validates again before projection. */
export function readCodexAccessCacheSync(authCachePath: string) {
  try {
    return parseAccessCache(readOwnerFileSync(authCachePath, 64 * 1024));
  } catch {
    throw accessCacheError();
  }
}
function parseAccessCache(bytes: string) {
  const cache: unknown = JSON.parse(bytes);
  const parsed = z
    .object({
      auth_mode: z.literal("chatgpt").optional(),
      last_refresh: z.string().optional(),
      tokens: z.object({
        access_token: z.string().min(1).max(32_768),
        id_token: z.string().max(32_768).optional(),
        account_id: z.string().max(512).optional(),
      }),
    })
    .safeParse(cache);
  if (!parsed.success) throw new Error("A managed ChatGPT access-token cache is required");
  const token = parsed.data.tokens.access_token;
  if (/[\0\r\n]/.test(token)) throw new Error("Invalid Codex access token");
  return parsed.data;
}
function assertOwnerFile(stat: Stats, limit: number) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.size > limit ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw new Error("Codex control input must be a bounded owner-only regular file");
}
function readOwnerFileSync(path: string, limit: number): string {
  if (realpathSync(path) !== path) throw new Error("Codex control input must be canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assertOwnerFile(fstatSync(fd), limit);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > limit) throw new Error("Codex control input exceeded its byte limit");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export async function readOwnerFile(path: string, limit: number): Promise<string> {
  if ((await realpath(path)) !== path) throw new Error("Codex control input must be canonical");
  // NONBLOCK prevents a replaced FIFO from hanging admission before fstat can reject it.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    assertOwnerFile(stat, limit);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Codex control input exceeded its byte limit");
    return bytes.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}
