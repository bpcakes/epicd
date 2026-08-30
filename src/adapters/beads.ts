import { IssueSchema, type EpicSnapshot, type Issue } from "../domain/types.js";
import { runCommand, runJson } from "../util/command.js";

type IssueListEnvelope = { issues?: unknown[] };

function parseIssueList(value: unknown): Issue[] {
  const raw = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as IssueListEnvelope).issues)
      ? ((value as IssueListEnvelope).issues ?? [])
      : [];
  return raw.map((issue) => IssueSchema.parse(issue));
}

function isDescendant(epicId: string, candidateId: string): boolean {
  return candidateId.startsWith(`${epicId}.`);
}

export class BeadsClient {
  constructor(readonly repoPath: string) {}

  async versions(): Promise<{ br: string; bv: string }> {
    const [br, bv] = await Promise.all([
      runCommand("br", ["--version"], { cwd: this.repoPath }),
      runCommand("bv", ["--version"], { cwd: this.repoPath }),
    ]);
    return { br: br.stdout.trim(), bv: bv.stdout.trim() };
  }

  async listAll(): Promise<Issue[]> {
    const value = await runJson<unknown>("br", ["list", "--all", "--limit", "0", "--json"], {
      cwd: this.repoPath,
    });
    return parseIssueList(value);
  }

  async listOpenEpics(): Promise<Issue[]> {
    const value = await runJson<unknown>(
      "br",
      ["list", "--status=open", "--type=epic", "--limit", "0", "--json"],
      { cwd: this.repoPath },
    );
    return parseIssueList(value);
  }

  async show(id: string): Promise<Issue> {
    const value = await runJson<unknown>("br", ["show", id, "--json"], { cwd: this.repoPath });
    const candidate = Array.isArray(value) ? value[0] : value;
    return IssueSchema.parse(candidate);
  }

  async ready(epicId?: string): Promise<Issue[]> {
    const args = ["ready", "--limit", "0", "--json"];
    if (epicId) args.splice(1, 0, "--epic", epicId);
    const value = await runJson<unknown>("br", args, { cwd: this.repoPath });
    return parseIssueList(value);
  }

  async triage(): Promise<unknown> {
    return await runJson<unknown>("bv", ["--robot-triage"], { cwd: this.repoPath });
  }

  async plan(): Promise<unknown> {
    return await runJson<unknown>("bv", ["--robot-plan"], { cwd: this.repoPath });
  }

  async graph(): Promise<unknown> {
    return await runJson<unknown>("bv", ["--robot-graph", "--graph-format=json"], {
      cwd: this.repoPath,
    });
  }

  async snapshot(epicId: string): Promise<EpicSnapshot> {
    const [epic, allIssues, readyIssues, triage, plan, graph] = await Promise.all([
      this.show(epicId),
      this.listAll(),
      this.ready(epicId),
      this.triage(),
      this.plan(),
      this.graph(),
    ]);
    if (epic.issue_type !== "epic")
      throw new Error(`${epicId} is a ${epic.issue_type}, not an epic`);
    const issues = allIssues.filter((issue) => isDescendant(epicId, issue.id));
    return {
      epic,
      issues,
      openIssues: issues.filter(
        (issue) => issue.status !== "closed" && issue.status !== "tombstone",
      ),
      readyIssues: readyIssues.filter((issue) => isDescendant(epicId, issue.id)),
      triage,
      plan,
      graph,
    };
  }

  /**
   * Enforces the repository's authoritative gate immediately before mutation.
   * No model recommendation or earlier snapshot can bypass these checks.
   */
  async claim(epicId: string, candidateId: string, runId: string): Promise<Issue> {
    const ready = await this.ready(epicId);
    const readyCandidate = ready.find((issue) => issue.id === candidateId);
    if (!readyCandidate)
      throw new Error(`${candidateId} is absent from the immediately preceding br ready result`);

    const issue = await this.show(candidateId);
    if (!isDescendant(epicId, issue.id))
      throw new Error(`${candidateId} is not a descendant of ${epicId}`);
    if (issue.issue_type === "epic")
      throw new Error(`${candidateId} is an epic container and cannot be claimed`);
    if (!issue.description.trim() && !issue.acceptance_criteria.trim()) {
      throw new Error(`${candidateId} does not own concrete implementation work`);
    }

    await runJson<unknown>(
      "br",
      [
        "update",
        candidateId,
        "--status=in_progress",
        "--assignee",
        `epicd:${runId}`,
        "--agent-name",
        "epicd",
        "--harness",
        "codex-sdk",
        "--json",
      ],
      { cwd: this.repoPath },
    );
    return await this.show(candidateId);
  }

  async close(id: string, reason: string): Promise<void> {
    await runJson<unknown>("br", ["close", id, `--reason=${reason}`, "--json"], {
      cwd: this.repoPath,
    });
  }

  async sync(): Promise<void> {
    await runCommand("br", ["sync", "--flush-only"], { cwd: this.repoPath });
  }
}
