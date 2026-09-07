import { mkdtemp, readFile, writeFile, symlink, link, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HerdrArtifacts, herdrResultContract } from "../src/adapters/herdr-artifacts.js";
import type { TurnIdentity } from "../src/domain/orchestration.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const identity: TurnIdentity = {
  runId: "run-one",
  agentId: "agent-one",
  agentGeneration: 1,
  turnId: "turn-one",
  assignmentId: "assignment-one",
  operationId: "operation-one",
  workspaceId: "workspace-one",
  workspaceGeneration: 1,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "epicd-artifacts-"));
  roots.push(root);
  return { root, artifacts: new HerdrArtifacts(join(root, "herdr")) };
}

function result(turn: TurnIdentity = identity) {
  return JSON.stringify({ schemaVersion: 1, identity: turn, result: { answer: "ok" } });
}

describe("correlated Herdr artifacts", () => {
  it("preserves results until acknowledged and removes only the exact turn's files", async () => {
    const { artifacts } = await fixture();
    const other = { ...identity, agentId: "agent-two" };
    const first = await artifacts.prepare(identity);
    const second = await artifacts.prepare(other);
    await writeFile(first.resultPath, result());
    await writeFile(second.resultPath, result(other));
    expect(await artifacts.read(identity)).toEqual({ answer: "ok" });
    expect(await readFile(first.resultPath, "utf8")).toBe(result());
    await artifacts.removeAcknowledged(identity);
    await expect(readFile(first.resultPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await artifacts.read(other)).toEqual({ answer: "ok" });
  });

  it("reconstructs the same location after controller restart without overwriting it", async () => {
    const { root, artifacts } = await fixture();
    const prepared = await artifacts.prepare(identity);
    await writeFile(prepared.resultPath, result());
    const restarted = new HerdrArtifacts(join(root, "herdr"));
    expect(await restarted.read(identity)).toEqual({ answer: "ok" });
    await expect(restarted.prepare(identity)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it.each(Object.keys(identity) as (keyof TurnIdentity)[])(
    "rejects an old or foreign %s",
    async (key) => {
      const { artifacts } = await fixture();
      const prepared = await artifacts.prepare(identity);
      const wrong = { ...identity, [key]: typeof identity[key] === "number" ? 2 : "stale" };
      await writeFile(prepared.resultPath, result(wrong));
      await expect(artifacts.read(identity)).rejects.toThrow("different turn or generation");
    },
  );

  it("rejects path traversal before creating anything", async () => {
    const { artifacts } = await fixture();
    await expect(artifacts.prepare({ ...identity, turnId: "../escape" })).rejects.toThrow();
  });

  it("refuses symlink results without changing their target", async () => {
    const { root, artifacts } = await fixture();
    const prepared = await artifacts.prepare(identity);
    const outside = join(root, "outside.json");
    await writeFile(outside, result());
    await symlink(outside, prepared.resultPath);
    await expect(artifacts.read(identity)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe(result());
  });

  it("refuses hard-linked and oversized result files", async () => {
    const { root, artifacts } = await fixture();
    const prepared = await artifacts.prepare(identity);
    await writeFile(prepared.resultPath, result());
    const alias = join(root, "alias.json");
    await link(prepared.resultPath, alias);
    await expect(artifacts.read(identity)).rejects.toThrow("unshared");
    await rm(alias);
    await writeFile(prepared.resultPath, "x".repeat(1024 * 1024 + 1));
    await expect(artifacts.read(identity)).rejects.toThrow("size limit");
  });

  it("rejects a swapped directory without reading or deleting the target", async () => {
    const { root, artifacts } = await fixture();
    const prepared = await artifacts.prepare(identity);
    await rm(prepared.directory, { recursive: true });
    await symlink(root, prepared.directory);
    await writeFile(join(root, "result.json"), "user-owned");
    await expect(artifacts.read(identity)).rejects.toThrow("canonical");
    await expect(artifacts.removeAcknowledged(identity)).rejects.toThrow("canonical");
    expect(await readFile(join(root, "result.json"), "utf8")).toBe("user-owned");
  });

  it("uses private directories and embeds the exact controller identity in the prompt", async () => {
    const { artifacts } = await fixture();
    const prepared = await artifacts.prepare(identity);
    const prompt = herdrResultContract("Review independently", { type: "object" }, prepared);
    const schemaLine = prompt.split("\n").find((line) => line.startsWith('{"type":"object"'));
    expect(JSON.parse(schemaLine!).properties.identity.const).toEqual(identity);
    expect(prompt).toContain(JSON.stringify(prepared.resultPath));
    if (process.platform !== "win32") {
      expect((await stat(prepared.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(prepared.temporaryPath)).mode & 0o777).toBe(0o600);
      await chmod(prepared.directory, 0o755);
      await expect(artifacts.read(identity)).rejects.toThrow("owner-only");
    }
  });
});
