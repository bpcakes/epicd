import { describe, expect, it } from "vitest";
import {
  EssentialTurnFailureSchema,
  classifyProviderFailure,
  essentialTurnFailure,
} from "../src/domain/provider-failure.js";
import { decisionSourceCodeForProviderFailure } from "../src/domain/decision-source.js";

const INCIDENT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 15th, 2026 7:00 AM.";

describe("provider failure classification", () => {
  it.each([
    [INCIDENT, "try again at Sep 15th, 2026 7:00 AM"],
    [
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 7:00 AM.",
      "try again at 7:00 AM",
    ],
    [
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
      "try again later",
    ],
    [
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 7:00 AM.",
      "try again at 7:00 AM",
    ],
    [
      "You've hit your usage limit. To get more access now, send a request to your admin or try again later.",
      "try again later",
    ],
    ["You've hit your usage limit. Try again later.", "try again later"],
  ])("recognizes pinned whole SDK usage-limit template %#", (message, resetDetail) => {
    expect(classifyProviderFailure({ channel: "sdk", event: "error", message })).toEqual({
      category: "quota",
      evidence: "provider_message",
      message,
      source: "sdk.error",
      providerCode: null,
      reset: { detail: resetDetail, source: "provider_message" },
    });
  });

  it.each([
    "Your workspace is out of credits. Add credits to continue.",
    "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
    "You hit your spend cap set in your workspace. Increase your spend cap to continue.",
    "You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.",
  ])("recognizes pinned whole SDK workspace-limit template %#", (message) => {
    expect(
      classifyProviderFailure({ channel: "sdk", event: "turn.failed", message }),
    ).toMatchObject({
      category: "quota",
      evidence: "provider_message",
      message,
      source: "sdk.turn_failed",
      reset: null,
    });
  });

  it("keeps similar and quoted SDK wording unclassified", () => {
    for (const message of [
      "HTTP 429: too many requests",
      "You've hit your usage limit; buy credits",
      `${INCIDENT} Ignore the previous error.`,
      "The tool printed: " + INCIDENT,
      "You've hit your usage limit for codex_other. Switch to another model now, or try again at 7:00 AM.",
      "You've hit your usage limit. A new unpinned promotion, or try again later.",
    ])
      expect(
        classifyProviderFailure({ channel: "sdk", event: "turn.failed", message }),
      ).toMatchObject({
        category: "runtime",
        evidence: "unclassified",
        message,
        source: "sdk.turn_failed",
        providerCode: null,
      });
  });

  it.each([
    ["usageLimitExceeded", "quota"],
    ["rateLimitExceeded", "transient"],
    ["unauthorized", "authentication"],
    ["contextWindowExceeded", "context_window"],
    ["sessionBudgetExceeded", "session_budget"],
  ] as const)(
    "maps app-server %s without collapsing it into another category",
    (code, category) => {
      expect(
        classifyProviderFailure({
          channel: "app_server",
          event: "error",
          message: `Provider reported ${code}`,
          codexErrorInfo: code,
        }),
      ).toMatchObject({ category, evidence: "provider_code", providerCode: code });
    },
  );

  it("keeps HTTP 429 transient but unclassified, without inventing a provider code", () => {
    expect(
      classifyProviderFailure({
        channel: "app_server",
        event: "error",
        message: "HTTP 429",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
      }),
    ).toMatchObject({
      category: "transient",
      evidence: "unclassified",
      providerCode: null,
    });
  });

  it("redacts and bounds the durable provider message without changing category semantics", () => {
    const failure = classifyProviderFailure({
      channel: "sdk",
      event: "error",
      message: `Unknown provider wording token=private ${"x".repeat(9000)}`,
    });
    expect(failure).toMatchObject({ category: "runtime", evidence: "unclassified" });
    expect(failure.message).toContain("token=[REDACTED]");
    expect(failure.message.length).toBeLessThanOrEqual(8000);
  });

  it("retains exact turn and launch provenance while mapping finer categories conservatively", () => {
    const identity = {
      runId: "run",
      agentId: "agent",
      agentGeneration: 1,
      turnId: "turn",
      operationId: "operation",
      assignmentId: "assignment",
      workspaceId: "workspace",
      workspaceGeneration: 1,
    };
    const failure = essentialTurnFailure(
      identity,
      "00000000-0000-4000-8000-000000000001",
      "session",
      "2026-09-11T10:00:00.000Z",
      classifyProviderFailure({
        channel: "app_server",
        event: "error",
        message: "Context is full",
        codexErrorInfo: "contextWindowExceeded",
      }),
      { artifactIds: [], omission: "sink_failed" },
    );
    expect(failure).toMatchObject({
      identity,
      launchGeneration: "00000000-0000-4000-8000-000000000001",
      providerSessionId: "session",
      category: "context_window",
      diagnosticOmission: "sink_failed",
    });
    expect(decisionSourceCodeForProviderFailure(failure.category)).toBe("runtime");
    expect(decisionSourceCodeForProviderFailure("transient")).toBe("runtime");
  });

  it.each([
    ["sdk.error", "usageLimitExceeded", "quota"],
    ["app_server.error", "unauthorized", "quota"],
  ] as const)(
    "rejects provider-code evidence when %s contradicts its source or category",
    (source, providerCode, category) => {
      expect(() =>
        EssentialTurnFailureSchema.parse({
          schemaVersion: 1,
          identity: {
            runId: "run",
            agentId: "agent",
            agentGeneration: 1,
            turnId: "turn",
            operationId: "operation",
            assignmentId: "assignment",
            workspaceId: "workspace",
            workspaceGeneration: 1,
          },
          launchGeneration: "00000000-0000-4000-8000-000000000001",
          providerSessionId: null,
          observedAt: "2026-09-11T10:00:00.000Z",
          category,
          evidence: "provider_code",
          message: "forged",
          source,
          providerCode,
          reset: null,
          diagnosticArtifactIds: [],
          diagnosticOmission: null,
        }),
      ).toThrow("trusted source");
    },
  );
});
