import {
  FixtureValidationObservationSchema,
  type FixtureValidationObservation,
  type FixtureValidationUse,
} from "../domain/fixture-validation.js";
import type { FixtureDefinition, FixtureValidationPolicy } from "../domain/repository-policy.js";
import { PostgreSqlFixtureCreator } from "./fixture-creation.js";
import { FixtureTransportError } from "./fixtures.js";

const literal = (value: string) =>
  `pg_catalog.convert_from(pg_catalog.decode('${Buffer.from(value).toString("hex")}', 'hex'), 'UTF8')`;

/** All queries and catalog identifiers are controller constants, not repository SQL.
 * The non-superuser role is also denied indirect/global authority and callable
 * privileged functions/foreign-data access in the actual target database.
 */
export function fixtureValidationObservationSql(role: string): string {
  return `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;
SELECT pg_catalog.json_build_object('otherConnections',
 (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AND pid<>pg_catalog.pg_backend_pid()));
SELECT pg_catalog.json_build_object(
 'observerRole', current_user,
 'database', (SELECT pg_catalog.json_build_object('oid', d.oid::text, 'name', d.datname, 'owner', o.rolname,
   'marker', pg_catalog.shobj_description(d.oid, 'pg_database'), 'allowConnections', d.datallowconn)
   FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles o ON o.oid=d.datdba WHERE d.datname=pg_catalog.current_database()),
 'role', (SELECT pg_catalog.json_build_object(
   'oid', r.oid::text, 'name', r.rolname, 'login', r.rolcanlogin, 'superuser', r.rolsuper,
   'createDatabase', r.rolcreatedb, 'createRole', r.rolcreaterole, 'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
   'memberships', EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member=r.oid),
   'externalDependencies', EXISTS(SELECT FROM pg_catalog.pg_shdepend s WHERE s.refclassid='pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid=r.oid
     AND s.dbid <> (SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
     AND NOT(s.dbid=0 AND s.classid='pg_catalog.pg_database'::pg_catalog.regclass AND s.objid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()))),
   'parameterPrivileges', EXISTS(SELECT FROM pg_catalog.pg_parameter_acl p, LATERAL pg_catalog.aclexplode(p.paracl) a WHERE a.grantee IN(0,r.oid)),
   'unsafeFunctions', EXISTS(SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE p.proowner<>r.oid AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE') AND
       (p.prosecdef OR n.nspname NOT IN('pg_catalog','information_schema') OR
         EXISTS(SELECT FROM pg_catalog.aclexplode(p.proacl) a WHERE a.grantee IN(0,r.oid)))),
   'foreignDataAccess', EXISTS(SELECT FROM pg_catalog.pg_foreign_data_wrapper f WHERE pg_catalog.has_foreign_data_wrapper_privilege(r.oid,f.oid,'USAGE')),
   'eventTriggers', EXISTS(SELECT FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
 ) FROM pg_catalog.pg_roles r WHERE r.rolname=${literal(role)})
);
COMMIT;\n`;
}

export class PostgreSqlFixtureValidationProvider {
  private readonly reader: PostgreSqlFixtureCreator;
  constructor(bwrapPath = "/usr/bin/bwrap") {
    this.reader = new PostgreSqlFixtureCreator(bwrapPath);
  }
  async observe(
    definition: FixtureDefinition,
    policy: FixtureValidationPolicy,
    use: Pick<FixtureValidationUse, "binding">,
    guard: () => void,
    signal: AbortSignal,
  ): Promise<FixtureValidationObservation> {
    const output = await this.reader.readCatalog(
      definition,
      use.binding,
      definition.database,
      fixtureValidationObservationSql(policy.validationRole),
      guard,
      signal,
    );
    // Stop is observed first; the following READ COMMITTED statement gets a new
    // catalog snapshot after any just-finished backend committed its changes.
    try {
      const lines = output.trim().split("\n");
      if (lines.length !== 2) throw new Error("Expected separate stop and catalog observations");
      return FixtureValidationObservationSchema.parse({
        ...JSON.parse(lines[0]!),
        ...JSON.parse(lines[1]!),
      });
    } catch (cause) {
      throw new FixtureTransportError(
        `Invalid fixture access observation: ${cause instanceof Error ? cause.message : "unknown output"}`,
      );
    }
  }
}
