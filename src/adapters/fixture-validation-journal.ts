import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  digestJson,
  type FixtureDefinition,
  type RepositoryPolicy,
} from "../domain/repository-policy.js";
import {
  FixtureValidationGrantSchema,
  FixtureValidationObservationSchema,
  FixtureValidationUseSchema,
  commandOwnsFixtureUses,
  type FixtureValidationGrant,
  type FixtureValidationObservation,
  type FixtureValidationUse,
} from "../domain/fixture-validation.js";
import type { FixtureCreation, FixtureProviderBinding } from "../domain/fixtures.js";
import type { ActionRecord, ControllerAuthority, ControlState } from "../domain/orchestration.js";
import { FixtureAuthorityError } from "./fixture-journal.js";
import { ValidationEvidenceSchema } from "../domain/delivery.js";
import { redactSensitiveText } from "../util/redact.js";
import { CommandLifetimeSchema, type CommandLifetime } from "../domain/command-lifetime.js";
import { recoverCommandStop } from "./command-lifetime.js";
import { WorkspaceOperationSchema } from "../domain/workspaces.js";

export const FIXTURE_VALIDATION_TABLES = [
  "fixture_validation_grants",
  "fixture_validation_uses",
] as const;
export function createFixtureValidationSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE fixture_validation_grants (
    grant_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
  ) STRICT;
  CREATE TABLE fixture_validation_uses (
    access_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL, evidence_id TEXT NOT NULL REFERENCES validation_evidence(evidence_id),
    creation_id TEXT NOT NULL REFERENCES fixture_creations(creation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(evidence_id, fixture_id)
  ) STRICT;`);
}
type Access = {
  control(runId: string): ControlState;
  policy(runId: string): RepositoryPolicy;
  transaction<T>(authority: ControllerAuthority, body: () => T): T;
  operatorTransaction<T>(runId: string, version: number, body: () => T): T;
  action(runId: string, actionId: string): ActionRecord | null;
  actionForOperation(runId: string, operationId: string): ActionRecord | null;
  definition(runId: string, fixtureId: string): FixtureDefinition;
  creations(runId: string): FixtureCreation[];
  note(runId: string, kind: string, message: string): void;
};
const fail = (code: string, message: string): never => {
  throw new FixtureAuthorityError(code, message);
};
const endpoint = (binding: FixtureProviderBinding) =>
  digestJson({ directory: binding.directory, socket: binding.socket });

export class FixtureValidationJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: Access,
  ) {}
  policy(runId: string, fixtureId: string) {
    return (
      this.access.policy(runId).fixtureValidation.find((entry) => entry.fixtureId === fixtureId) ??
      fail(
        "fixture_access_undeclared",
        "The frozen policy does not declare SQL access for this fixture",
      )
    );
  }
  private digest(runId: string, fixtureId: string) {
    return digestJson({
      definition: this.access.definition(runId, fixtureId),
      validation: this.policy(runId, fixtureId),
    });
  }
  grants(runId: string): FixtureValidationGrant[] {
    return (
      this.db
        .prepare(
          "SELECT grant_id, fixture_id, record_json FROM fixture_validation_grants WHERE run_id=? ORDER BY rowid",
        )
        .all(runId) as { grant_id: string; fixture_id: string; record_json: string }[]
    ).map((row) => {
      const grant = FixtureValidationGrantSchema.parse(JSON.parse(row.record_json));
      if (
        grant.runId !== runId ||
        grant.grantId !== row.grant_id ||
        grant.fixtureId !== row.fixture_id
      )
        throw new Error("Fixture validation grant ownership changed");
      return grant;
    });
  }
  grant(
    runId: string,
    version: number,
    input: {
      fixtureId: string;
      binding: FixtureProviderBinding;
      pgbouncer: FixtureValidationGrant["pgbouncer"];
      expiresAt: string;
    },
  ): FixtureValidationGrant {
    return this.access.operatorTransaction(runId, version, () => {
      const definition = this.access.definition(runId, input.fixtureId),
        policy = this.policy(runId, input.fixtureId);
      const now = Date.now(),
        expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 86_400_000)
        fail("grant_expiry", "Grant expiry must be in the next 24 hours");
      if (
        !input.binding.socket ||
        input.binding.directory.path !== definition.socketDirectory ||
        input.binding.socket.path !== `${definition.socketDirectory}/.s.PGSQL.${definition.port}` ||
        input.pgbouncer.path !== policy.pgbouncerExecutable
      )
        fail(
          "fixture_binding_mismatch",
          "SQL-access grant must pin its declared socket and native broker",
        );
      const grant = FixtureValidationGrantSchema.parse({
        schemaVersion: 1,
        grantId: randomUUID(),
        runId,
        fixtureId: input.fixtureId,
        policyDigest: this.access.control(runId).policyDigest,
        definitionDigest: this.digest(runId, input.fixtureId),
        binding: input.binding,
        pgbouncer: input.pgbouncer,
        createdAt: new Date(now).toISOString(),
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      for (const old of this.grants(runId).filter(
        (g) => g.fixtureId === grant.fixtureId && !g.revokedAt,
      ))
        this.saveGrant({ ...old, revokedAt: grant.createdAt });
      this.db
        .prepare("INSERT INTO fixture_validation_grants VALUES(?,?,?,?)")
        .run(grant.grantId, runId, grant.fixtureId, JSON.stringify(grant));
      this.access.note(
        runId,
        "fixture.validation_granted",
        `Grant ${grant.grantId} permits checked SQL access to ${grant.fixtureId} using its dedicated disposable role; no database was adopted or queried`,
      );
      return grant;
    });
  }
  revoke(runId: string, version: number, grantId: string): void {
    this.access.operatorTransaction(runId, version, () => {
      const grant =
        this.grants(runId).find((g) => g.grantId === grantId && !g.revokedAt) ??
        fail("unknown_grant", "No active SQL-access grant belongs to this run");
      this.saveGrant({ ...grant, revokedAt: new Date().toISOString() });
      this.access.note(
        runId,
        "fixture.validation_revoked",
        `Revoked ${grantId}; in-flight database work remains excluded until independently stopped`,
      );
    });
  }
  authorize(runId: string, fixtureId: string, grantId?: string): FixtureValidationGrant {
    const control = this.access.control(runId),
      grant = this.grants(runId).findLast((g) => g.fixtureId === fixtureId && !g.revokedAt);
    if (
      control.status !== "active" ||
      !grant ||
      (grantId && grant.grantId !== grantId) ||
      grant.policyDigest !== control.policyDigest ||
      grant.definitionDigest !== this.digest(runId, fixtureId) ||
      Date.parse(grant.expiresAt) <= Date.now()
    )
      return fail(
        "fixture_access_grant_required",
        "An active unexpired operator SQL-access grant for this exact fixture policy is required",
      );
    return grant;
  }
  /** Whether requesting preflight is possible, not proof that server-side privileges are safe. */
  requestAvailable(runId: string, fixtureId: string): boolean {
    try {
      const grant = this.authorize(runId, fixtureId);
      const creation = this.access
        .creations(runId)
        .findLast((entry) => entry.fixtureId === fixtureId);
      return (
        creation?.status === "owned" &&
        creation.policyDigest === grant.policyDigest &&
        endpoint(creation.binding) === endpoint(grant.binding) &&
        !this.uses(runId).some((entry) => entry.fixtureId === fixtureId && !entry.remoteStopped)
      );
    } catch (error) {
      if (error instanceof FixtureAuthorityError) return false;
      throw error;
    }
  }
  uses(runId: string): FixtureValidationUse[] {
    return (
      this.db
        .prepare(
          "SELECT access_id,fixture_id,evidence_id,creation_id,record_json FROM fixture_validation_uses WHERE run_id=? ORDER BY rowid",
        )
        .all(runId) as {
        access_id: string;
        fixture_id: string;
        evidence_id: string;
        creation_id: string;
        record_json: string;
      }[]
    ).map((row) => {
      const use = FixtureValidationUseSchema.parse(JSON.parse(row.record_json));
      if (
        use.runId !== runId ||
        use.accessId !== row.access_id ||
        use.fixtureId !== row.fixture_id ||
        use.evidenceId !== row.evidence_id ||
        use.creationId !== row.creation_id
      )
        throw new Error("Fixture validation use ownership changed");
      return use;
    });
  }
  use(runId: string, accessId: string): FixtureValidationUse {
    return (
      this.uses(runId).find((entry) => entry.accessId === accessId) ??
      fail("unknown_fixture_access", "Fixture access does not belong to this run")
    );
  }
  reserve(
    authority: ControllerAuthority,
    actionId: string,
    evidenceId: string,
    fixtureId: string,
  ): FixtureValidationUse {
    return this.access.transaction(authority, () => {
      const grant = this.authorize(authority.runId, fixtureId),
        action = this.access.action(authority.runId, actionId);
      const row = this.db
        .prepare("SELECT record_json FROM validation_evidence WHERE run_id=? AND evidence_id=?")
        .get(authority.runId, evidenceId) as { record_json: string } | undefined;
      const evidence = ValidationEvidenceSchema.parse(row ? JSON.parse(row.record_json) : null);
      if (
        action?.status !== "running" ||
        !["run_validation", "run_diagnostic_check"].includes(action.request.action.kind) ||
        action.operationId !== evidence.operationId ||
        evidence.controllerLeaseId !== authority.leaseId ||
        evidence.status !== "running"
      )
        fail(
          "fixture_access_stale",
          "SQL access requires its admitted validation action and evidence",
        );
      if (
        this.uses(authority.runId).some((use) => use.fixtureId === fixtureId && !use.remoteStopped)
      )
        fail(
          "fixture_access_busy",
          "Previous fixture access has not proved local and remote stop; reconcile it without replaying validation",
        );
      const creation = this.access
        .creations(authority.runId)
        .findLast((c) => c.fixtureId === fixtureId);
      if (
        !creation ||
        creation.status !== "owned" ||
        !creation.clientStopEvidence ||
        !creation.observation?.backendStopped ||
        creation.policyDigest !== grant.policyDigest ||
        creation.definitionDigest !==
          digestJson(this.access.definition(authority.runId, fixtureId)) ||
        endpoint(creation.binding) !== endpoint(grant.binding)
      )
        return fail(
          "fixture_access_not_owned",
          "SQL access requires this run's exact successfully created fixture, not a pre-existing database",
        );
      const use = FixtureValidationUseSchema.parse({
        schemaVersion: 1,
        accessId: randomUUID(),
        runId: authority.runId,
        fixtureId,
        evidenceId,
        operationId: evidence.operationId,
        controllerLeaseId: authority.leaseId,
        creationId: creation.creationId,
        generation: creation.generation,
        databaseOid: String(creation.plannedOid),
        marker: creation.marker,
        grantId: grant.grantId,
        policyDigest: grant.policyDigest,
        definitionDigest: grant.definitionDigest,
        binding: grant.binding,
        pgbouncer: grant.pgbouncer,
        status: "reserved",
        preflight: null,
        finalObservation: null,
        localStopped: false,
        localCommand: null,
        localReceipt: null,
        localWorkerStop: null,
        remoteStopped: false,
        detail: null,
        createdAt: new Date().toISOString(),
      });
      this.db
        .prepare("INSERT INTO fixture_validation_uses VALUES(?,?,?,?,?,?)")
        .run(use.accessId, use.runId, fixtureId, evidenceId, use.creationId, JSON.stringify(use));
      this.access.note(
        use.runId,
        "fixture.validation_reserved",
        `${use.accessId}: reserved generation ${use.generation} before any repository SQL`,
      );
      return use;
    });
  }
  assertDispatch(authority: ControllerAuthority, accessId: string): FixtureValidationUse {
    const use = this.use(authority.runId, accessId);
    this.authorize(authority.runId, use.fixtureId, use.grantId);
    const row = this.db
      .prepare("SELECT record_json FROM validation_evidence WHERE run_id=? AND evidence_id=?")
      .get(authority.runId, use.evidenceId) as { record_json: string } | undefined;
    const evidence = ValidationEvidenceSchema.parse(row ? JSON.parse(row.record_json) : null);
    if (
      use.controllerLeaseId !== authority.leaseId ||
      !["reserved", "dispatched"].includes(use.status) ||
      evidence.status !== "running" ||
      !evidence.fixtureAccessIds.includes(accessId) ||
      evidence.operationId !== use.operationId ||
      use.policyDigest !== this.access.control(authority.runId).policyDigest ||
      use.definitionDigest !== this.digest(authority.runId, use.fixtureId) ||
      !this.provenanceMatches(use)
    )
      fail(
        "fixture_access_stale",
        "Fixture access is no longer admitted for this validation owner",
      );
    return use;
  }
  admit(
    authority: ControllerAuthority,
    accessId: string,
    input: FixtureValidationObservation,
  ): void {
    this.access.transaction(authority, () => {
      const use = this.assertDispatch(authority, accessId),
        observation = FixtureValidationObservationSchema.parse(input);
      if (use.status !== "reserved" || use.preflight)
        fail("fixture_access_used", "Fixture preflight is one-use");
      const problems = this.problems(use, observation);
      if (problems.length) fail("fixture_access_unsafe", problems.join("; "));
      this.save({ ...use, preflight: observation });
    });
  }
  dispatch(authority: ControllerAuthority, accessId: string, input: CommandLifetime): void {
    this.access.transaction(authority, () => {
      const use = this.assertDispatch(authority, accessId);
      if (use.status !== "reserved" || !use.preflight)
        fail("fixture_access_used", "Fixture dispatch requires one unused admitted preflight");
      const intent = CommandLifetimeSchema.parse(input);
      if (!commandOwnsFixtureUses(intent, this.commandUses(use)))
        fail(
          "fixture_access_command_mismatch",
          "Command intent differs from the admitted fixture uses",
        );
      this.save({ ...use, status: "dispatched", localCommand: intent });
      this.access.note(
        use.runId,
        "fixture.validation_dispatched",
        `${accessId}: admitted fixed fixture transport`,
      );
    });
  }
  /** Close an unused SQL gate, not the interrupted validation or its workspace I/O. */
  noDispatch(authority: ControllerAuthority, accessId: string): FixtureValidationUse {
    return this.access.transaction(authority, () => {
      const use = this.use(authority.runId, accessId);
      if (use.status !== "reserved")
        fail(
          "fixture_access_dispatch_uncertain",
          "Only an unused fixture SQL dispatch gate can be closed without transport stop evidence",
        );
      const parent = this.access.actionForOperation(authority.runId, use.operationId);
      if (parent && ["accepted", "running"].includes(parent.status))
        fail(
          "fixture_access_action_live",
          "Interrupt the parent validation before reconciling its unused SQL gate",
        );
      const row = this.db
        .prepare("SELECT record_json FROM validation_evidence WHERE run_id=? AND evidence_id=?")
        .get(authority.runId, use.evidenceId) as { record_json: string } | undefined;
      const parsed = ValidationEvidenceSchema.safeParse(row ? JSON.parse(row.record_json) : null);
      const evidence = parsed.success ? parsed.data : null;
      if (
        !parent ||
        !["run_validation", "run_diagnostic_check"].includes(parent.request.action.kind) ||
        !evidence ||
        evidence.runId !== use.runId ||
        evidence.evidenceId !== use.evidenceId ||
        evidence.operationId !== use.operationId ||
        evidence.controllerLeaseId !== use.controllerLeaseId ||
        !evidence.fixtureAccessIds.includes(accessId) ||
        evidence.policyDigest !== use.policyDigest ||
        parent.policyDigest !== use.policyDigest ||
        !this.provenanceMatches(use)
      )
        fail(
          "fixture_access_provenance_changed",
          "Unused SQL access must retain its exact validation, action, grant and fixture provenance",
        );
      // Dispatch and this closure use the same immediate transaction. A delayed
      // preflight or beforeSpawn callback cannot reopen the one-use gate, even
      // when its original controller lease is still current. No fresh SQL grant
      // is needed: this records non-dispatch and never observes the database.
      const closed = FixtureValidationUseSchema.parse({
        ...use,
        status: "not_started",
        localStopped: true,
        remoteStopped: true,
        detail:
          "Unused SQL dispatch gate closed; no repository SQL transport was dispatched. Parent validation outcome and workspace I/O stop remain unverified by this closure.",
      });
      this.save(closed);
      this.access.note(
        use.runId,
        "fixture.validation_not_started",
        `${accessId}: ${closed.detail}`,
      );
      return closed;
    });
  }
  localStopped(authority: ControllerAuthority, accessId: string): void {
    this.access.transaction(authority, () => {
      const use = this.use(authority.runId, accessId);
      if (use.controllerLeaseId !== authority.leaseId)
        fail(
          "fixture_access_old_owner",
          "A replacement controller cannot infer its predecessor's process stop",
        );
      if (use.status !== "reserved")
        fail(
          "fixture_access_local_unknown",
          "Dispatched fixture transport requires an independent command-stop receipt",
        );
      this.save({
        ...use,
        status: "not_started",
        localStopped: true,
        remoteStopped: true,
        detail: "No repository SQL transport was dispatched",
      });
    });
  }
  /** Physical local proof only. This never settles validation/workspace I/O or authorizes SQL. */
  async reconcileLocalCommand(
    authority: ControllerAuthority,
    accessId: string,
  ): Promise<FixtureValidationUse> {
    const before = this.access.transaction(authority, () => {
      const use = this.use(authority.runId, accessId);
      if (
        use.localCommand &&
        (!commandOwnsFixtureUses(use.localCommand, this.commandUses(use)) ||
          !this.provenanceMatches(use))
      )
        fail(
          "fixture_access_provenance_changed",
          "Command stop must match the original validation and fixture provenance",
        );
      return use;
    });
    if (!before.localCommand)
      return fail(
        "fixture_access_local_unknown",
        "Fixture command has no registered local-stop intent",
      );
    const receipt = await recoverCommandStop(before.localCommand);
    const workerStop = receipt ? null : this.completeWorkerStop(before);
    if (!receipt && !workerStop)
      return fail(
        "fixture_access_local_unknown",
        "The original command has no independent local-stop receipt; preserve exclusion",
      );
    return this.access.transaction(authority, () => {
      const use = this.use(authority.runId, accessId);
      if (
        digestJson(use.localCommand) !== digestJson(before.localCommand) ||
        !use.localCommand ||
        !commandOwnsFixtureUses(use.localCommand, this.commandUses(use)) ||
        !this.provenanceMatches(use) ||
        (workerStop && digestJson(workerStop) !== digestJson(this.completeWorkerStop(use)))
      )
        fail(
          "fixture_access_provenance_changed",
          "Command stop must match the original validation and fixture provenance",
        );
      const stopped = FixtureValidationUseSchema.parse({
        ...use,
        localReceipt: receipt,
        localWorkerStop: workerStop,
        localStopped: true,
        ...(receipt?.kind === "not_started"
          ? {
              status: "not_started",
              remoteStopped: true,
              finalObservation: null,
              detail:
                "Independent dispatch gate proves no local fixture command started; validation and workspace I/O remain separate",
            }
          : {}),
      });
      this.save(stopped);
      this.access.note(
        use.runId,
        "fixture.validation_local_stopped",
        `${accessId}: exact independent ${receipt?.kind ?? "complete-worker stopped"} receipt retained; remote SQL stop remains separate`,
      );
      return stopped;
    });
  }
  private commandUses(use: FixtureValidationUse): FixtureValidationUse[] {
    return this.uses(use.runId).filter((entry) => entry.evidenceId === use.evidenceId);
  }
  /** A stopped enclosing worker proves local descendants only, never database quiescence. */
  private completeWorkerStop(use: FixtureValidationUse) {
    const row = this.db
      .prepare("SELECT record_json FROM validation_evidence WHERE run_id=? AND evidence_id=?")
      .get(use.runId, use.evidenceId) as { record_json: string } | undefined;
    const evidence = ValidationEvidenceSchema.parse(row ? JSON.parse(row.record_json) : null);
    const retained = this.db
      .prepare("SELECT record_json FROM workspace_operations WHERE run_id=? AND operation_id=?")
      .get(use.runId, evidence.workspaceOperationId) as { record_json: string } | undefined;
    const operation = WorkspaceOperationSchema.parse(
      retained ? JSON.parse(retained.record_json) : null,
    );
    if (
      evidence.runId !== use.runId ||
      evidence.operationId !== use.operationId ||
      evidence.controllerLeaseId !== use.controllerLeaseId ||
      !evidence.fixtureAccessIds.includes(use.accessId) ||
      operation.runId !== use.runId ||
      operation.operationId !== evidence.workspaceOperationId ||
      operation.kind !== "validation" ||
      operation.workspaceId !== evidence.workspaceId ||
      operation.workspaceGeneration !== evidence.workspaceGeneration ||
      operation.controllerLeaseId !== use.controllerLeaseId ||
      !operation.execution ||
      operation.executionStop?.kind !== "stopped"
    )
      return null;
    return {
      operationId: operation.operationId,
      execution: operation.execution,
      receipt: operation.executionStop,
    };
  }
  observationUse(runId: string, accessId: string, expectedGrantId?: string) {
    const use = this.use(runId, accessId),
      grant = this.authorize(runId, use.fixtureId, expectedGrantId);
    if (!this.provenanceMatches(use))
      fail(
        "fixture_access_provenance_changed",
        "Fixture access differs from its recorded grant or creation",
      );
    if (endpoint(grant.binding) !== endpoint(use.binding))
      fail(
        "fixture_access_endpoint_changed",
        "A replacement socket cannot prove old database work stopped",
      );
    // A fresh read grant may differ from the original SQL grant. Do not rewrite
    // the dispatched use or its historical provenance when renewing permission.
    return { binding: grant.binding, grantId: grant.grantId };
  }
  observeStopped(
    authority: ControllerAuthority,
    accessId: string,
    input: FixtureValidationObservation,
    observationGrantId: string,
  ): FixtureValidationUse {
    return this.access.transaction(authority, () => {
      const use = this.use(authority.runId, accessId),
        observation = FixtureValidationObservationSchema.parse(input);
      this.observationUse(authority.runId, accessId, observationGrantId);
      if (!use.localStopped)
        fail(
          "fixture_access_local_unknown",
          "Remote quiescence alone cannot prove a live proxy will not reconnect",
        );
      if (use.status !== "dispatched") return use;
      const identity = this.identityProblems(use, observation);
      const stopped = identity.length === 0 && observation.otherConnections === 0;
      const updated = {
        ...use,
        finalObservation: observation,
        remoteStopped: stopped,
        status: stopped ? ("stopped" as const) : ("dispatched" as const),
        detail: stopped
          ? "Local transport stopped and exact fixture has no remaining connections"
          : redactSensitiveText(
              [
                ...identity,
                ...(observation.otherConnections
                  ? [
                      `${observation.otherConnections} PostgreSQL connections remain; preserve the fixture`,
                    ]
                  : []),
              ].join("; "),
              3999,
            ),
      };
      this.save(updated);
      this.access.note(use.runId, "fixture.validation_observed", `${accessId}: ${updated.detail}`);
      return updated;
    });
  }
  eligible(runId: string, accessId: string): boolean {
    const use = this.use(runId, accessId);
    return (
      use.status === "stopped" &&
      use.localStopped &&
      use.remoteStopped &&
      !!use.localCommand &&
      commandOwnsFixtureUses(use.localCommand, this.commandUses(use)) &&
      this.provenanceMatches(use) &&
      use.policyDigest === this.access.control(runId).policyDigest &&
      use.definitionDigest === this.digest(runId, use.fixtureId) &&
      !!use.preflight &&
      !!use.finalObservation &&
      use.preflight.role?.oid === use.finalObservation.role?.oid &&
      this.problems(use, use.preflight).length === 0 &&
      this.problems(use, use.finalObservation).length === 0
    );
  }
  /** Historical provenance survives grant revocation; revocation only stops future access. */
  private provenanceMatches(use: FixtureValidationUse): boolean {
    const grant = this.grants(use.runId).find((entry) => entry.grantId === use.grantId);
    const creation = this.access
      .creations(use.runId)
      .find((entry) => entry.creationId === use.creationId);
    return (
      !!grant &&
      !!creation &&
      (!use.localWorkerStop ||
        digestJson(use.localWorkerStop) === digestJson(this.completeWorkerStop(use))) &&
      grant.fixtureId === use.fixtureId &&
      grant.policyDigest === use.policyDigest &&
      grant.definitionDigest === use.definitionDigest &&
      digestJson(grant.binding) === digestJson(use.binding) &&
      digestJson(grant.pgbouncer) === digestJson(use.pgbouncer) &&
      creation.fixtureId === use.fixtureId &&
      creation.generation === use.generation &&
      String(creation.plannedOid) === use.databaseOid &&
      creation.marker === use.marker &&
      creation.policyDigest === use.policyDigest &&
      endpoint(creation.binding) === endpoint(use.binding)
    );
  }
  private identityProblems(
    use: FixtureValidationUse,
    observation: FixtureValidationObservation,
  ): string[] {
    const definition = this.access.definition(use.runId, use.fixtureId),
      db = observation.database;
    return observation.observerRole === definition.role &&
      db.oid === use.databaseOid &&
      db.name === definition.database &&
      db.owner === definition.expectedOwner &&
      db.marker === use.marker &&
      db.allowConnections
      ? []
      : ["Fixture OID, name, owner, marker, connectivity or observer identity changed"];
  }
  private problems(use: FixtureValidationUse, observation: FixtureValidationObservation): string[] {
    const problems = this.identityProblems(use, observation),
      role = observation.role;
    if (!role || role.name !== this.policy(use.runId, use.fixtureId).validationRole || !role.login)
      problems.push("Declared validation login is absent");
    if (role)
      for (const key of [
        "superuser",
        "createDatabase",
        "createRole",
        "replication",
        "bypassRls",
        "memberships",
        "externalDependencies",
        "parameterPrivileges",
        "unsafeFunctions",
        "foreignDataAccess",
        "eventTriggers",
      ] as const)
        if (role[key]) problems.push(`Validation role has forbidden authority: ${key}`);
    if (observation.otherConnections)
      problems.push("Fixture is not quiescent; another database connection exists");
    return problems;
  }
  private save(use: FixtureValidationUse): void {
    this.db
      .prepare("UPDATE fixture_validation_uses SET record_json=? WHERE run_id=? AND access_id=?")
      .run(JSON.stringify(FixtureValidationUseSchema.parse(use)), use.runId, use.accessId);
  }
  private saveGrant(grant: FixtureValidationGrant): void {
    this.db
      .prepare("UPDATE fixture_validation_grants SET record_json=? WHERE run_id=? AND grant_id=?")
      .run(JSON.stringify(FixtureValidationGrantSchema.parse(grant)), grant.runId, grant.grantId);
  }
}
