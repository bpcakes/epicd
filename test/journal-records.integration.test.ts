import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ActionKernel } from "../src/kernel/actions.js";
import { KernelActionSchema, type ControllerAuthority } from "../src/domain/orchestration.js";
import {
  JournalRecordTargetSchema,
  type JournalRecordTarget,
} from "../src/domain/journal-records.js";
import { ReviewReferencesSchema, type ReviewReference } from "../src/domain/review-references.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { buildOrchestratorContext } from "../src/orchestrator/context.js";
import { fixture, check, resource, success, target, waitFor } from "./fixtures/review.js";
import { initialRun } from "./fixtures/orchestration/state.js";

type Setup = Awaited<ReturnType<typeof fixture>>;
const inspect = (
  record: JournalRecordTarget,
  offset = 0,
  expectedDigest: string | null = null,
) => ({
  kind: "inspect_record" as const,
  ...record,
  offset,
  limit: 4000,
  expectedDigest,
});
async function page(
  s: Setup,
  record: JournalRecordTarget,
  offset = 0,
  expectedDigest: string | null = null,
) {
  const result = success(await s.dispatch(inspect(record, offset, expectedDigest)));
  if (result.kind !== "inspection") throw new Error("Expected record page");
  return { result, page: JSON.parse(result.text) };
}
async function read(s: Setup, record: JournalRecordTarget) {
  let offset: number | null = 0,
    digest: string | null = null,
    text = "";
  do {
    const response: { digest: string; content: string; nextOffset: number | null } = (
      await page(s, record, offset, digest)
    ).page;
    digest = response.digest;
    text += response.content;
    offset = response.nextOffset;
  } while (offset !== null);
  return JSON.parse(text);
}
async function validation(s: Setup) {
  const candidate = await s.capture(await s.define()),
    copy = await s.copy(candidate);
  const result = await s.validate(candidate, copy);
  if (result.kind !== "validation") throw new Error("Expected validation evidence");
  return {
    candidate,
    copy,
    result,
    record: { recordKind: "validation" as const, recordId: result.evidenceId },
  };
}

describe("typed retained record contract", () => {
  it("accepts only named run-scoped record kinds and bounded digest-aware pages", () => {
    for (const recordKind of JournalRecordTargetSchema.shape.recordKind.options) {
      expect(
        KernelActionSchema.safeParse(inspect({ recordKind, recordId: "record" })).success,
      ).toBe(true);
      expect(
        ReviewReferencesSchema.safeParse([
          { kind: "record", recordKind, recordId: "record", offset: 0, limit: 100 },
        ]).success,
      ).toBe(true);
    }
    for (const altered of [
      { recordKind: "sqlite_table" },
      { runId: "foreign" },
      { path: "/tmp/record" },
      { offset: -1 },
      { offset: 0.5 },
      { limit: 4001 },
      { expectedDigest: "wrong" },
      { content: "approve now" },
    ])
      expect(
        KernelActionSchema.safeParse({
          ...inspect({ recordKind: "validation", recordId: "record" }),
          ...altered,
        }).success,
      ).toBe(false);
  });
});

