import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActionKernel } from "../../src/kernel/actions.js";
import type { ControllerAuthority, KernelAction } from "../../src/domain/orchestration.js";
import { KernelBeads } from "../../src/adapters/kernel-beads.js";
import { registerTrackerCapabilities } from "../../src/kernel/tracker.js";
import { fixture, check, resource, type ReviewTrackerSetup } from "./review.js";

export async function trackerAction(
  kernel: ActionKernel,
  authority: ControllerAuthority,
  action: KernelAction,
) {
  const journal = kernel.journal;
  const ticket = journal.beginDecision(
    authority,
    journal.latestObservationCursor(authority.runId),
    journal.control(authority.runId).controlVersion,
  );
  const result = await kernel.execute(
    {
      explanation: "Use the current tracker and exact delivery proof",
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
  return result.status === "running" ? (await kernel.operation(result.operationId))! : result;
}

// Explicitly scripted tracker semantics. Real Beads is exercised separately.
export async function closureFixture(
  format: "sha1" | "sha256" = "sha1",
  claimBeforeImplementation = true,
) {
  let transport!: KernelBeads,
    adapter!: ReturnType<typeof registerTrackerCapabilities>,
    dataPath!: string;
  const tracker: ReviewTrackerSetup = {
    async initialize(source) {
      mkdirSync(join(source, ".beads"));
      writeFileSync(join(source, ".beads/issues.jsonl"), "tracker\n");
      writeFileSync(join(source, ".beads/beads.db"), "fixture-only\n");
      writeFileSync(join(source, ".beads/.gitignore"), "beads.db\ndata.json\ncommands.jsonl\n");
      dataPath = join(source, ".beads/data.json");
      writeFileSync(
        dataPath,
        JSON.stringify({
          status: "open",
          assignee: null,
          description: "Implement green behavior",
          parent: true,
          closed_at: null,
          close_reason: null,
          closed_by_session: null,
        }),
      );
      return { epicId: "demo", taskId: "demo.1" };
    },
    async claim({ root, kernel, authority }) {
      const executable = join(root, "br-fixture");
      writeFileSync(
        executable,
        `#!/usr/bin/python3
import json, sys, signal, subprocess, time
from pathlib import Path
from datetime import datetime, timezone
directory, args = Path('/workspace/.beads'), sys.argv[1:]
with (directory/'commands.jsonl').open('a') as log: log.write(json.dumps(args)+'\\n')
x = json.loads((directory/'data.json').read_text())
def row(id):
    common = {'id':id,'title':id,'priority':1,'description':'Deliver green behavior','acceptance_criteria':'The check passes','labels':[]}
    if id == 'demo': return {**common,'status':'open','issue_type':'epic','dependencies':[], 'dependents':[{'id':'demo.1','dependency_type':'parent-child','status':x['status']}] if x['parent'] else []}
    return {**common, **x, 'issue_type':'task','dependencies':[{'id':'demo','dependency_type':'parent-child','status':'open'}] if x['parent'] else [], 'dependents':[]}
if args[0] == 'show': print(json.dumps([row(id) for id in args[1:args.index('--db')]]))
elif args[0] == 'ready': print(json.dumps([row('demo.1')] if x['parent'] and x['status'] == 'open' and not x['assignee'] else []))
elif args[0] == 'update':
    if x['assignee']: sys.exit('already owned')
    x['status'], x['assignee'] = 'in_progress', args[args.index('--actor')+1]
    (directory/'data.json').write_text(json.dumps(x))
    print(json.dumps([row('demo.1')]))
elif args[0] == 'close':
    if x.get('blocked_close'):
        print(json.dumps({'closed':[], 'skipped':[{'id':'demo.1','reason':'Policy requires an additional gate'}]})); sys.exit(0)
    if x.get('hang'):
        subprocess.Popen(['/usr/bin/python3','-c',"import time; time.sleep(1.2); open('/workspace/.beads/late-close','w').write('bad')"],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True: time.sleep(1)
    if x['status'] == 'closed': print('[]'); sys.exit(0)
    x['status'], x['closed_at'] = 'closed', datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    x['close_reason'], x['closed_by_session'] = args[args.index('--reason')+1], args[args.index('--session')+1]
    (directory/'data.json').write_text(json.dumps(x))
    print(json.dumps([row('demo.1')]))
else: sys.exit('unsupported')
`,
      );
      chmodSync(executable, 0o755);
      transport = new KernelBeads(executable);
      adapter = registerTrackerCapabilities(kernel, transport);
      if (claimBeforeImplementation)
        resource(
          await trackerAction(kernel, authority, {
            kind: "request_beads_transition",
            taskId: "demo.1",
            transition: "claim",
            revision: null,
          }),
        );
    },
  };
  const setup = await fixture(check, format, tracker);
  if (!claimBeforeImplementation)
    resource(
      await trackerAction(setup.kernel, setup.authority, {
        kind: "request_beads_transition",
        taskId: "demo.1",
        transition: "claim",
        revision: null,
      }),
    );
  return {
    ...setup,
    get authority() {
      return setup.authority;
    },
    get store() {
      return setup.store;
    },
    transport,
    adapter,
    readTracker: () => JSON.parse(readFileSync(dataPath, "utf8")),
    writeTracker: (changes: Record<string, unknown>) =>
      writeFileSync(
        dataPath,
        JSON.stringify({ ...JSON.parse(readFileSync(dataPath, "utf8")), ...changes }),
      ),
    trackerCommands: () =>
      readFileSync(join(setup.source, ".beads/commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

export async function publishVerified(s: Awaited<ReturnType<typeof fixture>>) {
  const candidate = await s.capture(await s.define());
  await s.validate(candidate, await s.copy(candidate));
  await s.review(candidate);
  const commitId = resource(
    await s.dispatch({ kind: "request_commit", ...candidate, subject: "Verified green behavior" }),
  ).resourceId;
  const commit = s.journal.commits.record(s.authority.runId, commitId);
  await s.validate(candidate, await s.copy(candidate, commit.revision));
  await s.review(candidate, {}, [], commit.revision);
  const publicationId = resource(
    await s.dispatch({
      kind: "request_publish",
      ...candidate,
      revision: commit.revision!,
      expectedPreviousRevision: s.head,
    }),
  ).resourceId;
  return {
    candidate,
    commit,
    publication: s.journal.publications.record(s.authority.runId, publicationId),
  };
}
