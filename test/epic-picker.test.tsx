import { setImmediate } from "node:timers/promises";
import { render } from "ink-testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { EpicPicker, type EpicBrowserQuery } from "../src/tui/epic-picker.js";
import type { EpicBrowserItem } from "../src/epic-browser.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const item = (id: string, parentIds: string[] = []): EpicBrowserItem => ({
  epic: { id, title: `Build ${id}`, priority: 2, status: "open" },
  parentIds,
  notice: null,
  action: { kind: "start" },
});
async function setup(
  items: EpicBrowserItem[],
  query: EpicBrowserQuery = { page: 1, search: "", showNested: false },
  hasNextPage = false,
) {
  const onSelect = vi.fn(),
    onQuit = vi.fn(),
    onBrowse = vi.fn();
  const view = render(
    <EpicPicker
      items={items}
      runtime="sdk"
      onSelect={onSelect}
      onQuit={onQuit}
      query={query}
      hasNextPage={hasNextPage}
      onBrowse={onBrowse}
    />,
  );
  cleanup.push(() => view.unmount());
  await setImmediate();
  const key = async (input: string) => {
    view.stdin.write(input);
    await setImmediate();
  };
  return { view, key, onSelect, onQuit, onBrowse };
}

it("opens account setup directly for a selected new epic and submits only once", async () => {
  const nested = item("nested", ["root"]);
  const v = await setup([item("root"), nested, item("root.lookalike")]);
  expect(v.view.lastFrame()).toContain("root.lookalike");
  expect(v.view.lastFrame()).not.toContain("Build nested");
  await v.key("a");
  await v.key("j");
  await v.key("\r");
  expect(v.onSelect).toHaveBeenCalledExactlyOnceWith(nested);
  expect(v.view.lastFrame()).not.toContain("CONFIGURE EPIC");
  await v.key("\r");
  expect(v.onSelect).toHaveBeenCalledOnce();
});

it("reloads the current query without selecting work", async () => {
  const query = { page: 3, search: "needle", showNested: true };
  const v = await setup([item("needle")], query);
  await v.key("r");
  expect(v.onBrowse).toHaveBeenCalledExactlyOnceWith(query);
  expect(v.onSelect).not.toHaveBeenCalled();
});

it.each([["token=refresh"], [..."token=refresh"]])(
  "preserves search text across input chunking (%j)",
  async (...chunks) => {
    const v = await setup([]);
    await v.key("/");
    expect(v.view.lastFrame()).toContain(
      "Search terms can be visible to other local processes. Avoid secrets.",
    );
    for (const chunk of chunks) await v.key(chunk);
    expect(v.view.lastFrame()).toContain("token=[REDACTED]");
    await v.key("\r");
    expect(v.onBrowse).toHaveBeenCalledExactlyOnceWith({
      page: 1,
      search: "token=refresh",
      showNested: true,
    });
  },
);

it("shows recorded settings for a nested saved run and never launches on quit", async () => {
  const saved = item("nested", ["root"]);
  saved.action = {
    kind: "resume",
    runId: "saved-run",
    controlVersion: 2,
    status: "paused",
    runtime: "herdr",
  };
  const v = await setup([item("root"), saved]);
  expect(v.view.lastFrame()).toContain("Build nested");
  await v.key("j");
  await v.key("\r");
  expect(v.view.lastFrame()).toContain("RESUME EPIC");
  expect(v.view.lastFrame()).toContain("Runtime: herdr");
  await v.key("q");
  expect(v.onQuit).toHaveBeenCalledOnce();
  expect(v.onSelect).not.toHaveBeenCalled();
});

it("shows why an epic is unavailable and ignores confirmation", async () => {
  const disabled = item("blocked");
  disabled.action = {
    kind: "unavailable",
    runId: null,
    reason: "Another run owns this repository",
  };
  const v = await setup([disabled]);
  await v.key("\r");
  await v.key("y");
  await v.key("\r");
  expect(v.view.lastFrame()).toContain("Another run owns this repository");
  expect(v.onSelect).not.toHaveBeenCalled();
  await v.key("b");
  expect(v.view.lastFrame()).toContain("choose an epic");
});

