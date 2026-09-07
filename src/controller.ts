import { digestJson } from "./domain/repository-policy.js";
import {
  AgentSessionContractSchema,
  resolveAgentRoleSettings,
  type AgentRole,
  type RunState,
} from "./domain/types.js";
import type { ControllerAuthority } from "./domain/orchestration.js";
import type { AgentInstance } from "./domain/agents.js";
import { StateStore } from "./adapters/store.js";
import { WorkspaceManager } from "./adapters/workspaces.js";
import { ControlledSdkRuntime } from "./adapters/controlled-sdk.js";
import { ControlledHerdrRuntime } from "./adapters/controlled-herdr.js";
import { KernelBeads } from "./adapters/kernel-beads.js";
import { PublicationGit } from "./adapters/publication-git.js";
import { ActionKernel } from "./kernel/actions.js";
import { registerAgentCapabilities, type ControlledAgentDriver } from "./kernel/agents.js";
import { registerDeliveryCapabilities } from "./kernel/delivery.js";
import {
  registerInspectionCapabilities,
  reconcileRepositoryInspection,
} from "./kernel/inspection.js";
import { registerReviewCapabilities } from "./kernel/reviews.js";
import { registerCommitCapabilities } from "./kernel/commits.js";
import { registerPublicationCapabilities } from "./kernel/publication.js";
import { registerTrackerCapabilities } from "./kernel/tracker.js";
import { registerSettingsCapabilities } from "./kernel/settings.js";
import { registerFixtureCapabilities, reconcileFixtureCreation } from "./kernel/fixtures.js";
import { PostgreSqlFixtureInspector } from "./adapters/fixtures.js";
import { PostgreSqlFixtureCreator } from "./adapters/fixture-creation.js";
import {
  registerDiagnosticWorkspaceCapabilities,
  reconcileDiagnosticWorkspace,
} from "./kernel/diagnostic-workspaces.js";
import { reconcileActions } from "./kernel/reconcile.js";
import { ControlledDecisionSource } from "./orchestrator/sdk-source.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { runStatusView } from "./status.js";
import { redactSensitiveText } from "./util/redact.js";

export function agentContract(state: RunState, role: AgentRole) {
  const settings = resolveAgentRoleSettings(state, role);
  if (!settings.model) throw new Error(`Resolve a concrete ${role} model before starting a run`);
  return AgentSessionContractSchema.parse({
    runtime: state.runtime,
    requested: settings,
    effective: settings,
  });
}

/** Native Herdr never routes through the SDK. Runtime and paths are frozen at creation. */
export function controlledDriver(store: StateStore, state: RunState): ControlledAgentDriver {
  const config = state.runtimeConfiguration;
  if (!config) throw new Error("Run has no runtime configuration; create a fresh configured run");
  const common = {
    root: config.runtimeRoot,
    executable: config.executable,
    authCachePath: config.authCachePath,
    turnTimeoutMs: config.turnTimeoutMs,
  };
  if (state.runtime === "sdk") return new ControlledSdkRuntime(store.orchestration, common);
  if (!config.herdr) throw new Error("Native Herdr endpoint is missing");
  return new ControlledHerdrRuntime(store.orchestration, {
    ...common,
    herdrPath: config.herdr.executable,
    sessionName: config.herdr.sessionName,
    workspaceId: config.herdr.workspaceId,
  });
}

/** Supplies capabilities and stop recovery. The model chooses all delivery transitions. */
export class OrchestratorController {
  private running = false;
  constructor(
    readonly store: StateStore,
    readonly runId: string,
    private readonly options: {
      driver?: (store: StateStore, state: RunState) => ControlledAgentDriver;
      drainTimeoutMs?: number;
    } = {},
  ) {}

  status() {
    return runStatusView(this.store, this.runId);
  }
  pause() {
    const journal = this.store.orchestration;
    return journal.operatorControl(this.runId, journal.control(this.runId).controlVersion, {
      kind: "pause",
    });
  }

