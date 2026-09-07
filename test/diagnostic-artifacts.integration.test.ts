import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import type {
  ControllerAuthority,
  KernelAction,
  ObservationInput,
} from "../src/domain/orchestration.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture(budget = 100 * 1024 * 1024) {
  const root = mkdtempSync("/var/tmp/epicd-diagnostics-");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "state.sqlite3");
  let store = new StateStore(path);
  cleanups.push(() => store.close());
  const state = store.create(
    initialRun(),
    RepositoryPolicySchema.parse({ schemaVersion: 1, budgets: { artifactBytes: budget } }),
  );
  const lease = store.acquireLease(state.runId);
  let authority: ControllerAuthority = {
    runId: state.runId,
    ownerToken: lease.ownerToken,
    leaseId: lease.leaseId,
  };
  const db = new Database(path);
  cleanups.push(() => db.close());
  const input = (id = randomUUID()): Omit<ObservationInput, "artifactIds"> => ({
    source: "controlled-sdk",
    sourceEventId: id,
    kind: "runtime.command.completed",
    summary: "Browser check reported a failure; inspect the diagnostic",
    identity: null,
    wakesOrchestrator: true,
  });
  const append = (text: string, event = input(), sourceTruncated = false) =>
    store.orchestration.diagnostics.append(authority, event, text, sourceTruncated);
  const execute = async (action: KernelAction) => {
    const journal = store.orchestration;
    const ticket = journal.beginDecision(
      authority,
      journal.latestObservationCursor(authority.runId),
      journal.control(authority.runId).controlVersion,
    );
    return new ActionKernel(journal).execute(
      {
        explanation: "Inspect retained failure evidence",
        evidenceIds: [],
        request: {
          schemaVersion: 1,
          decisionId: ticket.decisionId,
          observationCursor: ticket.observationCursor,
          expectedControlVersion: ticket.expectedControlVersion,
          action,
        },
      },
      authority,
    );
  };
  return {
    root,
    path,
    db,
    input,
    append,
    execute,
    get store() {
      return store;
    },
    get authority() {
      return authority;
    },
    reopen: () => {
      store.close();
      store = new StateStore(path);
    },
    replaceLease: () => {
      store.releaseLease(authority.runId, authority.ownerToken);
      const lease = store.acquireLease(state.runId);
      authority = { runId: state.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
    },
  };
}

