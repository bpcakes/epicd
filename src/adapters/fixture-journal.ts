import { randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { digestJson, type RepositoryPolicy } from "../domain/repository-policy.js";
import {
  FixtureGrantSchema,
  FixtureProviderBindingSchema,
  type FixtureGrant,
  type FixtureOperation,
  type FixtureProviderBinding,
  FixtureCreationSchema,
  FixtureCreationObservationSchema,
  FixtureBackendSchema,
  type FixtureCreation,
  type FixtureCreationObservation,
  type FixtureBackend,
} from "../domain/fixtures.js";
import type { ActionRecord, ControllerAuthority, ControlState } from "../domain/orchestration.js";
import { redactSensitiveText } from "../util/redact.js";

export const FIXTURE_TABLES = ["fixture_grants", "fixture_creations"] as const;
export function createFixturesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE fixture_grants (
    grant_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
  ) STRICT;
  CREATE INDEX grants_by_fixture ON fixture_grants(run_id, fixture_id);
  CREATE TABLE fixture_creations (
    creation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL, generation INTEGER NOT NULL,
    operation_id TEXT NOT NULL UNIQUE REFERENCES actions(operation_id),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(run_id, fixture_id, generation)
  ) STRICT;`);
}
export class FixtureAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FixtureAuthorityError";
  }
}

/** Operator grants are separate from policy and model-requested actions. */
export class FixtureJournal {
  constructor(
    private readonly db: Database.Database,
    private readonly access: {
      control(runId: string): ControlState;
      policy(runId: string): RepositoryPolicy;
      transaction<T>(authority: ControllerAuthority, body: () => T): T;
      action(runId: string, actionId: string): ActionRecord | null;
      operatorTransaction<T>(runId: string, version: number, body: () => T): T;
      note(runId: string, kind: string, message: string): void;
    },
  ) {}

  definition(runId: string, fixtureId: string) {
    const definition = this.access.policy(runId).fixtures.find((item) => item.id === fixtureId);
    if (!definition)
      throw new FixtureAuthorityError(
        "undeclared_fixture",
        "Fixture is absent from the frozen repository policy",
      );
    return definition;
  }
  grants(runId: string): FixtureGrant[] {
    return (
      this.db
        .prepare(
          "SELECT grant_id, fixture_id, record_json FROM fixture_grants WHERE run_id = ? ORDER BY rowid",
        )
        .all(runId) as { grant_id: string; fixture_id: string; record_json: string }[]
    ).map((row) => {
      const grant = FixtureGrantSchema.parse(JSON.parse(row.record_json));
      if (
        grant.runId !== runId ||
        grant.grantId !== row.grant_id ||
        grant.fixtureId !== row.fixture_id
      )
        throw new Error("Fixture grant identity differs from its indexed ownership");
      return grant;
    });
  }
  summary(runId: string) {
    const grants = this.grants(runId),
      creations = this.creations(runId);
    return this.access.policy(runId).fixtures.map((definition) => {
      const latest = creations.findLast((item) => item.fixtureId === definition.id);
      return {
        fixtureId: definition.id,
        grants: grants
          .filter((grant) => grant.fixtureId === definition.id && !grant.revokedAt)
          .map((grant) => ({
            grantId: grant.grantId,
            operations: grant.operations,
            expiresAt: grant.expiresAt,
            expired: Date.parse(grant.expiresAt) <= Date.now(),
          })),
        creation: latest
          ? {
              creationId: latest.creationId,
              generation: latest.generation,
              status: latest.status,
              detail: latest.detail,
            }
          : null,
        ownership:
          "Requires a fresh matching provider observation; recorded creation alone is not current evidence",
        environmentBindingAvailable: false,
      };
    });
  }
  grant(
    runId: string,
    expectedVersion: number,
    input: {
      fixtureId: string;
      operations: readonly FixtureOperation[];
      binding: FixtureProviderBinding;
      expiresAt: string;
    },
  ): FixtureGrant {
    return this.access.operatorTransaction(runId, expectedVersion, () => {
      const definition = this.definition(runId, input.fixtureId);
      if (
        input.binding.directory.path !== definition.socketDirectory ||
        (input.binding.socket &&
          input.binding.socket.path !==
            join(definition.socketDirectory, `.s.PGSQL.${definition.port}`))
      )
        throw new FixtureAuthorityError(
          "fixture_binding_mismatch",
          "Grant must bind the declared socket endpoint",
        );
      const now = Date.now(),
        expiry = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 24 * 60 * 60 * 1000)
        throw new FixtureAuthorityError(
          "grant_expiry",
          "Grant expiry must be in the next 24 hours",
        );
      if (
        input.operations.some(
          (operation) => operation !== "inspect" && !definition.operations.includes(operation),
        )
      )
        throw new FixtureAuthorityError(
          "fixture_operation_denied",
          "Grant exceeds the declared operations",
        );
      const grant = FixtureGrantSchema.parse({
        schemaVersion: 1,
        grantId: randomUUID(),
        runId,
        fixtureId: input.fixtureId,
        policyDigest: this.access.control(runId).policyDigest,
        definitionDigest: digestJson(definition),
        binding: FixtureProviderBindingSchema.parse(input.binding),
        operations: [...new Set(input.operations)],
        createdAt: new Date(now).toISOString(),
        expiresAt: input.expiresAt,
        revokedAt: null,
      });
      // Replace authority for this fixture, without deleting its history or changing run status.
      for (const old of this.grants(runId).filter(
        (item) => item.fixtureId === input.fixtureId && !item.revokedAt,
      ))
        this.save({ ...old, revokedAt: grant.createdAt });
      this.db
        .prepare("INSERT INTO fixture_grants VALUES (?, ?, ?, ?)")
        .run(grant.grantId, runId, grant.fixtureId, JSON.stringify(grant));
      this.access.note(
        runId,
        "fixture.granted",
        `Grant ${grant.grantId}: ${grant.fixtureId}, ${grant.operations.join(", ")}, expires ${grant.expiresAt}. No resource ownership or validation access implied.`,
      );
      return grant;
    });
  }
  revoke(runId: string, expectedVersion: number, grantId: string): void {
    this.access.operatorTransaction(runId, expectedVersion, () => {
      const grant = this.grants(runId).find((item) => item.grantId === grantId && !item.revokedAt);
      if (!grant)
        throw new FixtureAuthorityError(
          "unknown_grant",
          "No active grant with this identity belongs to the run",
        );
      this.save({ ...grant, revokedAt: new Date().toISOString() });
      this.access.note(
        runId,
        "fixture.grant_revoked",
        `Revoked ${grantId}; no resource was changed or removed`,
      );
    });
  }
  authorize(
    runId: string,
    fixtureId: string,
    operation: FixtureOperation,
    grantId?: string,
  ): FixtureGrant {
    const control = this.access.control(runId),
      definition = this.definition(runId, fixtureId);
    const grant = this.grants(runId).findLast(
      (item) => item.fixtureId === fixtureId && !item.revokedAt,
    );
    if (
      control.status !== "active" ||
      !grant ||
      (grantId && grant.grantId !== grantId) ||
      grant.policyDigest !== control.policyDigest ||
      grant.definitionDigest !== digestJson(definition) ||
      Date.parse(grant.expiresAt) <= Date.now() ||
      !grant.operations.includes(operation)
    )
      throw new FixtureAuthorityError(
        "fixture_grant_required",
        "An active, unexpired operator grant for this exact fixture and operation is required",
      );
    return grant;
  }
  creations(runId: string): FixtureCreation[] {
    return (
      this.db
        .prepare(
          "SELECT creation_id, fixture_id, generation, operation_id, record_json FROM fixture_creations WHERE run_id = ? ORDER BY rowid",
        )
        .all(runId) as {
        creation_id: string;
        fixture_id: string;
        generation: number;
        operation_id: string;
        record_json: string;
      }[]
    ).map((row) => {
      const record = FixtureCreationSchema.parse(JSON.parse(row.record_json));
      if (
        record.runId !== runId ||
        record.creationId !== row.creation_id ||
        record.fixtureId !== row.fixture_id ||
        record.generation !== row.generation ||
        record.operationId !== row.operation_id
      )
        throw new Error("Fixture creation identity differs from indexed ownership");
      return record;
    });
  }
  creation(runId: string, creationId: string): FixtureCreation {
    const record = this.creations(runId).find((item) => item.creationId === creationId);
    if (!record)
      throw new FixtureAuthorityError(
        "unknown_fixture_creation",
        "Creation does not belong to this run",
      );
    if (
      record.policyDigest !== this.access.control(runId).policyDigest ||
      record.definitionDigest !== digestJson(this.definition(runId, record.fixtureId))
    )
      throw new FixtureAuthorityError(
        "fixture_policy_changed",
        "Creation belongs to another policy or definition",
      );
    return record;
  }
  reserveCreation(authority: ControllerAuthority, actionId: string): FixtureCreation {
    return this.access.transaction(authority, () => {
      const action = this.access.action(authority.runId, actionId),
        control = this.access.control(authority.runId);
      if (
        !action ||
        action.status !== "running" ||
        action.request.action.kind !== "provision_declared_fixture" ||
        action.request.action.operation !== "create" ||
        control.status !== "active" ||
        action.policyDigest !== control.policyDigest
      )
        throw new FixtureAuthorityError(
          "fixture_action_stale",
          "Creation requires its admitted create action",
        );
      const request = action.request.action,
        definition = this.definition(authority.runId, request.fixtureId);
      const grant = this.authorize(authority.runId, request.fixtureId, "create");
      const previous = this.creations(authority.runId).findLast(
        (item) => item.fixtureId === request.fixtureId,
      );
      if (
        (previous?.generation ?? 0) !== request.expectedGeneration ||
        (previous && previous.status !== "not_created")
      )
        throw new FixtureAuthorityError(
          "fixture_generation",
          "Inspect/reconcile the current creation; only a proven not-created attempt permits another create",
        );
      if (["postgres", "template0", "template1"].includes(definition.database))
        throw new FixtureAuthorityError(
          "protected_database",
          "System and maintenance databases are not disposable fixtures",
        );
      const creationId = randomUUID();
      const record = FixtureCreationSchema.parse({
        schemaVersion: 1,
        creationId,
        runId: authority.runId,
        fixtureId: definition.id,
        generation: request.expectedGeneration + 1,
        operationId: action.operationId,
        policyDigest: control.policyDigest,
        definitionDigest: digestJson(definition),
        grantId: grant.grantId,
        binding: grant.binding,
        plannedOid: randomInt(16384, 4294967296),
        marker: `epicd-fixture-v1:${creationId}:${randomUUID()}`,
        alias: `epicd_lock_${randomUUID().replaceAll("-", "")}`,
        controllerLeaseId: authority.leaseId,
        status: "reserved",
        backend: null,
        clientStopEvidence: null,
        observation: null,
        detail: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
      });
      this.db
        .prepare("INSERT INTO fixture_creations VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          creationId,
          authority.runId,
          definition.id,
          record.generation,
          record.operationId,
          JSON.stringify(record),
        );
      this.access.note(
        authority.runId,
        "fixture.creation_reserved",
        `Creation ${creationId} generation ${record.generation}; no mutation dispatched`,
      );
      return record;
    });
  }
  dispatchCreation(
    authority: ControllerAuthority,
    creationId: string,
    backend: FixtureBackend,
  ): FixtureCreation {
    return this.access.transaction(authority, () => {
      const record = this.creation(authority.runId, creationId);
      this.authorize(authority.runId, record.fixtureId, "create", record.grantId);
      if (record.status !== "reserved" || record.controllerLeaseId !== authority.leaseId)
        throw new FixtureAuthorityError(
          "fixture_dispatch_used",
          "Creation dispatch is one-use and lease-bound",
        );
      record.backend = FixtureBackendSchema.parse(backend);
      record.status = "dispatching";
      this.saveCreation(record);
      this.access.note(
        authority.runId,
        "fixture.creation_dispatch",
        `Creation ${creationId} bound to PostgreSQL backend ${backend.pid}/${backend.startedAt}`,
      );
      return record;
    });
  }
  clientStopped(authority: ControllerAuthority, creationId: string): void {
    this.access.transaction(authority, () => {
      const record = this.creation(authority.runId, creationId);
      if (record.controllerLeaseId !== authority.leaseId)
        throw new FixtureAuthorityError(
          "fixture_old_client",
          "A replacement controller cannot attest the old client stopped",
        );
      record.clientStopEvidence =
        "Trusted provider observed its PID-namespace client close; PostgreSQL backend stop remains a separate check";
      this.saveCreation(record);
    });
  }
  noDispatch(authority: ControllerAuthority, creationId: string, detail: string): FixtureCreation {
    return this.access.transaction(authority, () => {
      const record = this.creation(authority.runId, creationId);
      if (record.status !== "reserved" || record.backend)
        throw new FixtureAuthorityError(
          "fixture_dispatch_uncertain",
          "A possibly dispatched creation requires provider reconciliation",
        );
      // Once this gate is closed, a delayed old handshake cannot admit its CREATE.
      record.status = "not_created";
      record.finishedAt = new Date().toISOString();
      record.detail = redactSensitiveText(detail, 3999);
      this.saveCreation(record);
      this.access.note(authority.runId, "fixture.not_created", `${creationId}: ${record.detail}`);
      return record;
    });
  }
  observeCreation(
    authority: ControllerAuthority,
    creationId: string,
    input: FixtureCreationObservation,
  ): FixtureCreation {
    return this.access.transaction(authority, () => {
      const record = this.creation(authority.runId, creationId),
        observed = FixtureCreationObservationSchema.parse(input);
      if (!record.backend || record.status === "reserved" || record.status === "not_created")
        throw new FixtureAuthorityError(
          "fixture_not_dispatched",
          "Provider observation requires a recorded backend dispatch",
        );
      const definition = this.definition(authority.runId, record.fixtureId);
      record.observation = observed;
      const database = observed.database;
      if (!observed.backendStopped) {
        record.status = "uncertain";
        record.detail = "The recorded PostgreSQL backend may still execute; preserve the fixture";
      } else if (!database) {
        record.status = "not_created";
        record.detail =
          "Recorded backend stopped and no database exists at the target name or planned OID";
      } else if (
        database.oid === String(record.plannedOid) &&
        database.name === definition.database &&
        database.owner === definition.expectedOwner &&
        database.markerMatches &&
        database.allowConnections
      ) {
        record.status = "owned";
        record.detail =
          "Matching operation marker, OID and owner observed after the recorded backend stopped; no validation access implied";
      } else {
        record.status = "uncertain";
        record.detail =
          "Database exists without exact completed-creation provenance; neither adopt, repeat nor delete it";
      }
      record.finishedAt = observed.backendStopped ? new Date().toISOString() : null;
      this.saveCreation(record);
      this.access.note(
        authority.runId,
        `fixture.${record.status}`,
        `${creationId}: ${record.detail}`,
      );
      return record;
    });
  }
  private saveCreation(record: FixtureCreation) {
    this.db
      .prepare("UPDATE fixture_creations SET record_json = ? WHERE run_id = ? AND creation_id = ?")
      .run(JSON.stringify(FixtureCreationSchema.parse(record)), record.runId, record.creationId);
  }
  private save(grant: FixtureGrant) {
    this.db
      .prepare("UPDATE fixture_grants SET record_json = ? WHERE run_id = ? AND grant_id = ?")
      .run(JSON.stringify(FixtureGrantSchema.parse(grant)), grant.runId, grant.grantId);
  }
}
