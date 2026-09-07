import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { EpicEngine } from "../engine/engine.js";
import {
  AgentPreferencesSchema,
  AGENT_ROLES,
  resolveAgentRoleSettings,
  type AgentPreferences,
  type AgentRole,
  type AgentRolePreferences,
  type AgentRoleSettings,
  type EngineEvent,
  type RunPhase,
  type RunState,
} from "../domain/types.js";
import {
  clock,
  eventColors,
  eventSymbols,
  phaseColors,
  phaseLabels,
  progressBar,
  shortId,
} from "../ui/format.js";
import {
  cycleAgentReasoningEffort,
  normalizeAgentModelInput,
  updateAgentPreference,
} from "./agent-config.js";
import {
  canRequestPause,
  ControllerOperationGate,
  performControllerCommand,
  shouldExitAfterController,
} from "../controller.js";

const pipeline: Array<{ phases: RunPhase[]; label: string }> = [
  { phases: ["selecting", "preparing"], label: "SELECT" },
  { phases: ["claiming"], label: "CLAIM" },
  { phases: ["implementing", "fixing"], label: "BUILD" },
  { phases: ["reviewing"], label: "REVIEW" },
  { phases: ["committing"], label: "COMMIT" },
  { phases: ["verifying", "final_review"], label: "VERIFY" },
  { phases: ["closing", "complete"], label: "CLOSE" },
];

const roleLabels = {
  orchestrator: "Coordinator",
  implementation: "Implementer",
  review: "Reviewer",
} satisfies Record<AgentRole, string>;
const configurableRoles = AGENT_ROLES.map((role) => ({ role, label: roleLabels[role] }));
function effectiveFutureSettings(state: RunState, role: AgentRole): AgentRoleSettings {
  return resolveAgentRoleSettings(state, role);
}

function displayedSettings(state: RunState, role: AgentRole): AgentRoleSettings {
  const session = state.agentSessions[role];
  if (session.status === "inactive") return effectiveFutureSettings(state, role);
  return session.contract.effective;
}

