import { describe, expect, it } from "vitest";
import { readJsonRequest } from "../src/adapters/worker-request.js";

async function* packet(...chunks: Buffer[]) {
  yield* chunks;
}

describe("bounded worker request decoding", () => {
  it("preserves two-, three-, and four-byte characters at every packet split", async () => {
    const value = { path: "/tmp/žluťoučký/日本語/🧪.sqlite3", text: '\\"\n' };
    const bytes = Buffer.from(JSON.stringify(value));
    for (let split = 1; split < bytes.length; split++)
      expect(
        await readJsonRequest(
          packet(bytes.subarray(0, split), bytes.subarray(split)),
          bytes.length,
          "Request",
        ),
      ).toEqual(value);
    expect(
      await readJsonRequest(
        packet(...Array.from(bytes, (byte) => Buffer.from([byte]))),
        bytes.length,
        "Request",
      ),
    ).toEqual(value);
  });

  it("enforces the exact byte limit, including multibyte text", async () => {
    const bytes = Buffer.from(JSON.stringify({ text: "é🧪" }));
    expect(await readJsonRequest(packet(bytes), bytes.length, "Request")).toEqual({ text: "é🧪" });
    await expect(readJsonRequest(packet(bytes), bytes.length - 1, "Request")).rejects.toThrow(
      "Request exceeded its bound",
    );
    await expect(
      readJsonRequest(packet(bytes.subarray(0, 2), bytes.subarray(2)), bytes.length - 1, "Request"),
    ).rejects.toThrow("Request exceeded its bound");
  });

  it.each([[0xc3], [0xff], [0xc3, 0x28]])(
    "rejects malformed UTF-8 instead of substituting characters (%j)",
    async (...invalid) => {
      await expect(
        readJsonRequest(
          packet(Buffer.from('"'), Buffer.from(invalid), Buffer.from('"')),
          100,
          "Request",
        ),
      ).rejects.toThrow(TypeError);
    },
  );

  it("closes an oversized input without consuming subsequent chunks", async () => {
    let closed = false;
    let consumedTail = false;
    async function* oversized() {
      try {
        yield Buffer.alloc(8);
        consumedTail = true;
        yield Buffer.alloc(8);
      } finally {
        closed = true;
      }
    }
    await expect(readJsonRequest(oversized(), 7, "Request")).rejects.toThrow("exceeded its bound");
    expect(closed).toBe(true);
    expect(consumedTail).toBe(false);
  });

  it("propagates input failures and rejects invalid JSON", async () => {
    const failure = new Error("Socket failed");
    async function* broken() {
      yield Buffer.from('{"path":');
      throw failure;
    }
    await expect(readJsonRequest(broken(), 100, "Request")).rejects.toBe(failure);
    await expect(
      readJsonRequest(packet(Buffer.from("{} trailing")), 100, "Request"),
    ).rejects.toThrow(SyntaxError);
  });
});