it.each(["open", "deferred", "blocked", "in_progress"] as const)(
  "shows %s tracker status before opening account setup",
  async (status) => {
    const epic = item("e");
    epic.epic.status = status;
    const v = await setup([epic]);
    expect(v.view.lastFrame()).toContain(`tracker: ${status}`);
    await v.key("\r");
    expect(v.onSelect).toHaveBeenCalledExactlyOnceWith(epic);
  },
);

it("displays unknown metadata honestly and confirms the saved run despite missing details", async () => {
  const saved: EpicBrowserItem = {
    epic: { id: "e", title: null, priority: null, status: null },
    parentIds: null,
    notice: "Tracker details and hierarchy could not be loaded.",
    action: {
      kind: "resume",
      runId: "saved-run",
      controlVersion: 2,
      status: "paused",
      runtime: "herdr",
    },
  };
  const v = await setup([saved]);
  expect(v.view.lastFrame()).toContain("Priority unknown");
  expect(v.view.lastFrame()).toContain("title unavailable");
  expect(v.view.lastFrame()).toMatch(/hierarchy[\s\S]*unknown/);
  expect(v.view.lastFrame()).not.toMatch(/P[0-4]/);
  await v.key("\r");
  expect(v.view.lastFrame()).toContain("RESUME EPIC");
  expect(v.view.lastFrame()).toContain("Tracker status: unknown");
  expect(v.view.lastFrame()).toContain("saved-run");
  expect(v.view.lastFrame()).toContain("Runtime: herdr");
  expect(v.view.lastFrame()).toContain(saved.notice);
  expect(v.onSelect).not.toHaveBeenCalled();
  await v.key("y");
  expect(v.onSelect).toHaveBeenCalledExactlyOnceWith(saved);
});

it("handles an empty list and Ctrl-C without selecting work", async () => {
  const v = await setup([]);
  expect(v.view.lastFrame()).toContain("No matching open epics");
  await v.key("j");
  await v.key("\r");
  await v.key("\u0003");
  expect(v.onSelect).not.toHaveBeenCalled();
  expect(v.onQuit).toHaveBeenCalledOnce();
});

it("keeps unavailable nested epics out of roots while retaining an invalid saved run", async () => {
  const nested = item("nested", ["owner"]),
    invalid = item("invalid", ["owner"]);
  nested.action = { kind: "unavailable", runId: null, reason: "Owner is active" };
  invalid.action = { kind: "unavailable", runId: "broken-run", reason: "Saved state is invalid" };
  const v = await setup([item("owner"), nested, invalid]);
  expect(v.view.lastFrame()).not.toContain("Build nested");
  expect(v.view.lastFrame()).toContain("Build invalid");
  await v.key("a");
  expect(v.view.lastFrame()).toContain("Build nested");
});

it("searches all tracker pages only after Enter and never treats search as launch confirmation", async () => {
  const v = await setup([item("other")], { page: 3, search: "", showNested: false });
  await v.key("/");
  await v.key("wanted");
  expect(v.onBrowse).not.toHaveBeenCalled();
  await v.key("\r");
  await v.key("\r");
  expect(v.onBrowse).toHaveBeenCalledExactlyOnceWith({
    page: 1,
    search: "wanted",
    showNested: true,
  });
  expect(v.onSelect).not.toHaveBeenCalled();
});

it.each([
  { key: "]", page: 2, search: "wanted" },
  { key: "c", page: 1, search: "" },
])("requests $key navigation without selecting a run", async ({ key, page, search }) => {
  const v = await setup([item("wanted")], { page: 1, search: "wanted", showNested: true }, true);
  await v.key(key);
  expect(v.onBrowse).toHaveBeenCalledExactlyOnceWith({ page, search, showNested: true });
  expect(v.onSelect).not.toHaveBeenCalled();
});