export function AgentConfig({
  initialSettings,
  agentSessions,
  fallbackModel,
  fallbackReasoningEffort,
  onApply,
  onCancel,
  onInterrupt,
  onPause,
  onQuit,
  error,
}: {
  initialSettings: AgentPreferences;
  agentSessions: RunState["agentSessions"];
  fallbackModel: string | null;
  fallbackReasoningEffort: RunState["reasoningEffort"];
  onApply: (settings: AgentPreferences) => void;
  onCancel: () => void;
  onInterrupt: () => void;
  onPause: () => void;
  onQuit: () => void;
  error: string | null;
}) {
  const [draft, setDraft] = useState<AgentPreferences>(() =>
    AgentPreferencesSchema.parse(initialSettings),
  );
  const [selected, setSelected] = useState(0);
  const [modelInput, setModelInput] = useState<string | null>(null);
  const selectedRole = configurableRoles[selected]?.role ?? "orchestrator";
  const initialSettingsKey = JSON.stringify(initialSettings);

  useEffect(() => {
    setDraft(AgentPreferencesSchema.parse(initialSettings));
    setModelInput(null);
  }, [initialSettingsKey]);

  const updateSelected = (update: Partial<AgentRolePreferences>) => {
    setDraft((current) => updateAgentPreference(current, selectedRole, update));
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onInterrupt();
      return;
    }
    if (modelInput !== null) {
      if (key.escape) setModelInput(null);
      else if (key.return) {
        updateSelected({ model: normalizeAgentModelInput(modelInput) });
        setModelInput(null);
      } else if (key.backspace || key.delete)
        setModelInput((current) => current?.slice(0, -1) ?? "");
      else if (input && !key.ctrl && !key.meta && !key.super)
        setModelInput((current) => `${current ?? ""}${input}`);
      return;
    }

    if (input === "p") onPause();
    else if (input === "q") onQuit();
    else if (key.escape || input === "c") onCancel();
    else if (key.upArrow || input === "k")
      setSelected((current) => (current + configurableRoles.length - 1) % configurableRoles.length);
    else if (key.downArrow || input === "j")
      setSelected((current) => (current + 1) % configurableRoles.length);
    else if (key.leftArrow || key.rightArrow) {
      setDraft((current) =>
        cycleAgentReasoningEffort(
          current,
          selectedRole,
          fallbackModel,
          fallbackReasoningEffort,
          key.leftArrow ? -1 : 1,
        ),
      );
    } else if (input === "m") setModelInput(draft[selectedRole].model ?? "");
    else if (input === "x") updateSelected({ model: null });
    else if (input === "r") updateSelected({ reasoningEffort: null });
    else if (key.return || input === "s") onApply(draft);
  });

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
      <Text bold color="cyan">
        AGENT CONFIGURATION
      </Text>
      <Text dimColor>Changes apply to new threads only. Existing threads stay pinned.</Text>
      <Box marginTop={1} flexDirection="column">
        {configurableRoles.map(({ role, label }, index) => {
          const next = draft[role];
          const session = agentSessions[role];
          const nextModel = next.model ?? fallbackModel ?? "default";
          const nextReasoning = resolveAgentRoleSettings(
            {
              agentSettings: draft,
              model: fallbackModel,
              reasoningEffort: fallbackReasoningEffort,
            },
            role,
          ).reasoningEffort;
          return (
            <Box key={role} flexDirection="column" marginBottom={1}>
              <Text
                {...(index === selected ? { color: "cyan" as const } : {})}
                bold={index === selected}
              >
                {index === selected ? "› " : "  "}
                {label}
              </Text>
              <Text>
                <Text dimColor> next </Text>
                {role === selectedRole && modelInput !== null ? `${modelInput}▌` : nextModel}
                {` · ${nextReasoning}`}
              </Text>
              {session.status === "active" ? (
                <Text
                  dimColor
                >{`    active ${session.contract.effective.model ?? "default"} · ${session.contract.effective.reasoningEffort}`}</Text>
              ) : (
                <Text dimColor> active —</Text>
              )}
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        ↑/↓ role · ←/→ effort · r inherit effort · m edit model · x default model · s/Enter save · p
        pause · q quit
      </Text>
      {modelInput !== null ? (
        <Text color="yellow">Editing model: Enter accepts · Esc cancels</Text>
      ) : null}
      {error ? <Text color="red">Could not save: {error}</Text> : null}
    </Box>
  );
}

function StageLine({ phase }: { phase: RunPhase }) {
  return (
    <Box>
      {pipeline.map((stage, index) => {
        const active = stage.phases.includes(phase);
        return (
          <Box key={stage.label}>
            {index > 0 ? <Text dimColor> ─ </Text> : null}
            <Text bold={active} color={active ? phaseColors[phase] : "gray"} inverse={active}>
              {` ${stage.label} `}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function Activity({
  events,
  showDetail,
  rows,
}: {
  events: EngineEvent[];
  showDetail: boolean;
  rows: number;
}) {
  const visible = events.slice(-rows);
  return (
    <Box flexDirection="column">
      {visible.length === 0 ? <Text dimColor>Waiting for the first event…</Text> : null}
      {visible.map((event) => (
        <Box key={event.id ?? `${event.at}-${event.kind}`} flexDirection="column">
          <Box>
            <Text dimColor>{clock(event.at)} </Text>
            <Text color={eventColors[event.level]}>{eventSymbols[event.level]} </Text>
            {event.level === "error" ? (
              <Text color="red">{event.message}</Text>
            ) : (
              <Text>{event.message}</Text>
            )}
          </Box>
          {showDetail && event.detail ? (
            <Box marginLeft={11}>
              <Text dimColor wrap="truncate-end">
                {event.detail.replaceAll("\n", "  ")}
              </Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function RunView({ engine }: { engine: EpicEngine }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<RunState>(() => engine.snapshot());
  const [events, setEvents] = useState<EngineEvent[]>(() => engine.recentEvents(100));
  const [showDetail, setShowDetail] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [controllerError, setControllerError] = useState<string | null>(null);
  const [controllerBusy, setControllerBusy] = useState(false);
  const [pauseThenExit, setPauseThenExit] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const controllerGate = useRef(new ControllerOperationGate());
  const columns = stdout.columns ?? 100;
  const compact = columns < 84;
  const activityRows = compact ? 7 : 11;
  const settleController = useCallback(
    (operation: () => Promise<RunState>) =>
      controllerGate.current.start(
        operation,
        (next) => setState({ ...next }),
        setControllerError,
        setControllerBusy,
      ),
    [],
  );
  const requestControllerPause = () =>
    performControllerCommand(() => engine.requestPause(), setControllerError);
  const requestPause = () => {
    if (canRequestPause(controllerGate.current.busy, state.phase)) requestControllerPause();
  };
  const requestInterrupt = () => {
    if (!controllerGate.current.busy) {
      exit();
      return;
    }
    setPauseThenExit(true);
    abortRef.current?.abort(new Error("Interrupted by operator; run remains recoverable"));
  };
  const requestQuit = () => {
    if (!controllerGate.current.busy) exit();
    else if (requestControllerPause()) {
      setPauseThenExit(true);
    }
  };

  useEffect(() => {
    const offEvent = engine.onEvent((event) =>
      setEvents((current) => [...current.slice(-199), event]),
    );
    const offState = engine.onState((next) => setState({ ...next }));
    const controller = new AbortController();
    if (settleController(() => engine.run(controller.signal))) abortRef.current = controller;
    return () => {
      abortRef.current?.abort(new Error("TUI closed; run remains recoverable"));
      abortRef.current = null;
      offEvent();
      offState();
    };
  }, [engine, settleController]);

  useEffect(() => {
    if (shouldExitAfterController(pauseThenExit, controllerBusy)) exit();
  }, [controllerBusy, exit, pauseThenExit]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        requestInterrupt();
      } else if (input === "?" || input === "h") setShowHelp((value) => !value);
      else if (input === "c" && state.phase !== "complete") {
        setShowHelp(false);
        setConfigError(null);
        setShowConfig(true);
      } else if (input === "v") setShowDetail((value) => !value);
      else if (input === "p") requestPause();
      else if (
        input === "r" &&
        !controllerGate.current.busy &&
        ["paused", "blocked"].includes(state.phase)
      ) {
        const controller = new AbortController();
        setControllerError(null);
        if (settleController(() => engine.resumeRun(controller.signal))) {
          abortRef.current = controller;
        }
      } else if (input === "q") requestQuit();
      else if (key.escape) setShowHelp(false);
    },
    { isActive: !showConfig },
  );

  const percent =
    state.totalTasks === 0 ? 0 : Math.round((state.completedTasks / state.totalTasks) * 100);
  const activityTitle = useMemo(() => `ACTIVITY · ${events.length} events`, [events.length]);

  if (showHelp) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={2} flexDirection="column">
        <Text bold color="cyan">
          EPICD KEYBOARD
        </Text>
        <Text>
          <Text bold>p</Text> pause safely after the active operation
        </Text>
        <Text>
          <Text bold>r</Text> resume a paused or blocked run
        </Text>
        <Text>
          <Text bold>c</Text> configure models and reasoning for new threads
        </Text>
        <Text>
          <Text bold>v</Text> toggle activity details
        </Text>
        <Text>
          <Text bold>q</Text> pause then quit; exits immediately when the controller is idle
        </Text>
        <Text>
          <Text bold>?</Text> close this help
        </Text>
        <Box marginTop={1}>
          <Text dimColor>
            Ctrl-C interrupts the current agent turn and leaves the run recoverable.
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Box>
          <Text bold color="cyan">
            EPICD
          </Text>
          <Text dimColor> autonomous epic delivery</Text>
        </Box>
        <Text bold color={phaseColors[state.phase]}>
          {phaseLabels[state.phase].toUpperCase()}
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold wrap="truncate-end">
          {state.epicTitle}
        </Text>
        <Text dimColor>{state.epicId}</Text>
        <Text dimColor>Runtime: {state.runtime.toUpperCase()}</Text>
        {state.agentAccessMode === "danger-full-access" ? (
          <Text bold color="red">
            Permissions: FULL HOST ACCESS
          </Text>
        ) : null}
        {state.pendingAgentCleanup.length > 0 ? (
          <Text bold color="yellow">
            Cleanup pending: {state.pendingAgentCleanup.length}
          </Text>
        ) : null}
        <Box marginTop={1}>
          <Text color="cyan">
            {progressBar(state.completedTasks, state.totalTasks, compact ? 24 : 42)}
          </Text>
          <Text>
            {" "}
            {state.completedTasks}/{state.totalTasks} · {percent}%
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <StageLine phase={state.phase} />
      </Box>

      {showConfig ? (
        <Box marginTop={1}>
          <AgentConfig
            initialSettings={state.agentSettings}
            agentSessions={state.agentSessions}
            fallbackModel={state.model}
            fallbackReasoningEffort={state.reasoningEffort}
            onApply={(settings) => {
              try {
                engine.configureFutureAgentSettings(settings);
                setConfigError(null);
                setShowConfig(false);
              } catch (error) {
                setConfigError(error instanceof Error ? error.message : String(error));
              }
            }}
            onCancel={() => setShowConfig(false)}
            onInterrupt={requestInterrupt}
            onPause={requestPause}
            onQuit={requestQuit}
            error={configError}
          />
        </Box>
      ) : null}

      <Box marginTop={1} gap={1} flexDirection={compact ? "column" : "row"}>
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          flexDirection="column"
          flexGrow={1}
          minWidth={compact ? undefined : 45}
        >
          <Text bold color="magenta">
            CURRENT WORK
          </Text>
          <Text wrap="truncate-end">
            {state.currentBeadTitle ?? "Waiting for the orchestrator"}
          </Text>
          <Text dimColor>{state.currentBeadId ?? "No task selected"}</Text>
          <Box marginTop={1} flexDirection="column">
            {configurableRoles.map(({ role, label }) => {
              const session = state.agentSessions[role];
              const sessionId = session.status === "inactive" ? null : session.sessionId;
              const settings = displayedSettings(state, role);
              return (
                <Text key={role}>
                  <Text dimColor>{label} </Text>
                  {shortId(sessionId)}
                  <Text dimColor>
                    {` · ${settings.model ?? "default"} · ${settings.reasoningEffort} · ${sessionId ? "active" : "next"}`}
                  </Text>
                </Text>
              );
            })}
            <Text>
              <Text dimColor>Revision </Text>
              {shortId(state.candidateRevision)}
            </Text>
            <Text>
              <Text dimColor>Repair attempts </Text>
              {state.reviewPass}/{state.maxReviewPasses}
            </Text>
            {state.pendingFindings.length > 0 ? (
              <Text color="yellow">
                <Text dimColor>Findings </Text>
                {state.pendingFindings.length}
              </Text>
            ) : null}
          </Box>
        </Box>

        <Box
          borderStyle="round"
          borderColor={state.phase === "blocked" ? "red" : "gray"}
          paddingX={1}
          flexDirection="column"
          flexGrow={2}
        >
          <Text bold color={state.phase === "blocked" ? "red" : "cyan"}>
            {activityTitle}
          </Text>
          <Activity events={events} showDetail={showDetail} rows={activityRows} />
        </Box>
      </Box>

      {controllerError || state.lastError ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor="red"
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color="red">
            NEEDS ATTENTION
          </Text>
          <Text wrap="wrap">{controllerError ?? state.lastError}</Text>
          <Text dimColor>
            {controllerError
              ? "Inspect persisted status before retrying; this controller did not continue."
              : `Resolve the cause, then press r to resume from ${state.resumePhase ?? "selection"}.`}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor> p pause · c config · v details · ? help · q pause & quit </Text>
        <Text dimColor>run {shortId(state.runId, 8)}</Text>
      </Box>
    </Box>
  );
}
