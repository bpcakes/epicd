import type { Issue } from "./types.js";

type IssueIdentity = Pick<Issue, "id">;

/** Beads currently encodes ancestry in dot-delimited issue IDs. */
export function isIssueDescendant(issue: IssueIdentity, ancestor: IssueIdentity): boolean {
  return issue.id.startsWith(`${ancestor.id}.`);
}

/** Orders children before their ancestors; peers keep their existing order. */
export function compareIssuesDeepestFirst(left: IssueIdentity, right: IssueIdentity): number {
  return right.id.split(".").length - left.id.split(".").length;
}
