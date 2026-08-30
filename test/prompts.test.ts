import { describe, expect, it } from "vitest";
import { IssueSchema, type EpicSnapshot } from "../src/domain/types.js";
import {
  finalEpicReviewPrompt,
  reviewFixesPrompt,
  taskReviewPrompt,
  taskVerificationPrompt,
} from "../src/engine/prompts.js";

const issue = IssueSchema.parse({
  id: "epic.1",
  title: "Concrete work",
  description: "Implement it",
  acceptance_criteria: "It works",
  status: "open",
  priority: 1,
  issue_type: "task",
  labels: [],
});

const snapshot: EpicSnapshot = {
  epic: { ...issue, id: "epic", issue_type: "epic" },
  issues: [issue],
  openIssues: [issue],
  readyIssues: [issue],
  triage: {},
  plan: {},
  graph: {},
};

describe("reviewer prompts", () => {
  const prompts = [
    taskReviewPrompt(snapshot.epic, issue, "base-revision"),
    reviewFixesPrompt(issue, [], "base-revision", null),
    taskVerificationPrompt(issue, "candidate-revision"),
    finalEpicReviewPrompt(snapshot, "base-revision", "head-revision"),
  ];

  it.each(prompts)("enforces the universal read-only reviewer boundary", (prompt) => {
    expect(prompt).toContain("Do not edit, format, generate, stage, commit, reset, or push files.");
    expect(prompt).toContain("If a command would mutate tracked files, do not run it.");
    expect(prompt).toContain("Return only the requested structured review result.");
  });

  it("keeps comprehensive, repair, exact-revision, and final scopes distinct", () => {
    expect(prompts[0]).toContain("fresh, independent comprehensive reviewer");
    expect(prompts[1]).toContain("Verify only whether each reported finding is resolved");
    expect(prompts[2]).toContain("exact-revision verifier");
    expect(prompts[3]).toContain("final independent verifier for an entire completed Beads epic");
  });
});