  async run(signal?: AbortSignal) {
    if (this.running) throw new Error("This controller is already running");
    this.running = true;
    let authority: ControllerAuthority | null = null;
    let kernel: ActionKernel | null = null;
    try {
      const lease = this.store.acquireLease(this.runId);
      authority = { runId: this.runId, ownerToken: lease.ownerToken, leaseId: lease.leaseId };
      const state = lease.state;
      const journal = this.store.orchestration;
      const config = state.runtimeConfiguration;
      if (!config)
        throw new Error("Run has no runtime configuration; create a fresh configured run");
      const currentRepository = await new PublicationGit().bind(state.repoPath, signal);
      if (digestJson(currentRepository.commonDirectory) !== digestJson(config.commonDirectory))
        throw new Error(
          "Repository metadata identity changed; the recorded run cannot attach to this checkout",
        );
      const driver = (this.options.driver ?? controlledDriver)(this.store, state);
      if (driver.kind !== state.runtime)
        throw new Error("Driver does not match the persisted runtime");
      const workspaces = new WorkspaceManager(journal, config.workspaceRoot);
      kernel = new ActionKernel(journal);
      const contractFor = (role: AgentRole) => agentContract(this.store.get(this.runId)!, role);
      registerAgentCapabilities(kernel, driver, contractFor);
      registerDeliveryCapabilities(kernel, workspaces);
      registerInspectionCapabilities(kernel, workspaces);
      registerReviewCapabilities(kernel, workspaces, driver, () => contractFor("review"));
      registerCommitCapabilities(kernel, workspaces);
      registerPublicationCapabilities(kernel, workspaces);
      const tracker = registerTrackerCapabilities(
        kernel,
        new KernelBeads(config.trackerExecutable),
      );
      registerSettingsCapabilities(kernel, this.store);
      const fixtureCreator = new PostgreSqlFixtureCreator();
      registerFixtureCapabilities(kernel, new PostgreSqlFixtureInspector(), fixtureCreator);
      registerDiagnosticWorkspaceCapabilities(kernel, workspaces, state.repoPath);

      // A replaced controller lease is never evidence that its external work stopped.
      for (const turn of journal.agents.turns(this.runId)) {
        if (turn.stopEvidence) continue;
        try {
          await driver.reconcile(authority, turn.identity);
        } catch (error) {
          journal.appendObservation(authority, {
            source: "controller",
            sourceEventId: `stop-${authority.leaseId}-${turn.identity.turnId}`,
            kind: "recovery.unresolved",
            summary: redactSensitiveText(String(error), 7999),
            identity: turn.identity,
            artifactIds: [],
            wakesOrchestrator: true,
          });
        }
      }
      await reconcileActions(journal, authority, async (action) => {
        if (
          ["refresh_tracker", "request_beads_transition", "complete_run"].includes(
            action.request.action.kind,
          )
        ) {
          const intent = journal.tracker
            .operations(this.runId)
            .find((record) => record.operationId === action.operationId);
          if (!intent)
            return {
              status: "failed",
              detail: "No durable tracker intent exists; no tracker mutation was authorized",
            };
          try {
            const record = await tracker.reconcile(authority!, intent.trackerOperationId, signal);
            if (
              ["observed", "claimed", "closed", "completed"].includes(record.outcome ?? "") ||
              (record.kind === "complete" && record.completion)
            )
              return {
                status: "succeeded",
                result: { kind: "resource", resourceId: record.trackerOperationId, generation: 1 },
              };
            if (record.outcome)
              return { status: "failed", detail: record.failure ?? record.outcome };
            return {
              status: "unresolved",
              detail:
                "Tracker inspection needs current authority and confirmed I/O stop; no mutation was replayed",
            };
          } catch (error) {
            journal.assertAuthority(authority!);
            return {
              status: "unresolved",
              detail: `Tracker recovery remains unsettled: ${String(error)}. No mutation was replayed.`,
            };
          }
        }
        if (action.request.action.kind === "provision_declared_fixture") {
          const creation = journal.fixtures
            .creations(this.runId)
            .find((item) => item.operationId === action.operationId);
          if (!creation)
            return {
              status: "failed",
              detail:
                "No durable creation intent exists, so no CREATE dispatch could be authorized; the old controller is fenced",
            };
          if (creation) {
            try {
              const recovered = await reconcileFixtureCreation(
                journal,
                fixtureCreator,
                authority!,
                creation.creationId,
                signal ?? new AbortController().signal,
              );
              if (recovered.status === "owned")
                return {
                  status: "succeeded",
                  result: {
                    kind: "resource",
                    resourceId: recovered.creationId,
                    generation: recovered.generation,
                  },
                };
              if (recovered.status === "not_created")
                return { status: "failed", detail: recovered.detail! };
            } catch (error) {
              journal.assertAuthority(authority!);
              return {
                status: "unresolved",
                detail: `Fixture reconciliation could not establish the outcome: ${String(error)}. No mutation was replayed.`,
              };
            }
          }
          return {
            status: "unresolved",
            detail:
              "Fixture creation needs confirmed PostgreSQL backend stop and exact resource provenance; no mutation was replayed",
          };
        }
        if (action.request.action.kind === "reconcile_fixture_creation")
          return {
            status: "failed",
            detail:
              "Interrupted read-only fixture reconciliation has no retained action result. Inspect the recorded creation and choose another observation if needed; no provider mutation was replayed.",
          };
        if (action.request.action.kind === "inspect_fixture")
          return {
            status: "failed",
            detail:
              "Interrupted catalog-only inspection has no retained result. Choose a new observation if useful; no fixture mutation was performed or replayed.",
          };
        if (action.request.action.kind === "create_diagnostic_workspace")
          return reconcileDiagnosticWorkspace(journal, workspaces, authority!, action, signal);
        if (action.request.action.kind === "inspect_repo")
          return reconcileRepositoryInspection(action);
        if (
          ["start_agent", "continue_agent", "start_specialist"].includes(action.request.action.kind)
        ) {
          const turn = journal.agents
            .turns(this.runId)
            .find((turn) => turn.identity.operationId === action.operationId);
          if (turn?.stopEvidence)
            return {
              status: "failed",
              detail: `Previous worker turn ${turn.identity.turnId} stopped; inspect its retained result before choosing a follow-up. Its lost action acknowledgement was not replayed.`,
            };
        }
        return {
          status: "unresolved",
          detail: `Action ${action.actionId} remains indeterminate. Inspect its owned resources and use the available reconciliation capability; no effect was repeated.`,
        };
      });
      if (journal.control(this.runId).status === "active" && !signal?.aborted) {
        let coordinator = await this.coordinator(authority, state, workspaces, signal);
        let source = new ControlledDecisionSource(journal, authority, coordinator, driver);
        const currentAuthority = authority;
        await new OrchestratorLoop(
          kernel,
          {
            decide: (input, turnSignal) => source.decide(input, turnSignal),
            reconcile: (attempt) => source.reconcile(attempt),
          },
          {
            beforeDecision: async (turnSignal) => {
              const next = await this.coordinator(
                currentAuthority,
                this.store.get(this.runId)!,
                workspaces,
                turnSignal,
              );
              if (
                next.agentId !== coordinator.agentId ||
                next.agentGeneration !== coordinator.agentGeneration
              ) {
                coordinator = next;
                source = new ControlledDecisionSource(
                  journal,
                  currentAuthority,
                  coordinator,
                  driver,
                );
              }
            },
          },
        ).run(authority, signal);
      }
    } catch (error) {
      if (authority && !signal?.aborted) {
        const journal = this.store.orchestration;
        journal.assertAuthority(authority);
        if (journal.control(this.runId).status === "active")
          journal.setEscalation(
            authority,
            redactSensitiveText(`Controller could not continue: ${String(error)}`, 7999),
            "controller_unavailable",
            [],
          );
      }
      if (!signal?.aborted) throw error;
    } finally {
      try {
        if (kernel) {
          kernel.interruptAll();
          const drained = await kernel.drain(this.options.drainTimeoutMs);
          if (authority) {
            const journal = this.store.orchestration;
            journal.assertAuthority(authority);
            if (!drained) {
              journal.markInterruptedActions(authority);
              if (journal.control(this.runId).status === "active")
                journal.setEscalation(
                  authority,
                  "Shutdown could not confirm all operations stopped. Reconcile their recorded identities before retrying effects.",
                  "shutdown_indeterminate",
                  [],
                );
            } else if (signal?.aborted && journal.control(this.runId).status === "active") {
              journal.changeStatus(authority, "paused");
            }
          }
        }
      } finally {
        if (authority) this.store.releaseLease(this.runId, authority.ownerToken);
        this.running = false;
      }
    }
    return this.status();
  }

