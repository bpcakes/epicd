import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { z } from "zod";
import type { NativeLaunchEndpoint } from "../domain/codex-launch.js";
import { redactSensitiveText } from "../util/redact.js";

export async function herdrSocketIdentity(path: string): Promise<string> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isSocket() || stat.uid !== BigInt(process.getuid!()) || (await realpath(path)) !== path)
    throw new Error("Herdr control socket is not an owned canonical socket");
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/** Native agent.prompt over the documented protocol, avoiding OS per-argument limits for large contexts. */
export async function sendHerdrPrompt(
  endpoint: NativeLaunchEndpoint,
  prompt: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if ((await herdrSocketIdentity(endpoint.socketPath)) !== endpoint.socketIdentity)
    throw new Error("Native Herdr server identity changed");
  const id = randomUUID();
  const wire =
    JSON.stringify({
      id,
      method: "agent.prompt",
      params: { target: endpoint.name, text: prompt },
    }) + "\n";
  if (Buffer.byteLength(wire) > 512 * 1024)
    throw new Error("Native prompt exceeds its bounded transport size");
  await new Promise<void>((resolve, reject) => {
    const socket = connect(endpoint.socketPath);
    let response = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const abort = () =>
      finish(new Error("Native prompt delivery was interrupted; settlement is unknown"));
    const timeout = setTimeout(
      () => finish(new Error("Native prompt acknowledgement timed out; do not resend")),
      15_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    socket.on("error", (error) => finish(error));
    socket.once("connect", () => {
      void (async () => {
        if ((await herdrSocketIdentity(endpoint.socketPath)) !== endpoint.socketIdentity)
          throw new Error("Native server changed before prompt delivery");
        if (!done) socket.write(wire);
      })().catch((error: unknown) =>
        finish(error instanceof Error ? error : new Error("Native prompt admission failed")),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response) > 64 * 1024) {
        finish(new Error("Native prompt acknowledgement exceeds its bound"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope = z
          .object({
            id: z.literal(id),
            result: z.unknown().optional(),
            error: z.object({ code: z.string(), message: z.string() }).optional(),
          })
          .parse(JSON.parse(response.slice(0, newline)));
        if (envelope.error)
          throw new Error(
            redactSensitiveText(`Herdr ${envelope.error.code}: ${envelope.error.message}`, 7999),
          );
        z.object({
          type: z.literal("agent_prompted"),
          agent: z.object({
            name: z.literal(endpoint.name),
            pane_id: z.literal(endpoint.paneId),
            tab_id: z.literal(endpoint.tabId),
            terminal_id: z.literal(endpoint.terminalId),
            workspace_id: z.literal(endpoint.workspaceId),
          }),
        }).parse(envelope.result);
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Invalid native prompt response"));
      }
    });
    socket.once("end", () =>
      finish(new Error("Native prompt connection closed without acknowledgement")),
    );
  });
  if ((await herdrSocketIdentity(endpoint.socketPath)) !== endpoint.socketIdentity)
    throw new Error("Native server changed during prompt delivery");
}
