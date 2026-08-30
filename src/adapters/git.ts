import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runCommand } from "../util/command.js";

export class GitClient {
  constructor(readonly repoPath: string) {}

  private async revParse(...args: string[]): Promise<string> {
    return (await runCommand("git", ["rev-parse", ...args], { cwd: this.repoPath })).stdout.trim();
  }

  async root(): Promise<string> {
    return await this.revParse("--show-toplevel");
  }

  async head(): Promise<string> {
    return await this.revParse("HEAD");
  }

  async status(): Promise<string> {
    return (
      await runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: this.repoPath,
      })
    ).stdout;
  }

  async reviewFingerprint(): Promise<string> {
    const [head, status, unstaged, staged, indexEntries, files] = await Promise.all([
      this.head(),
      this.status(),
      runCommand("git", ["diff", "--no-ext-diff", "--binary", "--", "."], {
        cwd: this.repoPath,
      }),
      runCommand("git", ["diff", "--cached", "--no-ext-diff", "--binary", "--", "."], {
        cwd: this.repoPath,
      }),
      runCommand("git", ["ls-files", "--stage", "-v", "-z"], {
        cwd: this.repoPath,
      }),
      runCommand("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: this.repoPath,
      }),
    ]);
    const hash = createHash("sha256");
    const add = (label: string, value: string | Buffer): void => {
      hash.update(`${label}\0${Buffer.byteLength(value)}\0`);
      hash.update(value);
    };
    add("head", head);
    add("status", status);
    add("unstaged", unstaged.stdout);
    add("staged", staged.stdout);
    add("index-entries", indexEntries.stdout);

    const paths = files.stdout.split("\0").filter(Boolean).sort();
    for (const path of paths) {
      const absolutePath = join(this.repoPath, path);
      add("path", path);
      try {
        const metadata = await lstat(absolutePath);
        add("mode", metadata.mode.toString(8));
        if (metadata.isSymbolicLink()) add("content", await readlink(absolutePath));
        else if (metadata.isDirectory()) add("content", "[directory]");
        else add("content", await readFile(absolutePath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        add("missing", "true");
      }
    }
    return hash.digest("hex");
  }

  async assertExactRevision(revision: string): Promise<void> {
    const head = await this.head();
    if (head !== revision) {
      throw new Error(`Expected HEAD ${revision}, but the repository is at ${head}`);
    }
    const status = (
      await runCommand(
        "git",
        [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--",
          ".",
          ":(exclude).beads",
          ":(exclude).beads/**",
        ],
        { cwd: this.repoPath },
      )
    ).stdout;
    if (status.trim()) {
      throw new Error(
        `Exact-revision verification requires a clean application tree at ${revision}:\n${status}`,
      );
    }
  }

  async prospectiveTree(): Promise<string> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "epicd-index-"));
    const temporaryIndex = join(temporaryDirectory, "index");
    try {
      const gitIndex = await this.revParse("--git-path", "index");
      await copyFile(resolve(this.repoPath, gitIndex), temporaryIndex);
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      await runCommand("git", ["add", "-A", "--", ".", ":(exclude).beads/**"], {
        cwd: this.repoPath,
        env,
      });
      return (await runCommand("git", ["write-tree"], { cwd: this.repoPath, env })).stdout.trim();
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  async tree(revision: string): Promise<string> {
    return await this.revParse(`${revision}^{tree}`);
  }

  async changedPaths(): Promise<string[]> {
    return (await this.status())
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .filter((path) => !path.startsWith(".beads/") && path !== ".beads");
  }

  async assertClean(): Promise<void> {
    const status = await this.status();
    if (status.trim())
      throw new Error(`Working tree must be clean before starting epicd:\n${status}`);
  }

  async diff(baseRevision: string): Promise<string> {
    return (
      await runCommand(
        "git",
        ["diff", "--no-ext-diff", "--binary", baseRevision, "--", ".", ":(exclude).beads/**"],
        {
          cwd: this.repoPath,
        },
      )
    ).stdout;
  }

  async stageImplementation(): Promise<void> {
    await runCommand("git", ["add", "-A", "--", ".", ":(exclude).beads/**"], {
      cwd: this.repoPath,
    });
  }

  async stageBeads(): Promise<void> {
    await runCommand("git", ["add", "-u", "--", ".beads"], { cwd: this.repoPath });
    for (const exportPath of [".beads/issues.jsonl", ".beads/beads.jsonl"]) {
      if (existsSync(join(this.repoPath, exportPath))) {
        await runCommand("git", ["add", "--", exportPath], { cwd: this.repoPath });
      }
    }
  }

  async hasStagedChanges(): Promise<boolean> {
    try {
      await runCommand("git", ["diff", "--cached", "--quiet"], { cwd: this.repoPath });
      return false;
    } catch {
      return true;
    }
  }

  async commit(message: string): Promise<string> {
    if (!(await this.hasStagedChanges())) throw new Error("Refusing to create an empty commit");
    await runCommand("git", ["commit", "-m", message], { cwd: this.repoPath });
    return await this.head();
  }

  async commitBeadsIfChanged(message: string): Promise<string | null> {
    await this.stageBeads();
    if (!(await this.hasStagedChanges())) return null;
    return await this.commit(message);
  }
}