describe("retained diagnostic artifacts", () => {
  it("atomically retains a redacted observation reference and exposes pages through the actual kernel capability", async () => {
    const s = fixture();
    const { artifact, observation } = s.append(
      'first\n{"password":"do-not-retain"}\nfailed: peer authentication\n',
    );
    expect(observation.artifactIds).toEqual([artifact.artifactId]);
    expect(observation.summary).toContain("Not validation or approval");
    const outcome = await s.execute({
      kind: "inspect_artifact",
      artifactId: artifact.artifactId,
      offset: 6,
      limit: 40,
    });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded" || outcome.result.kind !== "inspection")
      throw new Error(JSON.stringify(outcome));
    const page = JSON.parse(outcome.result.text);
    expect(page).toMatchObject({
      text: '{"password":"[REDACTED]"}\nfailed: peer a',
      nextOffset: 46,
      sourceTruncated: false,
      locallyTruncated: false,
    });
    expect(page.evidenceWarning).toContain("never validation");
    expect(s.store.orchestration.delivery.summaries(s.authority.runId)).toMatchObject({
      candidates: [],
      validation: [],
    });
    expect(JSON.stringify(s.db.prepare("SELECT * FROM diagnostic_artifacts").all())).not.toContain(
      "do-not-retain",
    );
    expect(s.store.orchestration.control(s.authority.runId).status).toBe("active");
  });

  it("keeps long output beyond the observation preview accessible and visible in cold context", () => {
    const s = fixture();
    const text = "x".repeat(12000) + "diagnostic-tail";
    const { artifact } = s.append(text);
    s.reopen();
    const context = buildOrchestratorContext(
      new ActionKernel(s.store.orchestration),
      s.authority.runId,
    );
    expect(context.diagnostics.latest).toContainEqual(artifact);
    expect(context.observations.some((row) => row.artifactIds.includes(artifact.artifactId))).toBe(
      true,
    );
    expect(JSON.stringify(context)).not.toContain(text);
    expect(
      s.store.orchestration.diagnostics.read(s.authority.runId, artifact.artifactId, 12000, 100)
        .text,
    ).toBe("diagnostic-tail");
    if (process.platform !== "win32") expect(statSync(s.path).mode & 0o777).toBe(0o600);
  });

  it("deduplicates exact reconnects without new rows or charges and detects conflicts hidden by redaction", () => {
    const s = fixture();
    const event = s.input();
    const first = s.append("token=one", event);
    const usage = s.store.orchestration.diagnostics.usage(s.authority.runId);
    s.reopen();
    expect(s.append("token=one", event)).toEqual(first);
    expect(s.store.orchestration.diagnostics.usage(s.authority.runId)).toEqual(usage);
    expect(() => s.append("token=two", event)).toThrow("reused with different content");
    expect(s.db.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({ count: 1 });
  });

  it("rolls back diagnostic retention and its budget charge when the observation cannot be persisted", () => {
    const s = fixture();
    const event = s.input();
    const spy = vi.spyOn(s.store.orchestration, "appendObservation").mockImplementationOnce(() => {
      throw new Error("observation write failed");
    });
    expect(() => s.append("failed check", event)).toThrow("observation write failed");
    expect(s.store.orchestration.diagnostics.usage(s.authority.runId)).toEqual({
      count: 0,
      retainedBytes: 0,
    });
    spy.mockRestore();
    expect(s.append("failed check", event).observation.artifactIds).toHaveLength(1);
  });

  it("does not allow a stale controller to retain output after lease replacement", () => {
    const s = fixture();
    const old = s.authority;
    s.replaceLease();
    expect(() =>
      s.store.orchestration.diagnostics.append(old, s.input(), "late old-controller output"),
    ).toThrow();
    expect(s.store.orchestration.diagnostics.usage(s.authority.runId).count).toBe(0);
    expect(s.append("new generation output").artifact.retainedBytes).toBeGreaterThan(0);
  });

  it("rejects missing and foreign artifact references without blocking the run", async () => {
    const s = fixture();
    const { artifact } = s.append("this-run-only");
    expect(() =>
      s.store.orchestration.diagnostics.read("foreign-run", artifact.artifactId, 0, 100),
    ).toThrow("not retained in this run");
    expect(
      await s.execute({
        kind: "inspect_artifact",
        artifactId: "../../auth.json",
        offset: 0,
        limit: 100,
      }),
    ).toMatchObject({ status: "rejected", code: "invalid_artifact_reference" });
    expect(s.store.orchestration.control(s.authority.runId).status).toBe("active");
  });

  it("preserves prior diagnostics and atomically escalates exhaustion without refilling on reopen", () => {
    const s = fixture(12);
    const first = s.append("1234567890");
    const event = s.input();
    const denied = s.append("cannot fit", event);
    expect(denied.artifact).toMatchObject({
      omission: "budget_exhausted",
      retainedBytes: 0,
      locallyTruncated: true,
    });
    expect(s.store.orchestration.control(s.authority.runId).status).toBe("awaiting_user");
    expect(s.db.prepare("SELECT reason FROM escalations WHERE status = 'pending'").get()).toEqual({
      reason: "diagnostic_budget_exhausted",
    });
    s.reopen();
    expect(s.store.orchestration.diagnostics.usage(s.authority.runId)).toEqual({
      count: 2,
      retainedBytes: 10,
    });
    expect(s.append("cannot fit", event)).toEqual(denied);
    expect(s.db.prepare("SELECT COUNT(*) AS count FROM escalations").get()).toEqual({ count: 1 });
    expect(
      s.store.orchestration.diagnostics.read(s.authority.runId, first.artifact.artifactId, 0, 100)
        .text,
    ).toBe("1234567890");
    expect(
      s.store.orchestration.diagnostics.read(s.authority.runId, denied.artifact.artifactId, 0, 100),
    ).toMatchObject({ text: "", nextOffset: null, omission: "budget_exhausted" });
  });

  it("rolls back a budget omission if the accompanying escalation cannot be persisted", () => {
    const s = fixture(1);
    vi.spyOn(s.store.orchestration, "setEscalation").mockImplementationOnce(() => {
      throw new Error("escalation failed");
    });
    expect(() => s.append("more than one byte")).toThrow("escalation failed");
    expect(s.store.orchestration.diagnostics.usage(s.authority.runId).count).toBe(0);
    expect(s.store.orchestration.observations(s.authority.runId)).toEqual([]);
    expect(s.store.orchestration.control(s.authority.runId).status).toBe("active");
  });

  it("retains bounded UTF-8 head and tail, redacting complete secrets before clipping", () => {
    const s = fixture();
    const raw = 'password="' + "private".repeat(12000) + '"\n' + "🐑".repeat(20000) + "\ntail";
    const { artifact } = s.append(raw);
    const page = s.store.orchestration.diagnostics.read(
      s.authority.runId,
      artifact.artifactId,
      0,
      65536,
    );
    expect(artifact).toMatchObject({
      locallyTruncated: true,
      sourceTruncated: false,
      omission: null,
    });
    expect(artifact.retainedBytes).toBeLessThanOrEqual(65536);
    const row = s.db.prepare("SELECT content FROM diagnostic_artifacts").get() as {
      content: string;
    };
    expect(row.content).toContain("password=[REDACTED]");
    expect(row.content).toContain("[diagnostic content omitted]");
    expect(row.content).toMatch(/tail$/);
    expect(row.content).not.toContain("private");
    expect(row.content).not.toContain("�");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64000);
  });

  it("pages immutable redacted characters, including Unicode and heavily escaped text, without loss", () => {
    const s = fixture();
    const text = '🐑\n{"cookie":"do-not-retain"}\n' + "\x01".repeat(15000);
    const { artifact } = s.append(text);
    let offset = 0,
      reconstructed = "";
    for (let i = 0; i < 100; i++) {
      const page = s.store.orchestration.diagnostics.read(
        s.authority.runId,
        artifact.artifactId,
        offset,
        65536,
      );
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(64000);
      reconstructed += page.text;
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(reconstructed).toBe('🐑\n{"cookie":"[REDACTED]"}\n' + "\x01".repeat(15000));
    expect(
      s.store.orchestration.diagnostics.read(s.authority.runId, artifact.artifactId, 100000, 100),
    ).toMatchObject({ text: "", nextOffset: null });
  });

  it("labels native terminal excerpts and rejects oversized input without pretending an empty result is complete", () => {
    const s = fixture();
    const excerpt = s.append(
      "visible native screen",
      { ...s.input(), source: "controlled-herdr", kind: "runtime.native_terminal" },
      true,
    );
    expect(excerpt.artifact).toMatchObject({ sourceTruncated: true, locallyTruncated: false });
    const omitted = s.append("x".repeat(4 * 1024 * 1024 + 1));
    expect(omitted.artifact).toMatchObject({
      omission: "input_too_large",
      retainedBytes: 0,
      locallyTruncated: true,
    });
    expect(omitted.observation.summary).toContain("input_too_large");
  });

  it("fails integrity checks for changed retained content without manufacturing fresh evidence", async () => {
    const s = fixture();
    const { artifact } = s.append("failed test");
    s.db.prepare("UPDATE diagnostic_artifacts SET content = 'passed test'").run();
    await expect(
      s.execute({
        kind: "inspect_artifact",
        artifactId: artifact.artifactId,
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("integrity");
  });

  it("reopens current-format diagnostics without changing rows or creating migration backups", () => {
    const s = fixture();
    const { artifact } = s.append("retained current-format observation");
    const original = s.db.prepare("SELECT * FROM observations").all();
    s.reopen();
    expect(s.db.prepare("SELECT MAX(version) AS version FROM orchestration_schema").get()).toEqual({
      version: 26,
    });
    expect(s.db.prepare("SELECT * FROM observations").all()).toEqual(original);
    expect(
      s.store.orchestration.diagnostics.read(s.authority.runId, artifact.artifactId, 0, 100).text,
    ).toBe("retained current-format observation");
    const snapshots = readdirSync(s.root).filter((name) => name.includes("before-orchestration"));
    expect(snapshots).toEqual([]);
  });

  it("preserves diagnostic bytes and observation references in raw quarantine", () => {
    const s = fixture();
    s.append("retained failed check");
    const original = s.db.prepare("SELECT * FROM diagnostic_artifacts").get();
    s.store.releaseLease(s.authority.runId, s.authority.ownerToken);
    s.db.prepare("UPDATE runs SET state_json = 'broken' WHERE run_id = ?").run(s.authority.runId);
    s.store.quarantineInvalidRun(s.authority.runId);
    const saved = s.db
      .prepare(
        "SELECT row_json FROM quarantined_orchestration WHERE source_table = 'diagnostic_artifacts'",
      )
      .get() as { row_json: string };
    expect(JSON.parse(saved.row_json)).toEqual(original);
  });
});
