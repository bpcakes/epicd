import type { OrchestrationJournal } from "./orchestration-journal.js";
import { ControlledHerdrRuntime } from "./controlled-herdr.js";
import { ControlledSdkRuntime } from "./controlled-sdk.js";
import { AgentCoordinationError } from "./agent-journal.js";
import type { AgentIdentity, AgentInstance, TurnRecord } from "../domain/agents.js";
import type { AgentExecution } from "../domain/agent-execution.js";
import type { AgentSessionContract, BackendKind, RuntimeKind } from "../domain/types.js";
import type { ControllerAuthority, TurnIdentity } from "../domain/orchestration.js";
import type { ControlledAgentDriver } from "../kernel/agents.js";

export type ControlledAgentDriverFactory = (
  journal: OrchestrationJournal,
  execution: AgentExecution,
  agent: AgentInstance,
) => ControlledAgentDriver;

export type ControlledAgentDispatcherOptions = Partial<
  Record<`${BackendKind}:${RuntimeKind}`, ControlledAgentDriverFactory>
>;

export type ControlledAgentReadinessCheck = (contract: AgentSessionContract) => void;
export type ControlledAgentDispatcherReadiness = Partial<
  Record<`${BackendKind}:${RuntimeKind}`, ControlledAgentReadinessCheck>
>;

export class AgentDispatchUnavailable extends Error {
  constructor(
    readonly code: "agent_runtime_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AgentDispatchUnavailable";
  }
}

function defaultOptions(): ControlledAgentDispatcherOptions {
  return {
    "codex:sdk": (journal, execution) =>
      new ControlledSdkRuntime(journal, {
        root: execution.runtimeRoot,
        executable: execution.executable,
        turnTimeoutMs: execution.turnTimeoutMs,
      }),
    "codex:herdr": (journal, execution) => {
      if (!execution.herdr)
        throw new Error("The recorded native execution binding is missing its Herdr endpoint");
      return new ControlledHerdrRuntime(journal, {
        root: execution.runtimeRoot,
        executable: execution.executable,
        turnTimeoutMs: execution.turnTimeoutMs,
        herdrPath: execution.herdr.executable,
        sessionName: execution.herdr.sessionName,
        workspaceId: execution.herdr.workspaceId,
      });
    },
  };
}

/**
 * Routes by the exact persisted agent generation.  It deliberately creates a
 * driver for each operation so a controller restart cannot reuse a role-wide
 * or run-wide runtime object.
 */
export class ControlledAgentDispatcher {
  private readonly factories: ControlledAgentDispatcherOptions;
  private readonly readiness: ControlledAgentDispatcherReadiness;

  constructor(
    private readonly journal: OrchestrationJournal,
    factories: ControlledAgentDispatcherOptions = {},
    readiness: ControlledAgentDispatcherReadiness = {},
  ) {
    this.factories = { ...defaultOptions(), ...factories };
    this.readiness = {
      // An injected driver owns its own launch prerequisites. Production Herdr
      // uses the default driver and requires the controller's managed shell.
      ...(factories["codex:herdr"]
        ? {}
        : {
            "codex:herdr": () => {
              if (process.env.HERDR_ENV !== "1")
                throw new AgentDispatchUnavailable(
                  "agent_runtime_unavailable",
                  "Controlled Herdr requires HERDR_ENV=1",
                );
            },
          }),
      ...readiness,
    };
  }

  assertSupported(contract: AgentSessionContract): void {
    if (contract.backend !== "codex")
      throw new Error(`Unsupported agent backend: ${String(contract.backend)}`);
    if (!this.factories[`${contract.backend}:${contract.runtime}`])
      throw new Error(
        `No controlled adapter is available for ${contract.backend}/${contract.runtime}`,
      );
  }

  /** New-dispatch preflight only. Recovery must remain available without current launch prerequisites. */
  assertReady(contract: AgentSessionContract): void {
    this.assertSupported(contract);
    const check = this.readiness[`${contract.backend}:${contract.runtime}`];
    if (!check) return;
    try {
      check(contract);
    } catch (error) {
      if (error instanceof AgentDispatchUnavailable) throw error;
      throw new AgentDispatchUnavailable(
        "agent_runtime_unavailable",
        error instanceof Error ? error.message : "The selected agent runtime is unavailable",
      );
    }
  }

  run(
    authority: ControllerAuthority,
    identity: TurnIdentity,
    signal?: AbortSignal,
  ): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const turn = this.journal.agents.turn(authority.runId, identity);
    const agent = this.journal.agents.instance(authority.runId, identity);
    this.assertSupported(agent.contract);
    if (turn.stopEvidence) throw new Error("A settled agent turn cannot be dispatched again");
    return this.driver(agent).run(authority, turn.identity, signal);
  }

  reconcile(authority: ControllerAuthority, identity: TurnIdentity): Promise<TurnRecord> {
    this.journal.assertAuthority(authority);
    const recovered = this.journal.agents.turnForRecovery(authority.runId, identity);
    if (!recovered.turn)
      throw new AgentCoordinationError(
        "agent_integrity_uncontained",
        `Turn ${identity.turnId} cannot be reconciled because its persisted identity, owner, or stop evidence is unreadable`,
      );
    const turn = recovered.turn;
    if (turn.stopEvidence) return Promise.resolve(turn);
    if (turn.status === "prepared") {
      const cancelled =
        recovered.ownerValidity === "readable"
          ? this.journal.agents.cancelPreparedTurn(authority, identity)
          : this.journal.agents.cancelPreparedTurnWithoutOwner(authority, identity);
      return Promise.resolve(cancelled);
    }
    if (recovered.ownerValidity !== "readable")
      throw new AgentCoordinationError(
        "agent_integrity_uncontained",
        `Turn ${identity.turnId} has no readable owner and its submitted work has no intrinsic stop proof`,
      );
    if (!turn.launch)
      return Promise.resolve(
        this.journal.agents.markIndeterminate(
          authority,
          identity,
          "Submitted turn has no durable launch identity; preserve its workspace",
        ),
      );
    const agent = this.journal.agents.instance(authority.runId, identity);
    this.assertSupported(agent.contract);
    this.journal.agents.validateLaunchBinding(authority.runId, turn.identity);
    return this.driver(agent).reconcile(authority, turn.identity);
  }

  private driver(agent: AgentInstance): ControlledAgentDriver {
    this.assertSupported(agent.contract);
    const factory = this.factories[`${agent.contract.backend}:${agent.contract.runtime}`];
    if (!factory) throw new Error("No controlled adapter is available for the persisted agent");
    const driver = factory(this.journal, agent.execution, agent);
    if (driver.backend !== agent.contract.backend || driver.kind !== agent.contract.runtime)
      throw new Error("Controlled adapter identity does not match the persisted agent contract");
    return driver;
  }
}

export type AgentDispatcher = Pick<
  ControlledAgentDispatcher,
  "assertSupported" | "assertReady" | "run" | "reconcile"
>;

export type { AgentIdentity };
