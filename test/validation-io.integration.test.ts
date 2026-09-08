import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as commandLifetime from "../src/adapters/command-lifetime.js";
import { WorkspaceOperationSchema } from "../src/domain/workspaces.js";
import { journalRecordView } from "../src/adapters/journal-records.js";
import { ActionKernel } from "../src/kernel/actions.js";
import { registerDeliveryCapabilities } from "../src/kernel/delivery.js";
import { registerDeliveryRecoveryCapabilities } from "../src/kernel/delivery-recovery.js";
import { WorkspaceManager } from "../src/adapters/workspaces.js";
import { ControlledSdkRuntime } from "../src/adapters/controlled-sdk.js";
import { RequiredCheckSchema } from "../src/domain/repository-policy.js";
import type { KernelAction } from "../src/domain/orchestration.js";
import { fixture, git, success, target } from "./fixtures/review.js";

type ProcessIdentity = { pid: number; start: string };
async function descendants(pid: number): Promise<ProcessIdentity[]> {
  const raw = (await readFile(`/proc/${pid}/task/${pid}/children`, "utf8")).trim();
  const result: ProcessIdentity[] = [];
  for (const next of raw ? raw.split(/\s+/).map(Number) : []) {
    try {
      const stat = await readFile(`/proc/${next}/stat`, "utf8");
      result.push({ pid: next, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]! });
      result.push(...(await descendants(next)));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return result;
}
async function stopped(identity: ProcessIdentity) {
  try {
    const stat = await readFile(`/proc/${identity.pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[0] === "Z" || fields[19] !== identity.start;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
async function poll(read: () => boolean | Promise<boolean>, detail: () => string) {
  const deadline = Date.now() + 10_000;
  while (!(await read())) {
    if (Date.now() >= deadline) throw new Error(detail());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.platform !== "linux")("whole validation I/O recovery", () => {
  it("fences an unused worker gate and rejects a delayed launch without creating a check result", async () => {
    const f = await fixture();
    const plan = await f.define(),
      candidate = await f.capture(plan),
      copy = await f.copy(candidate);
    const start = commandLifetime.startDurableCommand;
    const fault = vi.spyOn(commandLifetime, "startDurableCommand").mockImplementation(() => {
      throw new Error("Lost kernel caller before worker spawn");
    });
    try {
      const result = await f.dispatch({
        kind: "run_validation",
        ...candidate,
        ...target(copy),
        validationPlanId: plan,
        checkId: "app-check",
      });
      expect(result.status).toBe("failed");
      expect(fault).toHaveBeenCalledOnce();
      const [intent, launch] = fault.mock.calls[0]!;
      fault.mockRestore();
      const operation = f.journal.agents.workspaceOperation(f.authority.runId, intent.operationId);
      expect(operation).toMatchObject({
        status: "failed",
        execution: intent,
        executionStop: { kind: "not_started", code: null, reason: "cancelled" },
      });
      const evidence = f.journal.delivery.validationForWorkspaceOperation(
        f.authority.runId,
        intent.operationId,
      )!;
      expect(evidence).toMatchObject({
        status: "interrupted",
        outcome: null,
        sourceUnchanged: false,
      });
      expect(f.journal.delivery.satisfiesCheck(f.authority.runId, evidence.evidenceId)).toBe(false);
      expect(f.journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
      const view = journalRecordView(f.journal, f.authority.runId, {
        recordKind: "validation",
        recordId: evidence.evidenceId,
      });
      expect(view.settled).toBe(true);
      expect(JSON.parse(view.text).record).toMatchObject({
        status: "interrupted",
        outcome: null,
        io: { settled: true, stop: { kind: "not_started" } },
      });
      expect(view.text).not.toContain(f.authority.ownerToken);
      expect(view.text).not.toContain(intent.directory.path);
      expect(
        f.journal.recordMemory(f.authority, {
          kind: "fact",
          content: "Worker launch was fenced before execution",
          scope: "run",
          taskId: null,
          confidence: "observed",
          observationIds: [],
          evidenceIds: [evidence.evidenceId],
          revision: null,
          environmentGeneration: null,
          supersedes: null,
        }).memoryId,
      ).toBeTruthy();
      expect(
        f.journal
          .observations(f.authority.runId)
          .some(
            (item) =>
              item.kind === "validation.worker_error" &&
              item.summary.includes("Lost kernel caller before worker spawn"),
          ),
      ).toBe(true);
      for (const delta of [
        { workspaceGeneration: operation.workspaceGeneration + 1 },
        { controllerLeaseId: "foreign-lease" },
        { workspaceId: "foreign-workspace" },
      ]) {
        expect(WorkspaceOperationSchema.safeParse({ ...operation, ...delta }).success).toBe(false);
      }
      expect(() =>
        f.journal.agents.recordWorkspaceExecutionStop(f.authority, intent.operationId, {
          ...operation.executionStop!,
          ioId: "00000000-0000-4000-8000-000000000001",
        }),
      ).toThrow("differs");
      expect(() =>
        f.journal.agents.bindWorkspaceExecution(f.authority, intent.operationId, intent),
      ).toThrow("unused");
      const delayed = start(intent, launch);
      delayed.child.stdout!.resume();
      delayed.child.stderr!.resume();
      await expect(delayed.result).rejects.toThrow("supervisor failed");
      expect(f.journal.delivery.evidence(f.authority.runId, evidence.evidenceId)).toEqual(evidence);
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
    } finally {
      fault.mockRestore();
    }
  });

  it("recovers a killed kernel caller without replay or approval, then executes a fresh required check", async () => {
    const check = RequiredCheckSchema.parse({
      id: "app-check",
      command: "/bin/sh",
      args: [
        "-c",
        'printf x >> scratch/attempts; printf ready > scratch/started; while [ ! -f scratch/release ]; do sleep 0.1; done; test "$(cat app.txt)" = green',
      ],
      cwd: ".",
      timeoutMs: 20_000,
    });
    const f = await fixture(check, "sha1", undefined, undefined, { writableScratch: ["scratch"] });
    f.preserveArtifacts(); // Failed or uncertain process evidence is never deleted by fixture cleanup.
    process.stdout.write(`Retained validation crash fixture: ${f.root}\n`);
    writeFileSync(join(f.source, "user-note.txt"), "preserve the user's untracked work\n");
    const sourceStatus = git(f.source, "status", "--porcelain");
    const plan = await f.define();
    const candidate = await f.capture(plan);
    const copy = await f.copy(candidate);
    const workspace = f.journal.agents.workspace(f.authority.runId, copy);
    const request: KernelAction = {
      kind: "run_validation",
      ...candidate,
      ...target(copy),
      validationPlanId: plan,
      checkId: check.id,
    };
    const child = spawn(process.execPath, [resolve("test/fixtures/validation-kernel-caller.mjs")], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const closed = once(child, "close");
    void closed.catch(() => {});
    let diagnostics = "";
    child.stdout.resume();
    child.stderr.on("data", (value) => {
      diagnostics = (diagnostics + String(value)).slice(-4000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      JSON.stringify({
        stateFile: f.store.storageIdentity(),
        workspaceRoot: join(f.root, "managed"),
        authority: f.authority,
        decision: f.decision(request),
      }),
    );
    let identities: ProcessIdentity[] = [];
    let kernel: ActionKernel | undefined;
    let settlement: Promise<unknown> | undefined;
    try {
      await poll(
        () => existsSync(join(workspace.path, "scratch/started")),
        () => `Validation never reached its actual command: ${diagnostics}`,
      );
      identities = await descendants(child.pid!);
      expect(identities.length).toBeGreaterThan(0);
      expect(readFileSync(join(workspace.path, "scratch/attempts"), "utf8")).toBe("x");
      const evidence = f.journal.delivery.summaries(f.authority.runId).validation.at(-1)!;
      const parent = f.journal.actionForOperation(
        f.authority.runId,
        f.journal.delivery.evidence(f.authority.runId, evidence.evidenceId).operationId,
      )!;
      expect(child.kill("SIGKILL")).toBe(true);
      expect((await closed)[1]).toBe("SIGKILL");
      await poll(
        async () => (await Promise.all(identities.map(stopped))).every(Boolean),
        () => "Owned validation descendants did not stop; retained fixture must remain untouched",
      );
      // OS identity checks above protect test cleanup. Only production's retained
      // independent receipt may release its journaled workspace exclusion.
      f.newLease();
      const journal = f.reopen().orchestration;
      const manager = new WorkspaceManager(journal, join(f.root, "managed"));
      const driver = new ControlledSdkRuntime(journal, {
        root: join(f.root, "runtime"),
        executable: join(f.root, "bin/codex"),
        authCachePath: null,
        turnTimeoutMs: 30_000,
        launcherEntrypoint: resolve("dist/adapters/codex-launch-cli.js"),
      });
      kernel = new ActionKernel(journal);
      registerDeliveryCapabilities(kernel, manager);
      registerDeliveryRecoveryCapabilities(kernel, manager, driver);
      journal.markInterruptedActions(f.authority);
      const dispatch = async (action: KernelAction) => {
        const ticket = journal.beginDecision(
          f.authority,
          journal.latestObservationCursor(f.authority.runId),
          journal.control(f.authority.runId).controlVersion,
        );
        const pending = await kernel!.execute(
          {
            explanation: "Recover exact stopped work, then choose a fresh validation",
            evidenceIds: [],
            request: {
              schemaVersion: 1,
              decisionId: ticket.decisionId,
              observationCursor: ticket.observationCursor,
              expectedControlVersion: ticket.expectedControlVersion,
              action,
            },
          },
          f.authority,
        );
        if (pending.status !== "running") return pending;
        const result = kernel!.operation(pending.operationId)!;
        settlement = result;
        return result;
      };
      const observed = success(
        await dispatch({ kind: "reconcile_action", actionId: parent.actionId }),
      );
      if (observed.kind !== "inspection") throw new Error("Expected a recovery inspection");
      expect(JSON.parse(observed.text).status).toBe("failed");
      const recovered = journal.delivery.evidence(f.authority.runId, evidence.evidenceId);
      expect(recovered.status).toBe("interrupted");
      expect(recovered.outcome).toBeNull();
      expect(journal.delivery.satisfiesCheck(f.authority.runId, recovered.evidenceId)).toBe(false);
      expect(journal.agents.activeWorkspaceOperation(f.authority.runId, copy)).toBeNull();
      expect(readFileSync(join(workspace.path, "scratch/attempts"), "utf8")).toBe("x");
      await dispatch({ kind: "reconcile_action", actionId: parent.actionId });
      expect(readFileSync(join(workspace.path, "scratch/attempts"), "utf8")).toBe("x");
      // Releasing an explicit fixture barrier does not change source or the check.
      writeFileSync(join(workspace.path, "scratch/release"), "ready");
      const fresh = success(await dispatch(request));
      expect(fresh).toMatchObject({
        kind: "validation",
        outcome: "succeeded",
        satisfiesCheck: true,
      });
      expect(readFileSync(join(workspace.path, "scratch/attempts"), "utf8")).toBe("xx");
      expect(git(f.source, "rev-parse", "HEAD")).toBe(f.head);
      expect(git(f.source, "status", "--porcelain")).toBe(sourceStatus);
      expect(readFileSync(join(f.source, "user-note.txt"), "utf8")).toBe(
        "preserve the user's untracked work\n",
      );
    } finally {
      kernel?.interruptAll();
      await settlement?.catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        identities = [...identities, ...(await descendants(child.pid!))];
        child.kill("SIGKILL");
      }
      await closed;
      await poll(
        async () => (await Promise.all(identities.map(stopped))).every(Boolean),
        () => "Uncertain test descendants remain in the preserved fixture",
      );
    }
  });
});
