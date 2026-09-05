import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { render } from "ink";
import { afterEach, expect, it, vi } from "vitest";
import { BeadsClient } from "../src/adapters/beads.js";
import { GitClient } from "../src/adapters/git.js";
import { EpicEngine } from "../src/engine/engine.js";
import { IssueSchema } from "../src/domain/types.js";
import { runDoctor } from "../src/doctor.js";
import type { PickerItem } from "../src/tui/picker.js";

vi.mock("ink", async (original) => ({
  ...(await original<typeof import("ink")>()),
  render: vi.fn(),
}));
vi.mock("../src/doctor.js", () => ({ runDoctor: vi.fn() }));

const tempDirs: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalTty) Object.defineProperty(process.stdout, "isTTY", originalTty);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

it("passes the CLI Codex override to preflight after a picker selection", async () => {
  const root = mkdtempSync(join(tmpdir(), "epicd-picker-cli-"));
  tempDirs.push(root);
  vi.stubEnv("XDG_STATE_HOME", root);
  const codexPath = join(root, "selected-codex");
  process.argv = [process.execPath, "epicd", "--repo", root, "--codex-path", codexPath];
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(GitClient.prototype, "root").mockResolvedValue(root);
  vi.spyOn(BeadsClient.prototype, "listOpenEpics").mockResolvedValue([
    IssueSchema.parse({ id: "epic", title: "Selected epic", issue_type: "epic", status: "open" }),
  ]);
  const create = vi.spyOn(EpicEngine, "create");
  vi.mocked(runDoctor)
    .mockResolvedValueOnce({ repoPath: root, checks: [] })
    .mockResolvedValueOnce({
      repoPath: root,
      checks: [{ name: "runtime", status: "fail", message: "selected runtime unavailable" }],
    });
  vi.mocked(render).mockImplementation((node) => {
    const { items, loadEngine } = (
      node as ReactElement<{
        items: PickerItem[];
        loadEngine: (item: PickerItem) => Promise<EpicEngine>;
      }>
    ).props;
    return { waitUntilExit: () => loadEngine(items[0]!) } as unknown as ReturnType<typeof render>;
  });

  await import("../src/cli.js");

  expect(runDoctor).toHaveBeenNthCalledWith(1, root, "sdk", { mode: "selection", codexPath });
  expect(runDoctor).toHaveBeenNthCalledWith(2, root, "sdk", { mode: "workflow", codexPath });
  expect(create).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("selected runtime unavailable"));
  expect(process.exitCode).toBe(1);
});
