import { Socket } from "node:net";

/** JSON packets are bounded as bytes and decoded only after the complete UTF-8 input arrives. */
export async function readJsonRequest(
  input: AsyncIterable<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`${label} exceeded its bound`);
    chunks.push(Buffer.from(chunk));
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    Buffer.concat(chunks, size),
  );
  return JSON.parse(text);
}

/** Fixed workers receive one request on the inherited private socket, never repository stdin. */
export async function readWorkerRequest(label: string): Promise<unknown> {
  const input = new Socket({ fd: 3, readable: true, writable: false });
  try {
    return await readJsonRequest(input, 65_536, label);
  } finally {
    input.destroy();
  }
}
