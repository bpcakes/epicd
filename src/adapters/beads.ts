import { z } from "zod";
import { IssueSchema, type EpicSnapshot, type Issue } from "../domain/types.js";
import { isIssueDescendant } from "../domain/issue-hierarchy.js";
import { runCommand, runJson } from "../util/command.js";

const IssueListSchema = z.union([z.array(IssueSchema), z.object({ issues: z.array(IssueSchema) })]);

export type IssueOwnership = { kind: "unassigned" } | { kind: "this-run" | "other"; owner: string };

function actorForRun(runId: string): string {
  return `epicd:${runId}`;
}

function parseIssueList(value: unknown): Issue[] {
  const parsed = IssueListSchema.parse(value);
  return Array.isArray(parsed) ? parsed : parsed.issues;
}

export class BeadsClient {
  constructor(readonly repoPath: string) {}

  /** Interprets tracker assignees; callers own the resulting workflow decision. */
  classifyOwnership(issue: Pick<Issue, "assignee">, runId: string): IssueOwnership {
    const owner = typeof issue.assignee === "string" ? issue.assignee.trim() : "";
    if (!owner) return { kind: "unassigned" };
    return { kind: owner === actorForRun(runId) ? "this-run" : "other", owner };
  }

  private async queryIssueList(
    command: "list" | "ready" | "blocked",
    args: readonly string[] = [],
  ): Promise<Issue[]> {
    const value = await runJson("br", [command, ...args, "--limit", "0", "--json"], {
      cwd: this.repoPath,
    });
    return parseIssueList(value);
  }

  async versions(): Promise<{ br: string; bv: string }> {
    const [br, bv] = await Promise.all([
      runCommand("br", ["--version"], { cwd: this.repoPath }),
      runCommand("bv", ["--version"], { cwd: this.repoPath }),
    ]);
    return { br: br.stdout.trim(), bv: bv.stdout.trim() };
  }

  async listAll(): Promise<Issue[]> {
    return await this.queryIssueList("list", ["--all"]);
  }

  async listOpenEpics(): Promise<Issue[]> {
    return await this.queryIssueList("list", ["--status=open", "--type=epic"]);
  }

  async show(id: string): Promise<Issue> {
    const value = await runJson("br", ["show", id, "--json"], { cwd: this.repoPath });
    const candidate = Array.isArray(value) ? value[0] : value;
    return IssueSchema.parse(candidate);
  }

  async ready(epicId?: string): Promise<Issue[]> {
    return await this.queryIssueList("ready", epicId ? ["--epic", epicId] : []);
  }

  async blocked(): Promise<Issue[]> {
    return await this.queryIssueList("blocked");
  }

  async triage(): Promise<unknown> {
    return await runJson("bv", ["--robot-triage"], { cwd: this.repoPath });
  }

  async plan(): Promise<unknown> {
    return await runJson("bv", ["--robot-plan"], { cwd: this.repoPath });
  }

  async graph(): Promise<unknown> {
    return await runJson("bv", ["--robot-graph", "--graph-format=json"], {
      cwd: this.repoPath,
    });
  }

  async snapshot(epicId: string): Promise<EpicSnapshot> {
    const [epic, allIssues, readyIssues, blockedIssues, triage, plan, graph] = await Promise.all([
      this.show(epicId),
      this.listAll(),
      this.ready(epicId),
      this.blocked(),
      this.triage(),
      this.plan(),
      this.graph(),
    ]);
    if (epic.issue_type !== "epic")
      throw new Error(`${epicId} is a ${epic.issue_type}, not an epic`);
    const ancestor = { id: epicId };
    const issues = allIssues.filter((issue) => isIssueDescendant(issue, ancestor));
    return {
      epic,
      issues,
      openIssues: issues.filter(
        (issue) => issue.status !== "closed" && issue.status !== "tombstone",
      ),
      readyIssues: readyIssues.filter((issue) => isIssueDescendant(issue, ancestor)),
      blockedIssues: blockedIssues.filter((issue) => isIssueDescendant(issue, ancestor)),
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
    if (!isIssueDescendant(issue, { id: epicId }))
      throw new Error(`${candidateId} is not a descendant of ${epicId}`);
    if (issue.issue_type === "epic")
      throw new Error(`${candidateId} is an epic container and cannot be claimed`);
    if (!issue.description.trim() && !issue.acceptance_criteria.trim()) {
      throw new Error(`${candidateId} does not own concrete implementation work`);
    }

    await this.claimMutation(candidateId, runId);
    return await this.show(candidateId);
  }

  /**
   * Atomically adopts dependency-safe work that was marked in progress without
   * recording an owner. Beads rejects blocked work and ownership races.
   */
  async adoptUnownedInProgress(epicId: string, candidateId: string, runId: string): Promise<Issue> {
    const issue = await this.show(candidateId);
    if (!isIssueDescendant(issue, { id: epicId }))
      throw new Error(`${candidateId} is not a descendant of ${epicId}`);
    if (issue.issue_type === "epic")
      throw new Error(`${candidateId} is an epic container and cannot be adopted`);
    const ownership = this.classifyOwnership(issue, runId);
    if (issue.status !== "in_progress" || ownership.kind !== "unassigned") {
      throw new Error(
        `${candidateId} is not unowned in-progress work (status ${issue.status}, owner ${ownership.kind === "unassigned" ? "none" : ownership.owner})`,
      );
    }

    await this.claimMutation(candidateId, runId);
    return await this.show(candidateId);
  }

  private async claimMutation(candidateId: string, runId: string): Promise<void> {
    await runJson(
      "br",
      [
        "update",
        candidateId,
        "--claim",
        "--actor",
        actorForRun(runId),
        "--agent-name",
        "epicd",
        "--harness",
        "epicd",
        "--json",
      ],
      { cwd: this.repoPath },
    );
  }

  async close(id: string, reason: string): Promise<void> {
    await runJson("br", ["close", id, `--reason=${reason}`, "--json"], {
      cwd: this.repoPath,
    });
  }

  async sync(): Promise<void> {
    await runCommand("br", ["sync", "--flush-only"], { cwd: this.repoPath });
  }
}
