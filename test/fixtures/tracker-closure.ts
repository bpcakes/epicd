import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
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
  secondTask: boolean | "preclosed" = false,
  nestedContainer = false,
) {
  let transport!: KernelBeads,
    adapter!: ReturnType<typeof registerTrackerCapabilities>,
    dataPath!: string;
  const tracker: ReviewTrackerSetup = {
    ...(claimBeforeImplementation
      ? { executable: (root: string) => join(root, "br-fixture") }
      : {}),
    async initialize(source) {
      mkdirSync(join(source, ".beads"));
      writeFileSync(join(source, ".beads/issues.jsonl"), "tracker\n");
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
          container: nestedContainer
            ? {
                id: "demo.group",
                status: "open",
                assignee: null,
                closed_at: null,
                close_reason: null,
                closed_by_session: null,
              }
            : null,
          other_tasks: secondTask
            ? [
                {
                  id: "demo.2",
                  status: secondTask === "preclosed" ? "closed" : "open",
                  assignee: null,
                  description: "Retain green and deliver integration behavior",
                  closed_at: secondTask === "preclosed" ? new Date().toISOString() : null,
                  close_reason: secondTask === "preclosed" ? "Completed before this run" : null,
                  closed_by_session: secondTask === "preclosed" ? "before-run" : null,
                },
              ]
            : [],
        }),
      );
      const db = new Database(join(source, ".beads/beads.db"));
      try {
        db.exec("CREATE TABLE fixture_state (body TEXT NOT NULL)");
        db.prepare("INSERT INTO fixture_state VALUES (?)").run(readFileSync(dataPath, "utf8"));
      } finally {
        db.close();
      }
      return { epicId: "demo", taskId: "demo.1" };
    },
    async claim({ root, kernel, authority }) {
      const executable = join(root, "br-fixture");
      writeFileSync(
        executable,
        `#!/usr/bin/python3
import json, sys, signal, subprocess, time, sqlite3, hashlib, os
from pathlib import Path
from datetime import datetime, timezone
directory, args = Path('/workspace/.beads'), sys.argv[1:]
with (directory/'commands.jsonl').open('a') as log: log.write(json.dumps(args)+'\\n')
db = sqlite3.connect(str(directory/'beads.db'))
x = json.loads(db.execute('SELECT body FROM fixture_state').fetchone()[0])
def save():
    db.execute('UPDATE fixture_state SET body=?', (json.dumps(x),)); db.commit()
def row(id):
    common = {'id':id,'title':id,'priority':1,'description':'Deliver green behavior','acceptance_criteria':'The check passes','labels':[]}
    if id == 'demo':
        child = x.get('container') or {'id':'demo.1','status':x['status']}
        return {**common,**{key:x.get('epic_'+key) for key in ['assignee','closed_at','close_reason','closed_by_session']},'description':x.get('epic_description',common['description']),'status':x.get('epic_status','open'),'issue_type':'epic','dependencies':[], 'dependents':([{'id':child['id'],'dependency_type':'parent-child','status':child['status']}] if x['parent'] else []) + [{'id':y['id'],'dependency_type':'parent-child','status':y['status']} for y in x.get('other_tasks',[])] + [{'id':id,'dependency_type':'parent-child','status':'open'} for id in x.get('new_children',[])]}
    if id == 'demo.group': return {**common,**x['container'],'issue_type':'epic','dependencies':[{'id':'demo','dependency_type':'parent-child','status':x.get('epic_status','open')}], 'dependents':[{'id':'demo.1','dependency_type':'parent-child','status':x['status']}]}
    if id in x.get('new_children',[]): return {**common,'status':'open','issue_type':'task','dependencies':[{'id':'demo','dependency_type':'parent-child','status':x.get('epic_status','open')}], 'dependents':[]}
    y = x if id == 'demo.1' else next(y for y in x['other_tasks'] if y['id'] == id)
    parent = x['container'] if id == 'demo.1' and x.get('container') else {'id':'demo','status':x.get('epic_status','open')}
    return {**common, **y, 'issue_type':'task','dependencies':[{'id':parent['id'],'dependency_type':'parent-child','status':parent['status']}] if x['parent'] else [], 'dependents':[]}
if args[0] == 'show': print(json.dumps([row(id) for id in args[1:args.index('--db')]]))
elif args[0] == 'ready': print(json.dumps([row(y.get('id','demo.1')) for y in [x,*x.get('other_tasks',[])] if x['parent'] and y['status'] == 'open' and not y['assignee']]))
elif args[0] == 'update':
    y = x if args[1] == 'demo.1' else next(y for y in x['other_tasks'] if y['id'] == args[1])
    if y['assignee']: sys.exit('already owned')
    y['status'], y['assignee'] = 'in_progress', args[args.index('--actor')+1]
    save()
    print(json.dumps([row(args[1])]))
elif args[0] == 'close':
    if x.get('blocked_close'):
        print(json.dumps({'closed':[], 'skipped':[{'id':'demo.1','reason':'Policy requires an additional gate'}]})); sys.exit(0)
    if x.get('hang'):
        subprocess.Popen(['/usr/bin/python3','-c',"import time; time.sleep(1.2); open('/workspace/.beads/late-close','w').write('bad')"],start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        while True: time.sleep(1)
    y = {key:x.get('epic_'+key) for key in ['status','assignee','closed_at','close_reason','closed_by_session']} if args[1] == 'demo' else x['container'] if args[1] == 'demo.group' else x if args[1] == 'demo.1' else next(y for y in x['other_tasks'] if y['id'] == args[1])
    if y['status'] == 'closed': print('[]'); sys.exit(0)
    y['status'], y['closed_at'] = 'closed', datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
    y['close_reason'], y['closed_by_session'] = args[args.index('--reason')+1], args[args.index('--session')+1]
    if args[1] == 'demo': x.update({'epic_'+key:value for key,value in y.items()})
    save()
    print(json.dumps([row(args[1])]))
elif args[0] == 'sync':
    ids = ['demo','demo.1'] + (['demo.group'] if x.get('container') else []) + [y['id'] for y in x.get('other_tasks',[])] + x.get('new_children',[])
    rows = [row(id) for id in sorted(set(ids))]
    for y in rows:
        y['dependencies'] = [{'issue_id':y['id'],'depends_on_id':edge['id'],'type':edge['dependency_type']} for edge in y['dependencies']]
        y.pop('dependents', None)
    output = ''.join(json.dumps(y,separators=(',',':'))+'\\n' for y in rows).encode()
    Path(os.environ['BEADS_JSONL']).write_bytes(output)
    print(json.dumps({'exported_issues':len(rows),'policy':'strict','success_rate':1,'errors':[],'content_hash':hashlib.sha256(output).hexdigest()}))
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
    readTracker: () => {
      const db = new Database(join(setup.source, ".beads/beads.db"));
      try {
        return JSON.parse(db.prepare("SELECT body FROM fixture_state").pluck().get() as string);
      } finally {
        db.close();
      }
    },
    writeTracker: (changes: Record<string, unknown>) => {
      const db = new Database(join(setup.source, ".beads/beads.db"));
      try {
        const before = JSON.parse(
          db.prepare("SELECT body FROM fixture_state").pluck().get() as string,
        );
        db.prepare("UPDATE fixture_state SET body=?").run(
          JSON.stringify({ ...before, ...changes }),
        );
      } finally {
        db.close();
      }
    },
    trackerCommands: () =>
      readFileSync(join(setup.source, ".beads/commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

export async function publishVerified(
  s: Awaited<ReturnType<typeof fixture>>,
  suppliedCandidate?: import("../../src/domain/delivery.js").CandidateIdentity,
) {
  const candidate = suppliedCandidate ?? (await s.capture(await s.define()));
  const checks = s.journal.delivery.plan(
    s.authority.runId,
    s.journal.delivery.candidate(s.authority.runId, candidate).validationPlanId,
  ).checks;
  const before = await s.copy(candidate);
  for (const check of checks.filter((item) => item.stage !== "exact_revision"))
    await s.validate(candidate, before, check.id);
  await s.review(candidate);
  const commitId = resource(
    await s.dispatch({ kind: "request_commit", ...candidate, subject: "Verified green behavior" }),
  ).resourceId;
  const commit = s.journal.commits.record(s.authority.runId, commitId);
  const exact = await s.copy(candidate, commit.revision);
  for (const check of checks.filter((item) => item.stage !== "pre_commit"))
    await s.validate(candidate, exact, check.id);
  await s.review(candidate, {}, [], commit.revision);
  const publicationId = resource(
    await s.dispatch({
      kind: "request_publish",
      ...candidate,
      revision: commit.revision!,
      expectedPreviousRevision:
        s.journal.publications.repository(s.authority.runId)?.publishedRevision ?? s.head,
    }),
  ).resourceId;
  return {
    candidate,
    commit,
    publication: s.journal.publications.record(s.authority.runId, publicationId),
  };
}

/** Explicit model-selected export, tracker-object construction, then ordinary guarded publication. */
export async function publishTracker(s: Awaited<ReturnType<typeof fixture>>) {
  const parent = s.journal.publications.repository(s.authority.runId)!;
  const exported = resource(await s.dispatch({ kind: "export_tracker" }));
  const created = resource(
    await s.dispatch({
      kind: "request_tracker_commit",
      trackerOperationId: exported.resourceId,
      publicationId: parent.lastPublishedId!,
    }),
  );
  const publication = resource(
    await s.dispatch({
      kind: "request_publish_tracker",
      trackerCommitId: created.resourceId,
      expectedPreviousRevision: parent.publishedRevision!,
    }),
  );
  return s.journal.publications.record(s.authority.runId, publication.resourceId);
}
