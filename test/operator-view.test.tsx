import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { OperatorView } from "../src/tui/operator-view.js";
import type { OperatorRequest } from "../src/operator-controls.js";
import { operatorFixture } from "./fixtures/operator.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
async function viewFor(
  f: Awaited<ReturnType<typeof operatorFixture>>,
  submit = f.operator.submit.bind(f.operator),
) {
  const close = vi.fn();
  const view = render(
    <OperatorView controls={{ status: () => f.operator.status(), submit }} close={close} />,
  );
  cleanup.push(() => view.unmount());
  await setImmediate();
  const key = async (text: string) => {
    view.stdin.write(text);
    await setImmediate();
  };
  const enter = async (text: string) => {
    if (text) await key(text);
    await key("\r");
  };
  return { view, close, key, enter };
}

describe.runIf(process.platform === "linux")("operator console interaction", () => {
  it("opens and closes without pausing, answering, granting, or acquiring a controller lease", async () => {
    const f = await operatorFixture(),
      before = f.operator.status(),
      v = await viewFor(f);
    expect(v.view.lastFrame()).toContain("gpt-6-astra");
    expect(v.view.lastFrame()).toContain("Operator console");
    await v.key("q");
    expect(v.close).toHaveBeenCalledOnce();
    expect(f.operator.status()).toEqual(before);
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });

  it("requires typed confirmation to pause and cancels an unsubmitted request with Escape", async () => {
    const f = await operatorFixture(),
      v = await viewFor(f);
    await v.key("1");
    await expect.poll(() => v.view.lastFrame()).toContain("Type confirm");
    await v.enter("");
    expect(f.operator.status().control.status).toBe("active");
    await v.key("\u001b");
    expect(f.version()).toBe(0);
    await v.key("1");
    await v.enter("confirm");
    await expect.poll(() => f.operator.status().control.status).toBe("paused");
    expect(f.version()).toBe(1);
    expect(v.close).not.toHaveBeenCalled();
    expect(f.store.controllerLease(f.state.runId)).toBeNull();
  });

  it("shows and answers the exact question without converting the response into authority", async () => {
    const f = await operatorFixture(),
      escalationId = f.question(),
      v = await viewFor(f);
    await v.key("2");
    await v.enter("Yes, inspect the declared fixture");
    await expect.poll(() => v.view.lastFrame()).toContain(escalationId);
    expect(v.view.lastFrame()).toContain("Instruction only");
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    await v.enter("confirm");
    await expect.poll(() => f.operator.status().escalation).toBeNull();
    expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
  });

  it("does not treat an embedded pasted return as confirmation", async () => {
    const f = await operatorFixture(),
      v = await viewFor(f);
    await v.key("1");
    await v.key("confirm\r");
    await expect.poll(() => v.view.lastFrame()).toContain("confirm▏");
    expect(f.operator.status().control.status).toBe("active");
    expect(f.version()).toBe(0);
    await v.key("\r");
    await expect.poll(() => f.operator.status().control.status).toBe("paused");
    expect(f.version()).toBe(1);
  });

  it("does not silently refresh the observed version while a response is being composed", async () => {
    const f = await operatorFixture(),
      escalationId = f.question(),
      v = await viewFor(f);
    await v.key("2");
    await v.enter("Investigate first");
    f.store.orchestration.operatorControl(f.state.runId, f.version(), { kind: "pause" });
    await v.enter("confirm");
    await expect.poll(() => v.view.lastFrame()).toContain("Control changed");
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    expect(f.operator.status().control.status).toBe("paused");
  });

  it("shows the declared resource and management scope before creating only the confirmed grant", async () => {
    const f = await operatorFixture(),
      escalationId = f.question(),
      v = await viewFor(f);
    await v.key("3");
    for (const value of ["browser-db", "inspect,create", f.expiry(), f.executable])
      await v.enter(value);
    await expect.poll(() => v.view.lastFrame()).toContain("Declared endpoint and resource");
    expect(v.view.lastFrame()).toContain("fixture_app");
    expect(v.view.lastFrame()).toContain("disposable_browser_0");
    expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    await v.enter("confirm");
    await expect.poll(() => f.store.orchestration.fixtures.grants(f.state.runId)).toHaveLength(1);
    expect(f.store.orchestration.fixtures.grants(f.state.runId)[0]!.operations).toEqual([
      "inspect",
      "create",
    ]);
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
    expect(f.connections).toBe(0);
  });

  it("shows the dedicated SQL role and broker before recording independent SQL authority", async () => {
    const f = await operatorFixture(),
      v = await viewFor(f);
    await v.key("5");
    for (const value of ["browser-db", f.expiry(), f.executable]) await v.enter(value);
    await expect.poll(() => v.view.lastFrame()).toContain("Dedicated validation role and broker");
    expect(v.view.lastFrame()).toContain("fixture_app");
    expect(f.store.orchestration.fixtures.validation.grants(f.state.runId)).toEqual([]);
    await v.enter("confirm");
    await expect
      .poll(() => f.store.orchestration.fixtures.validation.grants(f.state.runId))
      .toHaveLength(1);
    expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
    expect(f.store.orchestration.fixtures.creations(f.state.runId)).toEqual([]);
    expect(f.connections).toBe(0);
  });

  it.each(["management", "sql"] as const)(
    "revokes only the exact confirmed %s grant",
    async (kind) => {
      const f = await operatorFixture();
      await f.operator.submit({
        kind: "grant_fixture",
        fixtureId: "browser-db",
        operations: ["inspect"],
        controlVersion: f.version(),
        expiresAt: f.expiry(),
        psqlPath: f.executable,
      });
      await f.operator.submit({
        kind: "grant_sql",
        fixtureId: "browser-db",
        controlVersion: f.version(),
        expiresAt: f.expiry(),
        psqlPath: f.executable,
      });
      const management = f.store.orchestration.fixtures.grants(f.state.runId)[0]!;
      const sql = f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!;
      const selected = kind === "management" ? management : sql;
      const v = await viewFor(f);
      await v.key(kind === "management" ? "4" : "6");
      await v.enter(selected.grantId);
      expect(v.view.lastFrame()).toContain(selected.grantId);
      await v.enter("confirm");
      await expect
        .poll(() =>
          kind === "management"
            ? f.store.orchestration.fixtures.grants(f.state.runId)[0]!.revokedAt
            : f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt,
        )
        .not.toBeNull();
      expect(
        kind === "management"
          ? f.store.orchestration.fixtures.validation.grants(f.state.runId)[0]!.revokedAt
          : f.store.orchestration.fixtures.grants(f.state.runId)[0]!.revokedAt,
      ).toBeNull();
      expect(f.connections).toBe(0);
    },
  );

  it("previews native handoff and sends exactly one explicit target with the observed version", async () => {
    const f = await operatorFixture(),
      submit = vi.fn<(request: OperatorRequest) => Promise<string>>(async () => "Recorded handoff");
    const v = await viewFor(f, submit);
    await v.key("7");
    for (const value of ["herdr", "/selected/codex", "/selected/herdr", "no"]) await v.enter(value);
    expect(v.view.lastFrame()).toMatch(/native Herdr stays\s+native/);
    expect(submit).not.toHaveBeenCalled();
    await v.enter("confirm");
    await expect.poll(() => submit.mock.calls.length).toBe(1);
    expect(submit.mock.calls[0]![0]).toEqual({
      kind: "handoff",
      controlVersion: 0,
      runtime: "herdr",
      codexPath: "/selected/codex",
      herdrPath: "/selected/herdr",
    });
    expect(f.store.orchestration.agents.instances(f.state.runId)).toEqual([]);
  });

  it("submits the exact abandonment ID and reason only after confirmation", async () => {
    const f = await operatorFixture();
    const submit = vi.fn<(request: OperatorRequest) => Promise<string>>(
      async () => "Conversation transfer abandoned",
    );
    const v = await viewFor(f, submit);
    await v.key("8");
    await v.enter("transfer-to-abandon");
    await v.enter("The session cannot resume");
    expect(v.view.lastFrame()).toContain("Retains evidence");
    expect(submit).not.toHaveBeenCalled();
    await v.enter("confirm");
    await expect.poll(() => submit.mock.calls.length).toBe(1);
    expect(submit.mock.calls[0]![0]).toEqual({
      kind: "abandon_conversation",
      transferId: "transfer-to-abandon",
      reason: "The session cannot resume",
      controlVersion: 0,
    });
  });

  it("sends conversation retention only after an explicit yes", async () => {
    const f = await operatorFixture(),
      submit = vi.fn<(request: OperatorRequest) => Promise<string>>(async () => "Recorded handoff");
    const v = await viewFor(f, submit);
    await v.key("7");
    for (const value of ["herdr", "/selected/codex", "/selected/herdr", "yes"])
      await v.enter(value);
    expect(v.view.lastFrame()).toContain("transfer exclusively");
    await v.enter("confirm");
    await expect.poll(() => submit.mock.calls.length).toBe(1);
    expect(submit.mock.calls[0]![0]).toMatchObject({ retainCoordinatorSession: true });
  });

  it("does not send duplicate commands or treat close as a second mutation while a request is pending", async () => {
    const f = await operatorFixture();
    let release!: (value: string) => void;
    const work = new Promise<string>((resolve) => {
      release = resolve;
    });
    const submit = vi.fn<(request: OperatorRequest) => Promise<string>>(() => work);
    const v = await viewFor(f, submit);
    try {
      await v.key("1");
      await v.enter("confirm");
      await expect.poll(() => submit.mock.calls.length).toBe(1);
      await v.enter("confirm");
      await v.key("1");
      expect(submit).toHaveBeenCalledOnce();
      await v.key("\u0003");
      expect(v.close).toHaveBeenCalledOnce();
    } finally {
      release("Original request settled");
      await work;
    }
  });

  it("rejects oversized pasted input without silently truncating or submitting it", async () => {
    const f = await operatorFixture(),
      escalationId = f.question(),
      v = await viewFor(f);
    await v.key("2");
    await v.key("é".repeat(3501));
    await expect.poll(() => v.view.lastFrame()).toContain("nothing was truncated or submitted");
    expect(f.operator.status().escalation?.escalationId).toBe(escalationId);
    await v.key("\u001b");
    expect(f.store.orchestration.fixtures.grants(f.state.runId)).toEqual([]);
  });

  it("pages frozen fixture declarations without requesting authority", async () => {
    const f = await operatorFixture(5),
      v = await viewFor(f),
      before = f.operator.status();
    expect(v.view.lastFrame()).toContain("browser-db");
    await v.key("]");
    await expect.poll(() => v.view.lastFrame()).toContain("fixture-4");
    await v.key("[");
    await expect.poll(() => v.view.lastFrame()).toContain("browser-db");
    expect(f.operator.status()).toEqual(before);
  });
});
