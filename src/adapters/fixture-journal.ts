import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { digestJson, type RepositoryPolicy } from "../domain/repository-policy.js";
import {
  FixtureGrantSchema,
  FixtureProviderBindingSchema,
  type FixtureGrant,
  type FixtureOperation,
  type FixtureProviderBinding,
} from "../domain/fixtures.js";
import type { ControlState } from "../domain/orchestration.js";

export const FIXTURE_TABLES = ["fixture_grants"] as const;
export function createFixturesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE fixture_grants (
    grant_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
    fixture_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
  ) STRICT;
  CREATE INDEX grants_by_fixture ON fixture_grants(run_id, fixture_id);`);
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
    const grants = this.grants(runId);
    return this.access.policy(runId).fixtures.map((definition) => ({
      fixtureId: definition.id,
      grants: grants
        .filter((grant) => grant.fixtureId === definition.id && !grant.revokedAt)
        .map((grant) => ({
          grantId: grant.grantId,
          operations: grant.operations,
          expiresAt: grant.expiresAt,
          expired: Date.parse(grant.expiresAt) <= Date.now(),
        })),
      ownership: "not_established",
      environmentBindingAvailable: false,
    }));
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
  private save(grant: FixtureGrant) {
    this.db
      .prepare("UPDATE fixture_grants SET record_json = ? WHERE run_id = ? AND grant_id = ?")
      .run(JSON.stringify(FixtureGrantSchema.parse(grant)), grant.runId, grant.grantId);
  }
}