  private async coordinator(
    authority: ControllerAuthority,
    state: RunState,
    workspaces: WorkspaceManager,
    signal?: AbortSignal,
  ): Promise<AgentInstance> {
    const journal = this.store.orchestration;
    const contract = agentContract(state, "orchestrator");
    const prior = journal.agents
      .instances(this.runId)
      .filter((agent) => agent.role === "orchestrator");
    const live = prior.filter((agent) => !["revoked", "released"].includes(agent.status));
    if (live.length > 1) throw new Error("Multiple coordinator assignments require reconciliation");
    const existing = live[0];
    if (existing) {
      if (existing.activeTurnId) throw new Error("The previous coordinator has no confirmed stop");
      if (digestJson(existing.contract) === digestJson(contract)) return existing;
      journal.agents.revokeAgent(authority, existing, "Future-thread coordinator settings changed");
      journal.agents.releaseAgent(authority, existing);
    }
    const operation = `coordinator-${digestJson([this.runId, prior.length, contract]).slice(0, 40)}`;
    let workspace = journal.agents.workspaceForOperation(this.runId, operation);
    if (workspace) {
      if ((await workspaces.inspectMaterialization(authority, workspace, signal)) !== "ready")
        throw new Error(
          "The reserved coordinator workspace is incomplete; it was preserved for inspection",
        );
      workspace = journal.agents.workspace(this.runId, workspace);
    } else {
      workspace = await workspaces.create(
        authority,
        state.repoPath,
        state.epicBaseRevision,
        "coordinator",
        signal,
        operation,
      );
    }
    return journal.agents.reserveAgent(
      authority,
      {
        role: "orchestrator",
        purpose: "coordination",
        taskId: null,
        candidateId: null,
        workspaceId: workspace.workspaceId,
        workspaceGeneration: workspace.workspaceGeneration,
        instructions:
          "Deliver the selected epic through the available kernel capabilities. Choose the strategy, investigate failures, preserve useful memory and demand independent exact-revision evidence. Escalate for missing authority, judgment, or unavailable capabilities.",
        contract,
        confinementProfile: "epicd-isolated",
      },
      journal.control(this.runId).controlVersion,
    );
  }
}
