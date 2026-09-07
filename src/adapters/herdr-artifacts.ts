import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  HerdrTurnResultSchema,
  sameTurn,
  TurnIdentitySchema,
  type TurnIdentity,
} from "../domain/orchestration.js";

const RESULT_LIMIT_BYTES = 1024 * 1024;

export type HerdrResultArtifact = Readonly<{
  identity: Readonly<TurnIdentity>;
  directory: string;
  resultPath: string;
  temporaryPath: string;
}>;

/** One immutable identity per directory. Reading never deletes unacknowledged evidence. */
export class HerdrArtifacts {
  constructor(private readonly root: string) {}

  async prepare(identity: TurnIdentity): Promise<HerdrResultArtifact> {
    const artifact = this.locate(identity);
    await this.ensureParent(artifact);
    // No recursive creation here: a persisted turn may never be silently overwritten/reused.
    await mkdir(artifact.directory, { mode: 0o700 });
    const temporary = await open(artifact.temporaryPath, "wx", 0o600);
    await temporary.close();
    return artifact;
  }

  /** Reconstruct only from trusted persisted identities; never accept an agent-supplied path. */
  locate(identity: TurnIdentity): HerdrResultArtifact {
    const owned = Object.freeze(TurnIdentitySchema.parse(identity));
    const directory = join(
      resolve(this.root),
      owned.runId,
      `${owned.agentId}-${owned.agentGeneration}`,
      owned.turnId,
    );
    return Object.freeze({
      identity: owned,
      directory,
      resultPath: join(directory, "result.json"),
      temporaryPath: join(directory, "result.json.tmp"),
    });
  }

  async read(identity: TurnIdentity): Promise<unknown> {
    const artifact = this.locate(identity);
    await this.assertDirectory(artifact.directory);
    const file = await open(
      artifact.resultPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n) {
        throw new Error("Herdr result must be a regular, unshared file");
      }
      if (before.size > BigInt(RESULT_LIMIT_BYTES))
        throw new Error("Herdr result exceeds size limit");
      const buffer = Buffer.alloc(RESULT_LIMIT_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > RESULT_LIMIT_BYTES) throw new Error("Herdr result exceeds size limit");
      const after = await file.stat({ bigint: true });
      if (
        before.size !== BigInt(length) ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      ) {
        throw new Error("Herdr result changed while being read");
      }
      const envelope = HerdrTurnResultSchema.parse(JSON.parse(buffer.toString("utf8", 0, length)));
      if (!sameTurn(envelope.identity, artifact.identity)) {
        throw new Error("Herdr result belongs to a different turn or generation");
      }
      return envelope.result;
    } finally {
      await file.close();
    }
  }

  /** The caller must first persist consumption and establish that the owned process stopped. */
  async removeAcknowledged(identity: TurnIdentity): Promise<void> {
    const artifact = this.locate(identity);
    await this.assertDirectory(artifact.directory);
    // Exact known files only. Never sweep a run or another agent's directory.
    await rm(artifact.resultPath, { force: true });
    await rm(artifact.temporaryPath, { force: true });
  }

  private async ensureParent(artifact: HerdrResultArtifact): Promise<void> {
    const root = resolve(this.root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.assertDirectory(root);
    const run = join(root, artifact.identity.runId);
    await mkdir(run, { recursive: true, mode: 0o700 });
    await this.assertDirectory(run);
    const agent = join(run, `${artifact.identity.agentId}-${artifact.identity.agentGeneration}`);
    await mkdir(agent, { recursive: true, mode: 0o700 });
    await this.assertDirectory(agent);
  }

  private async assertDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || (await realpath(path)) !== resolve(path)) {
      throw new Error("Herdr artifact directory is not an owned canonical directory");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new Error("Herdr artifact directory must be owner-only");
    }
  }
}

export function herdrResultContract(
  prompt: string,
  outputSchema: unknown,
  artifact: HerdrResultArtifact,
): string {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "identity", "result"],
    properties: {
      schemaVersion: { const: 1 },
      identity: { const: artifact.identity },
      result: outputSchema ?? { type: "object" },
    },
  };
  return `${prompt}

EPICD HERDR TURN RESULT
The terminal response is not the machine-readable handoff. Write an envelope conforming to
this schema to ${JSON.stringify(artifact.temporaryPath)}, then atomically rename it to
${JSON.stringify(artifact.resultPath)} before ending this turn:
${JSON.stringify(schema)}
The identity is supplied by the controller and must be copied exactly. Include a structured
blocked result when you cannot finish. Do not write another turn's files.`;
}
