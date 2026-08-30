import type { EpicSnapshot, Issue, ReviewFinding } from "../domain/types.js";

function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    title: issue.title,
    type: issue.issue_type,
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels,
    description: issue.description,
    acceptanceCriteria: issue.acceptance_criteria,
    dependencies: issue.dependencies ?? [],
    dependents: issue.dependents ?? [],
    agentContext: issue.inherited_context ?? issue.agent_context ?? null,
  };
}

function snapshotView(snapshot: EpicSnapshot): Record<string, unknown> {
  return {
    epic: issueView(snapshot.epic),
    issues: snapshot.issues.map(issueView),
    readyCandidateIds: snapshot.readyIssues.map((issue) => issue.id),
    triage: snapshot.triage,
    dependencyPlan: snapshot.plan,
    dependencyGraph: snapshot.graph,
  };
}

export function selectionPrompt(
  snapshot: EpicSnapshot,
  firstTurn: boolean,
  recentOutcomes: Array<{
    beadId: string;
    title: string;
    verifiedRevision: string;
    reviewSummary: string;
  }>,
): string {
  return `You are the persistent epicd orchestrator for a Beads epic.

${firstTurn ? "Build a complete mental model of the epic and its dependency graph before selecting work." : "Refresh your model using this authoritative current snapshot; earlier task states may now be stale."}

Choose exactly one concrete, non-epic implementation issue from readyCandidateIds. Consider dependency impact, merge-risk sequencing, shared abstractions, and the bv recommendations, but never select an epic container. br ready has already supplied the candidate set; your output is advisory and epicd will independently enforce the gate immediately before claiming.

Do not modify files, invoke tracker mutations, or claim anything. Return only the requested structured selection.

AUTHORITATIVE SNAPSHOT
${JSON.stringify(snapshotView(snapshot))}

RECENT VERIFIED OUTCOMES
${JSON.stringify(recentOutcomes)}`;
}

export function implementationPrompt(epic: Issue, issue: Issue, recovery: boolean): string {
  return `You are the implementation owner for one concrete Beads issue inside a larger epic.

${recovery ? "A previous implementation turn may have been interrupted. Inspect the current working tree and thread history, preserve correct existing work, and finish the issue." : "Implement the issue completely in the current repository."}

Boundaries:
- Read and obey every applicable AGENTS.md.
- Work only on production code and real tests required by this issue.
- Do not run br or bv. epicd exclusively owns tracker mutations.
- Do not stage, commit, amend, reset, checkout, or push Git state. epicd exclusively owns commits.
- Do not weaken assertions, regenerate goldens merely to obtain green output, add placeholder success paths, or claim tests ran when they did not.
- Run the most relevant real test and validation commands available.
- If genuinely blocked, leave the working tree recoverable and return a precise blocker.

EPIC CONTEXT
${JSON.stringify(issueView(epic))}

OWNED ISSUE
${JSON.stringify(issueView(issue))}

Return only the requested structured implementation report.`;
}

export function fixPrompt(
  issue: Issue,
  findings: ReviewFinding[],
  committedRevision: string | null,
): string {
  return `Continue as the implementation owner for ${issue.id}. An independent review found the issues below.

Fix every finding at its root, add or strengthen real regression tests where appropriate, and rerun relevant validation. Inspect the repository rather than assuming the review's proposed remediation is mechanically correct.

Do not run br or bv. Do not stage, commit, amend, reset, checkout, or push. epicd owns tracker and Git mutations.

${committedRevision ? `The last candidate was already committed as ${committedRevision}; make the corrections as new working-tree changes. Do not rewrite that commit.` : "The candidate is not committed yet."}

ISSUE
${JSON.stringify(issueView(issue))}

REVIEW FINDINGS
${JSON.stringify(findings)}

Return only the requested structured implementation report.`;
}

export function taskReviewPrompt(
  epic: Issue,
  issue: Issue,
  baseRevision: string,
  exactRevision: string | null,
): string {
  const target = exactRevision
    ? `Review the exact committed revision ${exactRevision}. Confirm HEAD and cite this revision in the result.`
    : `Review all implementation changes since base revision ${baseRevision}, excluding tracker-only .beads changes.`;
  return `You are a fresh, independent comprehensive reviewer. You did not implement this work.

${target}

Review for correctness, acceptance-criteria coverage, regressions, security, error handling, concurrency and transaction risks where applicable, test quality, and unintended scope. Read applicable AGENTS.md and inspect actual source and diff. Inspect every path reported by git status, including untracked files. Run the strongest relevant tests that are safe in this repository.

Do not edit, format, generate, stage, commit, reset, or push files. If a command would mutate tracked files, do not run it. Report only reproducible defects; do not invent findings to appear thorough. Approval requires no unresolved findings and no failed relevant tests.

EPIC CONTEXT
${JSON.stringify(issueView(epic))}

ISSUE UNDER REVIEW
${JSON.stringify(issueView(issue))}

Return only the requested structured review result.`;
}

export function finalEpicReviewPrompt(
  snapshot: EpicSnapshot,
  epicBaseRevision: string,
  head: string,
): string {
  return `You are the final independent verifier for an entire completed Beads epic.

Review the exact repository revision ${head} against the epic and all descendant acceptance criteria. Inspect the complete change from epic base ${epicBaseRevision} through ${head}, the dependency graph, production code, and tests. Run the strongest relevant verification that is safe. Confirm that the child implementations compose without gaps or conflicting ownership.

Do not edit, format, generate, stage, commit, reset, or push files. Report only evidence-backed defects. Approval requires no unresolved findings, no failed relevant tests, and an exact revision of ${head} in the result.

EPIC SNAPSHOT
${JSON.stringify(snapshotView(snapshot))}

Return only the requested structured review result.`;
}
