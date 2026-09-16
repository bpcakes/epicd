import { digestJson } from "./domain/repository-policy.js";
import {
  AgentSessionContractSchema,
  resolveAgentRoleSettings,
  type AgentRole,
  type RunState,
} from "./domain/types.js";
import type { ControllerAuthority } from "./domain/orchestration.js";
import type { AgentInstance, WorkspaceRecord } from "./domain/agents.js";
import { StateStore } from "./adapters/store.js";
import { WorkspaceManager } from "./adapters/workspaces.js";
import { KernelBeads } from "./adapters/kernel-beads.js";
import { PublicationGit } from "./adapters/publication-git.js";
import { ActionKernel } from "./kernel/actions.js";
import { registerAgentCapabilities } from "./kernel/agents.js";
import { ControlledAgentDispatcher, type AgentDispatcher } from "./adapters/agent-dispatch.js";
import { registerDeliveryCapabilities } from "./kernel/delivery.js";
import { registerWorkspaceDisposalCapabilities } from "./kernel/workspace-disposal.js";
import {
  registerInspectionCapabilities,
  reconcileRepositoryInspection,
} from "./kernel/inspection.js";
import { registerReviewCapabilities } from "./kernel/reviews.js";
import { registerCommitCapabilities } from "./kernel/commits.js";
import { reconcileTrackerCommit } from "./kernel/tracker-commits.js";
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
import {
  registerDeliveryRecoveryCapabilities,
  reconcileDeliveryAction,
} from "./kernel/delivery-recovery.js";
import { ControlledDecisionSource } from "./orchestrator/sdk-source.js";
import { OrchestratorLoop } from "./orchestrator/loop.js";
import { coordinatorConversationPressure } from "./orchestrator/conversation.js";
import { runStatusView } from "./status.js";
import { redactSensitiveText } from "./util/redact.js";
import { RepositoryAdmission } from "./kernel/repository-admission.js";
import type { runRepositoryIO } from "./adapters/repository-io.js";

export function agentContract(state: RunState, role: AgentRole) {
  const settings = resolveAgentRoleSettings(state, role);
  if (!settings.model) throw new Error(`Resolve a concrete ${role} model before starting a run`);
  return AgentSessionContractSchema.parse({
    backend: "codex",
    runtime: state.runtime,
    requested: settings,
    effective: settings,
  });
}

/** Production dispatch always resolves the persisted generation binding. */
export function controlledDispatcher(store: StateStore): ControlledAgentDispatcher {
  return new ControlledAgentDispatcher(store.orchestration);
}

