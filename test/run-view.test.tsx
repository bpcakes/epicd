import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { StateStore } from "../src/adapters/store.js";
import { RepositoryPolicySchema } from "../src/domain/repository-policy.js";
import { OrchestratorController } from "../src/controller.js";
import { RunView } from "../src/tui/run-view.js";
import { initialRun } from "./fixtures/orchestration/state.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
it("displays journal facts and records pause without exiting ahead of controller settlement", async () => {
  const root = mkdtempSync("/var/tmp/epicd-view-");
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new StateStore(join(root, "state.sqlite3"));
  cleanup.push(() => store.close());
  const state = store.create(initialRun(), RepositoryPolicySchema.parse({ schemaVersion: 1 }));
  const lease = store.acquireLease(state.runId);
  const controller = new OrchestratorController(store, state.runId),
    stop = vi.fn();
  const view = render(<RunView controller={controller} stop={stop} />);
  cleanup.push(() => view.unmount());
  await setImmediate();
  expect(view.lastFrame()).toContain("gpt-6-astra");
  expect(view.lastFrame()).toContain("active");
  view.stdin.write("p");
  await expect.poll(() => stop.mock.calls.length).toBe(1);
  expect(store.orchestration.control(state.runId).status).toBe("paused");
  expect(store.controllerLease(state.runId)?.leaseId).toBe(lease.leaseId);
});
