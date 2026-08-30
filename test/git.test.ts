import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitClient } from "../src/adapters/git.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function repositoryFixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "epicd-git-"));
  tempDirs.push(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "epicd test");
  git(repo, "config", "user.email", "epicd@example.test");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "fixture");
  return repo;
}

describe("GitClient revision parsing", () => {
  it("resolves repository, commit, tree, and index paths through the same behavior", async () => {
    const repo = repositoryFixture();
    const client = new GitClient(repo);
    const head = git(repo, "rev-parse", "HEAD");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");

    expect(await client.root()).toBe(repo);
    expect(await client.head()).toBe(head);
    expect(await client.tree(head)).toBe(tree);
    expect(await client.prospectiveTree()).toBe(tree);
  });
});
