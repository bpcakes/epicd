// Compile-only regressions, checked by npm run typecheck. These functions are never executed.
import type { CodexRuntime } from "../src/adapters/codex.js";
import type { HerdrRuntime } from "../src/adapters/herdr.js";
import type { AgentRuntime, OpenedAgentSession } from "../src/adapters/runtime.js";
import type { SdkAgentSessionContract, HerdrAgentSessionContract } from "../src/domain/types.js";

function runtimeContracts(
  sdk: CodexRuntime,
  herdr: HerdrRuntime,
  sdkContract: SdkAgentSessionContract,
  herdrContract: HerdrAgentSessionContract,
  sdkSession: OpenedAgentSession<"sdk">,
  herdrSession: OpenedAgentSession<"herdr">,
): void {
  const sdkRuntime: AgentRuntime<"sdk"> = sdk;
  const herdrRuntime: AgentRuntime<"herdr"> = herdr;
  const selected: AgentRuntime = herdr;
  void sdkRuntime.open("review", { kind: "new", contract: sdkContract });
  void herdrRuntime.open("review", { kind: "new", contract: herdrContract });
  // @ts-expect-error Selecting a concrete backend must not widen its accepted contracts.
  void selected.open("review", { kind: "new", contract: sdkContract });
  // @ts-expect-error SDK opening rejects a Herdr contract.
  void sdk.open("review", { kind: "new", contract: herdrContract });
  // @ts-expect-error Herdr opening rejects an SDK contract.
  void herdr.open("review", { kind: "new", contract: sdkContract });
  // @ts-expect-error SDK execution rejects a Herdr session.
  void sdk.run(herdrSession, "review");
  // @ts-expect-error Herdr execution rejects an SDK session.
  void herdr.run(sdkSession, "review");
  // @ts-expect-error A pinned contract cannot be replaced after opening.
  sdkSession.contract = sdkContract;
  // @ts-expect-error Pinned effective settings cannot change.
  sdkSession.contract.effective.model = "changed";
  // @ts-expect-error Requested settings are part of the immutable contract too.
  herdrSession.contract.requested.reasoningEffort = "low";
  // @ts-expect-error The contract discriminant cannot change.
  sdkContract.runtime = "sdk";
}

function selectedRuntimeContracts(
  runtime: AgentRuntime,
  sdkContract: SdkAgentSessionContract,
  herdrContract: HerdrAgentSessionContract,
): void {
  // @ts-expect-error A dynamic selection must be narrowed before supplying a backend contract.
  void runtime.open("review", { kind: "new", contract: sdkContract });
  if (runtime.kind === "sdk") {
    const opened: Promise<OpenedAgentSession<"sdk">> = runtime.open("review", {
      kind: "new",
      contract: sdkContract,
    });
    // @ts-expect-error Narrowing to SDK excludes Herdr contracts.
    void runtime.open("review", { kind: "new", contract: herdrContract });
  } else {
    const opened: Promise<OpenedAgentSession<"herdr">> = runtime.open("review", {
      kind: "new",
      contract: herdrContract,
    });
    // @ts-expect-error Narrowing to Herdr excludes SDK contracts.
    void runtime.open("review", { kind: "new", contract: sdkContract });
  }
}
