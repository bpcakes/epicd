import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { herdrSocketIdentity, sendHerdrPrompt } from "../src/adapters/herdr-prompt.js";
import type { NativeLaunchEndpoint } from "../src/domain/codex-launch.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
type Request = { id: string; method: string; params: { target: string; text: string } };
function accepted(request: Request) {
  return {
    id: request.id,
    result: {
      type: "agent_prompted",
      agent: {
        name: request.params.target,
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        terminal_id: "terminal",
        workspace_id: "w1",
      },
    },
  };
}
async function fixture(reply: (socket: Socket, request: Request) => void | Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "epicd-native-prompt-"));
  const path = join(root, "control.sock");
  const requests: Request[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input) as Request;
      requests.push(request);
      void reply(socket, request);
    });
  });
  server.listen(path);
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const endpoint: NativeLaunchEndpoint = {
    sessionName: "test",
    socketPath: path,
    socketIdentity: await herdrSocketIdentity(path),
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "terminal",
    name: "coordinator",
  };
  return { root, endpoint, requests };
}

describe("bounded native Herdr prompt transport", () => {
  it("delivers one exact prompt larger than the OS argument limit over agent.prompt", async () => {
    const setup = await fixture((socket, request) => {
      socket.end(JSON.stringify(accepted(request)) + "\n");
    });
    const prompt = 'quoted "context"\n'.repeat(12_000);
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(128 * 1024);
    await sendHerdrPrompt(setup.endpoint, prompt);
    expect(setup.requests).toEqual([
      {
        id: expect.any(String),
        method: "agent.prompt",
        params: { target: "coordinator", text: prompt },
      },
    ]);
  });

  it.each(["wrong-id", "no-result", "error", "malformed", "oversized"])(
    "rejects %s responses without resubmitting",
    async (kind) => {
      const setup = await fixture((socket, request) => {
        const response =
          kind === "wrong-id"
            ? JSON.stringify({ id: "another-request", result: {} })
            : kind === "no-result"
              ? JSON.stringify({ id: request.id })
              : kind === "error"
                ? JSON.stringify({
                    id: request.id,
                    error: { code: "agent_prompt_stalled", message: "Unknown delivery" },
                  })
                : kind === "oversized"
                  ? "x".repeat(65 * 1024)
                  : "not json";
        socket.end(response + "\n");
      });
      await expect(sendHerdrPrompt(setup.endpoint, "one turn")).rejects.toThrow();
      expect(setup.requests).toHaveLength(1);
    },
  );

  it("does not resend when acknowledgement is lost or delivery is interrupted", async () => {
    const lost = await fixture((socket) => {
      socket.end();
    });
    await expect(sendHerdrPrompt(lost.endpoint, "once")).rejects.toThrow("without acknowledgement");
    expect(lost.requests).toHaveLength(1);
    const controller = new AbortController();
    const aborted = await fixture(() => controller.abort());
    await expect(sendHerdrPrompt(aborted.endpoint, "once", controller.signal)).rejects.toThrow(
      "settlement is unknown",
    );
    expect(aborted.requests).toHaveLength(1);
  });

  it("rejects a correlated response for a replacement terminal", async () => {
    const setup = await fixture((socket, request) => {
      const response = accepted(request);
      response.result.agent.terminal_id = "replacement";
      socket.end(JSON.stringify(response) + "\n");
    });
    await expect(sendHerdrPrompt(setup.endpoint, "once")).rejects.toThrow();
    expect(setup.requests).toHaveLength(1);
  });

  it("rejects excess input, a pre-aborted turn, or a changed server before delivering any bytes", async () => {
    const setup = await fixture(() => undefined);
    await expect(sendHerdrPrompt(setup.endpoint, "x".repeat(512 * 1024))).rejects.toThrow(
      "transport size",
    );
    await expect(sendHerdrPrompt(setup.endpoint, "once", AbortSignal.abort())).rejects.toThrow();
    await expect(
      sendHerdrPrompt({ ...setup.endpoint, socketIdentity: "old-server" }, "once"),
    ).rejects.toThrow("identity changed");
    expect(setup.requests).toHaveLength(0);
    await symlink(setup.endpoint.socketPath, join(setup.root, "alias.sock"));
    await expect(herdrSocketIdentity(join(setup.root, "alias.sock"))).rejects.toThrow(
      "canonical socket",
    );
  });

  it("rejects a server path changed during acknowledgement even if the old socket replies", async () => {
    const setup = await fixture(async (socket, request) => {
      await unlink(setup.endpoint.socketPath);
      socket.end(JSON.stringify(accepted(request)) + "\n");
    });
    await expect(sendHerdrPrompt(setup.endpoint, "once")).rejects.toThrow();
    expect(setup.requests).toHaveLength(1);
  });
});
