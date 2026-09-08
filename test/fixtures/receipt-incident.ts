import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { OrchestrationJournal } from "../../src/adapters/orchestration-journal.js";
import type { ControlledAgentDriver } from "../../src/kernel/agents.js";
import type { TurnIdentity } from "../../src/domain/orchestration.js";

export const RECEIPT_FILES = ["validation.log", "review.log"] as const;
const initialReceipt = "# tracked validation receipt\n";
const receiptLine = "validated application output\n";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Generated repository data, not recovery instructions supplied to the coordinator. */
export function receiptProject(
  source: string,
  application: "source.txt" | "app.txt" = "source.txt",
) {
  mkdirSync(join(source, "tools"));
  writeFileSync(join(source, "expected.txt"), "green\n");
  for (const file of RECEIPT_FILES) writeFileSync(join(source, file), initialReceipt);
  writeFileSync(
    join(source, "tools/check.sh"),
    `#!/bin/sh\nset -eu\n/usr/bin/cmp ${application} expected.txt\nif [ "\${1:-}" != "--no-receipts" ]; then\n  printf '%s\\n' 'validated application output' >> validation.log\n  printf '%s\\n' 'validated application output' >> review.log\nfi\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(source, "VALIDATION.md"),
    `# Validation\n\nThe human-facing helper is \`/bin/sh tools/check.sh\`. It compares ${application} with expected.txt and appends one receipt to each tracked log. For a read-only checkout, \`/bin/sh tools/check.sh --no-receipts\` performs the same comparison without appending receipts. The underlying comparison is \`/usr/bin/cmp ${application} expected.txt\`. Neither receipt is application output or proof that a later revision passed.\n`,
  );
  return ["tools/check.sh", "VALIDATION.md", "expected.txt", ...RECEIPT_FILES];
}

type Journal = {
  agents: Pick<OrchestrationJournal["agents"], "assignment" | "workspace">;
  diagnostics: Pick<OrchestrationJournal["diagnostics"], "append">;
};
export type ReceiptFault = {
  identity: TurnIdentity;
  workspacePath: string;
  observationId: number;
  artifactId: string;
  deltas: {
    path: string;
    before: string;
    after: string;
    beforeSha256: string;
    afterSha256: string;
  }[];
};

/** Explicit host fault injection AFTER a real stopped review turn. It emulates
 * legacy receipt writes; it does not claim the immutable runtime permitted them,
 * script a coordinator response, run repository code on the host, or repair state.
 */
export function receiptFaultDriver(
  journal: Journal,
  original: ControlledAgentDriver,
  workspaceRoot: string,
) {
  const run = original.run.bind(original);
  let fault: ReceiptFault | null = null;
  const driver: ControlledAgentDriver = {
    kind: original.kind,
    reconcile: original.reconcile.bind(original),
    async run(authority, identity, signal) {
      const stopped = await run(authority, identity, signal);
      const assignment = journal.agents.assignment(authority.runId, identity.assignmentId);
      if (
        fault ||
        assignment.purpose !== "review" ||
        !stopped.resultEligible ||
        !stopped.stopEvidence
      )
        return stopped;
      signal?.throwIfAborted();
      const workspace = journal.agents.workspace(authority.runId, identity);
      const inside = relative(realpathSync(workspaceRoot), realpathSync(workspace.path));
      if (!inside || inside.startsWith("..") || isAbsolute(inside) || workspace.activeTurnId)
        throw new Error("Receipt fault requires this test's stopped private review copy");
      const deltas = RECEIPT_FILES.map((path) => {
        const filename = join(workspace.path, path);
        if (realpathSync(filename) !== filename) throw new Error("Receipt fault refuses aliases");
        const fd = openSync(filename, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error("Receipt fault requires an owned regular file");
          const before = readFileSync(fd, "utf8");
          if (before !== initialReceipt)
            throw new Error("Receipt input was already changed; preserve it");
          appendFileSync(fd, receiptLine);
          const after = readFileSync(filename, "utf8");
          if (after !== before + receiptLine)
            throw new Error("Receipt fault delta differs from its append");
          return { path, before, after, beforeSha256: hash(before), afterSha256: hash(after) };
        } finally {
          closeSync(fd);
        }
      });
      const retained = journal.diagnostics.append(
        authority,
        {
          source: "acceptance-fault-injector",
          sourceEventId: `receipt-delta-${identity.turnId}`,
          kind: "workspace.changed",
          summary: `Host fault injection appended two tracked receipts in review workspace ${identity.workspaceId} after turn ${identity.turnId} stopped.`,
          identity,
          wakesOrchestrator: true,
        },
        JSON.stringify({
          faultInjection: true,
          origin: "host test process, not the confined reviewer",
          workspaceId: identity.workspaceId,
          turnId: identity.turnId,
          deltas,
        }),
      );
      fault = {
        identity,
        workspacePath: workspace.path,
        observationId: retained.observation.id,
        artifactId: retained.artifact.artifactId,
        deltas,
      };
      return stopped;
    },
  };
  return {
    driver,
    get fault() {
      return fault;
    },
  };
}