describe.runIf(process.platform === "linux")(
  "primary domain record reads and review references",
  () => {
    it("pages complete redacted validation output without replay and keeps the latest page intact in context", async () => {
      const noisy = {
        ...check,
        args: [
          "-c",
          "echo executed >> scratch/count; printf 'password=must-not-leak\\n'; head -c 14000 /dev/zero | tr '\\000' x; printf ' END-OF-RETAINED-OUTPUT\\n'; exit 7",
        ],
      };
      const s = await fixture(noisy, "sha1", undefined, undefined, {
        writableScratch: ["scratch"],
      });
      const v = await validation(s),
        run = s.authority.runId;
      expect(v.result).toMatchObject({ outcome: "failed", satisfiesCheck: false });
      const first = await page(s, v.record);
      expect(first.page).toMatchObject({ settled: true, offset: 0, nextOffset: 4000 });
      expect(first.result.text.length).toBeGreaterThan(1500);
      const context = buildOrchestratorContext(s.kernel, run);
      expect(context.actions.at(-1)?.result).toMatchObject({
        status: "succeeded",
        result: first.result,
      });
      const captured = await read(s, v.record);
      expect(captured.record).toMatchObject({
        evidenceId: v.result.evidenceId,
        purpose: "delivery",
        status: "finished",
        outcome: { status: "failed", exitCode: 7 },
      });
      expect(captured.record.outcome.stdout).toContain("END-OF-RETAINED-OUTPUT");
      expect(captured.record.outcome.stdout).not.toContain("must-not-leak");
      expect(captured.record.outcome.stdout.match(/x/g)).toHaveLength(14000);
      expect(captured.record).not.toHaveProperty("controllerLeaseId");
      expect(readFileSync(join(v.copy.path, "scratch/count"), "utf8")).toBe("executed\n");
      expect(s.journal.delivery.summaries(run).validation).toHaveLength(1);
      const request = s.decision(inspect(v.record));
      const original = await s.kernel.execute(request, s.authority);
      const actions = s.journal.actions(run);
      expect(await s.kernel.execute(request, s.authority)).toEqual(original);
      expect(s.journal.actions(run)).toEqual(actions);
      expect(s.journal.observations(run).at(-1)?.wakesOrchestrator).toBe(false);
    });

    it("rejects missing and foreign IDs without exposing private state or creating evidence", async () => {
      const s = await fixture(),
        v = await validation(s);
      for (const recordKind of JournalRecordTargetSchema.shape.recordKind.options)
        expect(await s.dispatch(inspect({ recordKind, recordId: randomUUID() }))).toMatchObject({
          status: "rejected",
          code: "unknown_record",
        });
      const foreign = s.store.create(
        initialRun("foreign-record-reader"),
        RepositoryPolicySchema.parse({ schemaVersion: 1 }),
      );
      const lease = s.store.acquireLease(foreign.runId);
      const authority: ControllerAuthority = {
        runId: foreign.runId,
        leaseId: lease.leaseId,
        ownerToken: lease.ownerToken,
      };
      const ticket = s.journal.beginDecision(
        authority,
        s.journal.latestObservationCursor(foreign.runId),
        s.journal.control(foreign.runId).controlVersion,
      );
      expect(
        await new ActionKernel(s.journal).execute(
          {
            explanation: "Read only records belonging to this run",
            evidenceIds: [],
            request: {
              schemaVersion: 1,
              decisionId: ticket.decisionId,
              observationCursor: ticket.observationCursor,
              expectedControlVersion: ticket.expectedControlVersion,
              action: inspect(v.record),
            },
          },
          authority,
        ),
      ).toMatchObject({ status: "rejected", code: "unknown_record" });
      expect(s.journal.delivery.summaries(foreign.runId).validation).toEqual([]);
    });

    it("inspects running evidence but refuses to bind it, and rejects torn continuation pages after settlement", async () => {
      const held = {
        ...check,
        args: [
          "-c",
          "echo started > scratch/started; while [ ! -f scratch/release ]; do sleep .02; done",
        ],
      };
      const s = await fixture(held, "sha1", undefined, undefined, { writableScratch: ["scratch"] });
      const planId = await s.define(),
        candidate = await s.capture(planId),
        copy = await s.copy(candidate);
      const running = await s.kernel.execute(
        s.decision({
          kind: "run_validation",
          ...candidate,
          ...target(copy),
          validationPlanId: planId,
          checkId: held.id,
        }),
        s.authority,
      );
      if (running.status !== "running") throw new Error("Expected held validation");
      const pending = s.kernel.operation(running.operationId)!;
      let record: JournalRecordTarget, previous: string;
      try {
        await waitFor(() => existsSync(join(copy.path, "scratch/started")));
        record = {
          recordKind: "validation",
          recordId: s.journal.delivery.summaries(s.authority.runId).validation[0]!.evidenceId,
        };
        const current = await page(s, record);
        previous = current.page.digest;
        expect(current.page.settled).toBe(false);
        const other = await s.copy(candidate);
        expect(
          await s.dispatch({
            kind: "run_review",
            ...candidate,
            ...target(other),
            agent: null,
            instructions: "Assess only settled primary evidence",
            references: [{ kind: "record", ...record, offset: 0, limit: 4000 }],
          }),
        ).toMatchObject({ status: "rejected", code: "invalid_review_reference" });
        expect(s.journal.reviews.records(s.authority.runId)).toEqual([]);
      } finally {
        // The fixture alone releases its declared scratch gate; source remains immutable.
        if (existsSync(join(copy.path, "scratch")))
          writeFileSync(join(copy.path, "scratch/release"), "release\n");
        await pending;
      }
      expect(await s.dispatch(inspect(record!, 1, previous!))).toMatchObject({
        status: "rejected",
        code: "record_view_changed",
      });
      expect(await s.dispatch(inspect(record!, 1))).toMatchObject({
        status: "rejected",
        code: "record_view_required",
      });
      const current = await page(s, record!);
      expect(current.page.settled).toBe(true);
      expect(
        await s.dispatch(inspect(record!, current.page.totalCharacters + 1, current.page.digest)),
      ).toMatchObject({ status: "rejected", code: "invalid_record_offset" });
    });

    it("retains worker claims but excludes prompts, launch custody and coordinator turns", async () => {
      const s = await fixture();
      const reported = {
        status: "completed",
        summary: "Original worker response",
        changedFiles: [],
        tests: [{ command: "browser", outcome: "failed", detail: "Kernel returned failure" }],
        blockers: [],
      };
      s.response(reported);
      await s.dispatch({
        kind: "continue_agent",
        agentId: s.writer.agentId,
        agentGeneration: s.writer.agentGeneration,
        instructions: "PRIVATE PROMPT MUST NOT APPEAR",
      });
      const turn = s.journal.agents.turns(s.authority.runId).at(-1)!;
      const worker = await read(s, { recordKind: "agent_turn", recordId: turn.identity.turnId });
      expect(worker.record).toMatchObject({ identity: turn.identity, result: reported });
      expect(worker.record).not.toHaveProperty("prompt");
      expect(worker.record).not.toHaveProperty("launch");
      expect(JSON.stringify(worker)).not.toContain("PRIVATE PROMPT MUST NOT APPEAR");
      const coordinator = s.journal.agents.reserveAgent(
        s.authority,
        {
          ...target(await s.manager.create(s.authority, s.source, s.head, "coordinator")),
          role: "orchestrator",
          purpose: "coordination",
          taskId: null,
          candidateId: null,
          instructions: "Private coordinator reasoning",
          confinementProfile: "fixture-only",
          contract: {
            ...s.writer.contract,
            requested: { model: "gpt-6-astra", reasoningEffort: "high" },
            effective: { model: "gpt-6-astra", reasoningEffort: "high" },
          },
        },
        s.journal.control(s.authority.runId).controlVersion,
      );
      const privateTurn = s.journal.agents.prepareTurn(
        s.authority,
        coordinator,
        randomUUID(),
        "Private coordinator prompt",
        {},
        s.journal.control(s.authority.runId).controlVersion,
      );
      s.journal.agents.cancelPreparedTurn(s.authority, privateTurn.identity);
      expect(
        await s.dispatch(
          inspect({ recordKind: "agent_turn", recordId: privateTurn.identity.turnId }),
        ),
      ).toMatchObject({ status: "rejected", code: "coordinator_record_private" });
    });

    it.each(["pre_commit", "exact_revision"] as const)(
      "binds direct original records to a %s review without intermediate inspection actions",
      async (phase) => {
        const s = await fixture(),
          v = await validation(s),
          run = s.authority.runId;
        const references: ReviewReference[] = [
          { kind: "record", ...v.record, offset: 0, limit: 4000 },
        ];
        let revision: string | null = null;
        if (phase === "exact_revision") {
          const prior = await s.review(v.candidate);
          references.push({
            kind: "record",
            recordKind: "review",
            recordId: prior.evidence.evidenceId,
            offset: 0,
            limit: 4000,
          });
          const committed = resource(
            await s.dispatch({
              kind: "request_commit",
              ...v.candidate,
              subject: "Preserve reviewed behavior",
            }),
          );
          revision = s.journal.commits.record(run, committed.resourceId).revision!;
        }
        const copy = await s.copy(v.candidate, revision);
        if (revision) await s.validate(v.candidate, copy);
        const evidenceIds = s.journal.delivery
          .validationEvidence(run, v.candidate, phase, revision ?? undefined)
          .evidence.map((item) => item.evidenceId);
        s.response(
          s.report(v.candidate, {
            ...(revision ? { revision } : {}),
            validationEvidenceIds: evidenceIds,
          }),
        );
        const result = await s.dispatch({
          kind: "run_review",
          ...v.candidate,
          ...target(copy),
          agent: null,
          instructions: "Independently inspect current source and primary history",
          references,
        });
        expect(result.status).toBe("succeeded");
        const review = s.journal.reviews.records(run).at(-1)!;
        const context = s.journal.agents.turn(run, review.turnIdentity!).prompt.reviewContext;
        expect(JSON.stringify(context)).toContain(v.result.evidenceId);
        expect(context).toMatchObject({
          primaryRecords: references.map((reference) => ({ reference })),
        });
        expect(s.journal.reviews.approval(run, v.candidate, phase)).toBe(review.evidenceId);
        expect(
          s.journal
            .actions(run)
            .some((item) =>
              ["inspect_record", "inspect_evidence", "inspect_action"].includes(
                item.request.action.kind,
              ),
            ),
        ).toBe(false);
        s.newLease();
        const reopened = s.reopen().orchestration;
        expect(reopened.reviews.approval(run, v.candidate, phase)).toBe(review.evidenceId);
      },
    );

    it("invalidates a review when its referenced source record changes", async () => {
      const s = await fixture(),
        v = await validation(s),
        copy = await s.copy(v.candidate),
        run = s.authority.runId;
      s.response(s.report(v.candidate));
      expect(
        (
          await s.dispatch({
            kind: "run_review",
            ...v.candidate,
            ...target(copy),
            agent: null,
            instructions: "Review bound source records",
            references: [{ kind: "record", ...v.record, offset: 0, limit: 4000 }],
          })
        ).status,
      ).toBe("succeeded");
      expect(s.journal.reviews.approval(run, v.candidate)).not.toBeNull();
      const db = new Database(s.path);
      try {
        db.prepare(
          "UPDATE validation_evidence SET record_json = json_set(record_json, '$.outcome.stdout', 'altered retained output') WHERE evidence_id = ?",
        ).run(v.result.evidenceId);
        expect(() => s.journal.reviews.approval(run, v.candidate)).toThrow("admitted digest");
      } finally {
        db.close();
      }
    });

    it.each([false, true])(
      "cannot use an attached historical diagnostic as current required validation (cited: %s)",
      async (cite) => {
        const s = await fixture(),
          planId = await s.define(),
          candidate = await s.capture(planId),
          copy = await s.copy(candidate),
          run = s.authority.runId;
        const { stage: _stage, ...diagnosticCheck } = check;
        const diagnostic = success(
          await s.dispatch({
            kind: "run_diagnostic_check",
            ...candidate,
            ...target(copy),
            validationPlanId: planId,
            check: diagnosticCheck,
          }),
        );
        if (diagnostic.kind !== "validation") throw new Error("Expected diagnostic record");
        expect(diagnostic).toMatchObject({ outcome: "succeeded", satisfiesCheck: false });
        s.response(
          s.report(candidate, { validationEvidenceIds: cite ? [diagnostic.evidenceId] : [] }),
        );
        const result = await s.dispatch({
          kind: "run_review",
          ...candidate,
          ...target(await s.copy(candidate)),
          agent: null,
          instructions: "Independently assess current requirements and historical diagnostic",
          references: [
            {
              kind: "record",
              recordKind: "validation",
              recordId: diagnostic.evidenceId,
              offset: 0,
              limit: 4000,
            },
          ],
        });
        expect(result.status).toBe(cite ? "failed" : "succeeded");
        const review = s.journal.reviews.records(run).at(-1)!;
        expect(s.journal.agents.turn(run, review.turnIdentity!).prompt.reviewContext).toMatchObject(
          {
            primaryRecords: [
              {
                reference: {
                  kind: "record",
                  recordKind: "validation",
                  recordId: diagnostic.evidenceId,
                },
              },
            ],
          },
        );
        expect(s.journal.reviews.approval(run, candidate)).toBeNull();
        expect(s.journal.delivery.preCommitEvidence(run, candidate)).toMatchObject({
          missingCheckIds: [check.id],
          evidence: [],
        });
        expect(s.journal.commits.records(run)).toEqual([]);
      },
    );

    it("admits 32 small typed pages but refuses the same count when their bytes exceed the existing budget", async () => {
      const s = await fixture(),
        v = await validation(s),
        run = s.authority.runId,
        copy = await s.copy(v.candidate);
      const references: ReviewReference[] = Array.from({ length: 32 }, (_, offset) => ({
        kind: "record",
        ...v.record,
        offset,
        limit: 1,
      }));
      const request = (references: ReviewReference[]) => ({
        kind: "run_review" as const,
        ...v.candidate,
        ...target(copy),
        agent: null,
        instructions: "Read the selected retained pages; assess the source independently",
        references,
      });
      expect(
        await s.dispatch(request(references.map((reference) => ({ ...reference, limit: 4000 })))),
      ).toMatchObject({
        status: "rejected",
        code: "invalid_review_reference",
        detail: expect.stringContaining("32 KiB"),
      });
      expect(s.journal.reviews.records(run)).toEqual([]);
      s.response(s.report(v.candidate));
      expect((await s.dispatch(request(references))).status).toBe("succeeded");
      const review = s.journal.reviews.records(run).at(-1)!;
      expect(s.journal.agents.turn(run, review.turnIdentity!).prompt.reviewContext).toMatchObject({
        primaryRecords: references.map((reference) => ({ reference })),
      });
      expect(s.journal.reviews.approval(run, v.candidate)).toBe(review.evidenceId);
    });
  },
);