/** Supplies capabilities and stop recovery. The model chooses all delivery transitions. */
export class OrchestratorController {
  private running = false;
  constructor(
    readonly store: StateStore,
    readonly runId: string,
    private readonly options: {
      dispatcher?: (store: StateStore, state: RunState) => AgentDispatcher;
      drainTimeoutMs?: number;
      repositoryIO?: typeof runRepositoryIO;
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
    let repositoryAdmission: RepositoryAdmission | null = null;
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
      repositoryAdmission = new RepositoryAdmission(
        this.store,
        authority,
        currentRepository,
        undefined,
        this.options.repositoryIO,
      );
      await repositoryAdmission.enter(signal);
      if (journal.control(this.runId).status === "complete") return this.status();
      const admission = repositoryAdmission;
      const dispatcher = this.options.dispatcher
        ? this.options.dispatcher(this.store, state)
        : controlledDispatcher(this.store);
      const workspaces = new WorkspaceManager(journal, config.workspaceRoot);
      kernel = new ActionKernel(journal, (dispatchSignal) => admission.assertOwned(dispatchSignal));
      const contractFor = (role: AgentRole) => agentContract(this.store.get(this.runId)!, role);
      registerAgentCapabilities(kernel, dispatcher, contractFor);
      registerDeliveryCapabilities(kernel, workspaces);
      registerWorkspaceDisposalCapabilities(kernel, workspaces);
      registerInspectionCapabilities(kernel, workspaces);
      registerReviewCapabilities(kernel, workspaces, dispatcher, () => contractFor("review"));
      registerCommitCapabilities(kernel, workspaces);
      registerDeliveryRecoveryCapabilities(kernel, workspaces, dispatcher);
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
      for (const recovered of journal.agents.turnsForRecovery(this.runId)) {
        if (!recovered.turn) {
          journal.appendObservation(authority, {
            source: "controller",
            sourceEventId: `stop-${authority.leaseId}-${recovered.identity?.turnId ?? `row-${recovered.rowId}`}`,
            kind: "recovery.unresolved",
            summary: redactSensitiveText(
              `Turn recovery validation failed: ${String(recovered.failure ?? "unknown persisted turn error")}`,
              7999,
            ),
            identity: recovered.identity,
            artifactIds: [],
            wakesOrchestrator: true,
          });
          continue;
        }
        const turn = recovered.turn;
        if (turn.stopEvidence) continue;
        try {
          if (turn.status === "prepared") {
            if (recovered.ownerValidity === "readable")
              journal.agents.cancelPreparedTurn(authority, turn.identity);
            else journal.agents.cancelPreparedTurnWithoutOwner(authority, turn.identity);
          } else if (recovered.ownerValidity === "not_required")
            journal.agents.settleStoppedTurnWithoutOwner(authority, turn.identity);
          else await dispatcher.reconcile(authority, turn.identity);
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
      journal.agents.supersedeQueuedMessagesForIsolatedOwners(authority);
      // Reads own durable exclusions even when no parent action/agent was reserved.
      // Drain them before parent recovery or settings can select a different workspace.
      for (const inspection of journal.workspaceInspections.unsettled(this.runId)) {
        try {
          await workspaces.reconcileInspection(authority, inspection.inspectionId);
        } catch (error) {
          journal.assertAuthority(authority);
          journal.appendObservation(authority, {
            source: "controller",
            sourceEventId: `inspection-${authority.leaseId}-${inspection.inspectionId}`,
            kind: "recovery.unresolved",
            summary: redactSensitiveText(
              `Inspection ${inspection.inspectionId}: ${String(error)}`,
              7999,
            ),
            identity: null,
            artifactIds: [],
            wakesOrchestrator: true,
          });
        }
      }
      await reconcileActions(journal, authority, async (action) => {
        const delivery = await reconcileDeliveryAction(
          journal,
          workspaces,
          dispatcher,
          authority!,
          action,
          signal,
        );
        if (delivery) return delivery;
        if (action.request.action.kind === "reconcile_tracker_commit")
          return {
            status: "failed",
            detail:
              "Interrupted read-only tracker-commit inspection has no retained action result. Inspect the original commitment and choose another reconciliation if useful; no Git write was replayed and no workspace stop was inferred.",
          };
        if (action.request.action.kind === "request_tracker_commit") {
          const intent = journal.trackerCommits
            .records(this.runId)
            .find((entry) => entry.operationId === action.operationId);
          if (!intent)
            return {
              status: "failed",
              detail: "No tracker commit intent exists; no write was admitted",
            };
          try {
            const record = await reconcileTrackerCommit(
              journal,
              workspaces,
              authority!,
              intent.trackerCommitId,
            );
            return record.status === "created" && record.sourceIntact
              ? {
                  status: "succeeded",
                  result: { kind: "resource", resourceId: record.trackerCommitId, generation: 1 },
                }
              : { status: "failed", detail: record.failure ?? "Tracker commit was not retained" };
          } catch (error) {
            journal.assertAuthority(authority!);
            return {
              status: "unresolved",
              detail: `Tracker commit recovery: ${String(error)}; no write was replayed`,
            };
          }
        }
        if (
          [
            "refresh_tracker",
            "export_tracker",
            "request_beads_transition",
            "complete_run",
          ].includes(action.request.action.kind)
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
              ["observed", "exported", "claimed", "closed", "completed"].includes(
                record.outcome ?? "",
              ) ||
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
            .operationalTurns(this.runId)
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
      // Reconciliation above can change containment. This final assessment owns
      // both the incident report and admission; never reuse a pre-recovery view.
      journal.agents.supersedeQueuedMessagesForIsolatedOwners(authority);
      const agentIntegrity = journal.agents.recoveryIntegrity(this.runId);
      for (const incident of agentIntegrity) {
        const observation = {
          source: "controller" as const,
          kind:
            incident.state === "isolated"
              ? "recovery.owner_isolated"
              : "recovery.owner_uncontained",
          summary:
            incident.state === "isolated"
              ? `Unreadable agent ${incident.identity.agentId}/${incident.identity.agentGeneration} lost authority; ${incident.affectedTurnIds.length} stopped historical turn(s) remain preserved and ineligible, with ${incident.affectedMessageIds.length} mailbox record(s) retained.`
              : `${incident.ownerRecordReadable ? "Agent" : "Unreadable agent"} ${incident.identity.agentId}/${incident.identity.agentGeneration} has ${incident.affectedTurnIds.length} associated turn(s), including persisted work whose integrity or stop cannot be proved automatically; ${incident.affectedMessageIds.length} mailbox record(s) remain preserved.`,
          identity: null,
          artifactIds: [] as string[],
          wakesOrchestrator: incident.state !== "isolated",
        };
        journal.appendObservation(authority, {
          ...observation,
          sourceEventId: `agent-integrity-${incident.rowId}-${digestJson([incident.recordDigest, observation])}`,
        });
      }
      const uncontainedOwners = agentIntegrity.filter(
        (incident) => incident.state === "uncontained",
      );
      if (uncontainedOwners.length > 0)
        throw new Error(
          `Automatic recovery could not prove persisted integrity and stop for ${uncontainedOwners.length} unreadable agent owner(s) or readable owner(s) with damaged turn history. Preserve their workspaces and inspect recovery.owner_uncontained observations before intervention.`,
        );
      if (journal.control(this.runId).status === "active" && !signal?.aborted) {
        // Launch readiness is a new-work precondition. Keep all cold recovery
        // above this boundary available when the current runtime cannot launch.
        dispatcher.assertReady(agentContract(state, "orchestrator"));
        let coordinator = await this.coordinator(authority, state, workspaces, admission, signal);
        let source = new ControlledDecisionSource(journal, authority, coordinator, dispatcher);
        const currentAuthority = authority;
        await new OrchestratorLoop(
          kernel,
          {
            decide: (input, turnSignal) => source.decide(input, turnSignal),
            reconcile: (attempt) => source.reconcile(attempt),
          },
          {
            healthIntervalMs: 2000,
            onHealthCheck: (healthSignal) => admission.assertOwned(healthSignal),
            beforeSourceDispatch: async (turnSignal) => {
              await admission.assertOwned(turnSignal);
              dispatcher.assertReady(coordinator.contract);
            },
            beforeDecision: async (turnSignal) => {
              await admission.assertOwned(turnSignal);
              const currentState = this.store.get(this.runId)!;
              dispatcher.assertReady(agentContract(currentState, "orchestrator"));
              const next = await this.coordinator(
                currentAuthority,
                currentState,
                workspaces,
                admission,
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
                  dispatcher,
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
        try {
          if (
            authority &&
            repositoryAdmission &&
            !signal?.aborted &&
            this.store.orchestration.control(this.runId).status === "complete"
          )
            await repositoryAdmission.release(signal);
        } finally {
          if (authority) this.store.releaseLease(this.runId, authority.ownerToken);
          this.running = false;
        }
      }
    }
    return this.status();
  }

  private async coordinator(
    authority: ControllerAuthority,
    state: RunState,
    workspaces: WorkspaceManager,
    admission: RepositoryAdmission,
    signal?: AbortSignal,
  ): Promise<AgentInstance> {
    const journal = this.store.orchestration;
    const contract = agentContract(state, "orchestrator");
    const prior = journal.agents
      .operationalInstances(this.runId)
      .filter((agent) => agent.role === "orchestrator");
    const live = prior.filter((agent) => !["revoked", "released"].includes(agent.status));
    if (live.length > 1) throw new Error("Multiple coordinator assignments require reconciliation");
    const existing = live[0];
    if (existing) {
      if (existing.activeTurnId) throw new Error("The previous coordinator has no confirmed stop");
      // Startup may precede replay of a stopped turn's recorded result or a
      // transport retry. Do not invalidate its frozen ticket by retiring here.
      const pending = journal.pendingDecision(this.runId);
      const control = journal.control(this.runId);
      if (
        journal.decisionSource.unsettled(this.runId) ||
        (pending &&
          pending.expectedControlVersion === control.controlVersion &&
          pending.policyDigest === control.policyDigest &&
          journal.decisionSource.execution(this.runId, pending.decisionId))
      )
        return existing;
      const pressure = coordinatorConversationPressure(
        existing,
        journal.agents.operationalTurns(this.runId),
        journal.agents.conversationLineageIdentities(this.runId, existing),
      );
      const settingsChanged = digestJson(existing.contract) !== digestJson(contract);
      if (!settingsChanged && pressure.reasons.length === 0) return existing;
      journal.agents.retireStoppedAgent(
        authority,
        existing,
        `${settingsChanged ? "Future-thread settings changed" : "Bounded context rollover"}; ${JSON.stringify(pressure)}`,
      );
    }
    const transfer = journal.agents.pendingCoordinatorConversationTransfer(
      this.runId,
      contract.runtime,
    );
    if (transfer) {
      const source = prior
        .filter(
          (agent) =>
            agent.agentId === transfer.sourceAgentId &&
            (agent.agentGeneration === transfer.sourceAgentGeneration ||
              (agent.provider === null &&
                agent.conversationContinuation?.transferId === transfer.transferId)),
        )
        .sort((left, right) => right.agentGeneration - left.agentGeneration)[0];
      if (!source)
        throw new Error("The pending coordinator conversation has no readable source lineage");
      const workspace = journal.agents.workspace(this.runId, {
        workspaceId: transfer.workspaceId,
        workspaceGeneration: transfer.workspaceGeneration,
      });
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
            "Continue delivery after the operator's explicit runtime handoff. Preserve the prior conversation's useful context, but re-check current journal authority and evidence before acting.",
          contract,
          confinementProfile: "epicd-isolated",
          replaces: source,
          conversationTransferId: transfer.transferId,
        },
        journal.control(this.runId).controlVersion,
      );
    }
    const operation = `coordinator-${digestJson([this.runId, journal.agents.coordinatorGenerationCount(this.runId), contract]).slice(0, 40)}`;
    const workspace = await this.coordinatorWorkspace(
      authority,
      state,
      workspaces,
      admission,
      operation,
      signal,
    );
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

  /** Bootstrap availability, not delivery strategy. Never replay or remove a failed copy. */
  private async coordinatorWorkspace(
    authority: ControllerAuthority,
    state: RunState,
    workspaces: WorkspaceManager,
    admission: RepositoryAdmission,
    operation: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceRecord> {
    const journal = this.store.orchestration;
    const limit = journal.policy(this.runId).budgets.identicalFailures;
    const active = () => {
      journal.assertAuthority(authority);
      signal?.throwIfAborted();
      if (journal.control(this.runId).status !== "active")
        throw new Error("Coordinator workspace bootstrap is no longer active");
    };
    for (let attempt = 0; attempt < limit; attempt++) {
      active();
      await admission.assertOwned(signal);
      active();
      // Stable IDs retain the attempt budget across restart for this slot/contract.
      const attemptId = attempt === 0 ? operation : `${operation}-attempt-${attempt + 1}`;
      let workspace = journal.agents.workspaceForOperation(this.runId, attemptId);
      let fresh = false;
      if (!workspace) {
        try {
          workspace = await workspaces.create(
            authority,
            state.repoPath,
            state.epicBaseRevision,
            "coordinator",
            signal,
            attemptId,
          );
          fresh = true;
        } catch (error) {
          active();
          workspace = journal.agents.workspaceForOperation(this.runId, attemptId);
          if (!workspace) throw error; // No recorded intent: do not invent a retryable outcome.
          journal.appendObservation(authority, {
            source: "controller",
            sourceEventId: `${attemptId}-interrupted`,
            kind: "controller.coordinator_copy_interrupted",
            summary: redactSensitiveText(String(error), 7999),
            identity: null,
            artifactIds: [],
            wakesOrchestrator: true,
          });
        }
      }
      // This adapter proves the original complete-worker stop or unused binding fence.
      // An unknown stop throws; it never opens the next attempt.
      const creation = await workspaces.reconcileCreation(authority, workspace);
      active();
      workspace = journal.agents.workspace(this.runId, workspace);
      if (
        !creation ||
        creation.creationOperationId !== attemptId ||
        creation.actionId !== null ||
        creation.purpose !== "coordinator" ||
        creation.revision !== state.epicBaseRevision ||
        creation.source.kind !== "repository" ||
        creation.source.path !== state.repoPath ||
        workspace.purpose !== "coordinator" ||
        workspace.sourceMode !== "immutable" ||
        workspace.baselineRevision !== state.epicBaseRevision
      )
        throw new Error("Coordinator copy differs from its frozen bootstrap source; preserve it");
      if (creation.outcome === "failed") {
        if (
          workspace.activeTurnId ||
          journal.agents.activeWorkspaceOperation(this.runId, workspace)
        )
          throw new Error("Failed coordinator copy still has unsettled custody; preserve it");
        journal.appendObservation(authority, {
          source: "controller",
          sourceEventId: `coordinator-copy-failed-${creation.creationId}`,
          kind: "controller.coordinator_copy_failed",
          summary: redactSensitiveText(
            `Failed coordinator copy ${workspace.workspaceId} is preserved, not reused. ${creation.detail ?? "No retained creation result"}`,
            7999,
          ),
          identity: null,
          artifactIds: [],
          wakesOrchestrator: true,
        });
        continue;
      }
      if (creation.outcome !== "created")
        throw new Error("Coordinator copy has no settled creation outcome; preserve it");
      if (
        !fresh &&
        (await workspaces.inspectMaterialization(authority, workspace, signal)) !== "ready"
      )
        throw new Error(
          "The reserved coordinator workspace is incomplete; it was preserved for inspection",
        );
      active();
      return journal.agents.workspace(this.runId, workspace);
    }
    throw new Error(
      `Coordinator workspace attempt budget exhausted (${limit}); failed copies and their original records were preserved`,
    );
  }
}
