import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { EpicEngine } from "../engine/engine.js";
import type { EngineEvent, RunPhase, RunState } from "../domain/types.js";
import {
  clock,
  eventColors,
  eventSymbols,
  phaseColors,
  phaseLabels,
  progressBar,
  shortId,
} from "../ui/format.js";

const pipeline: Array<{ phases: RunPhase[]; label: string }> = [
  { phases: ["selecting", "preparing"], label: "SELECT" },
  { phases: ["claiming"], label: "CLAIM" },
  { phases: ["implementing", "fixing"], label: "BUILD" },
  { phases: ["reviewing"], label: "REVIEW" },
  { phases: ["committing"], label: "COMMIT" },
  { phases: ["verifying", "final_review"], label: "VERIFY" },
  { phases: ["closing", "complete"], label: "CLOSE" },
];

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
  const [state, setState] = useState<RunState>({ ...engine.state });
  const [events, setEvents] = useState<EngineEvent[]>(() =>
    engine.store.events(engine.state.runId, 100),
  );
  const [showDetail, setShowDetail] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [runGeneration, setRunGeneration] = useState(0);
  const [pauseThenExit, setPauseThenExit] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const columns = stdout.columns ?? 100;
  const compact = columns < 84;
  const activityRows = compact ? 7 : 11;

  useEffect(() => {
    const offEvent = engine.onEvent((event) =>
      setEvents((current) => [...current.slice(-199), event]),
    );
    const offState = engine.onState((next) => setState({ ...next }));
    const controller = new AbortController();
    abortRef.current = controller;
    void engine.run(controller.signal).then((next) => setState({ ...next }));
    return () => {
      offEvent();
      offState();
    };
  }, [engine, runGeneration]);

  useEffect(() => {
    if (pauseThenExit && ["paused", "blocked"].includes(state.phase)) exit();
  }, [exit, pauseThenExit, state.phase]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      setPauseThenExit(true);
      abortRef.current?.abort(new Error("Interrupted by operator; run remains recoverable"));
    } else if (input === "?" || input === "h") setShowHelp((value) => !value);
    else if (input === "v") setShowDetail((value) => !value);
    else if (input === "p" && !["paused", "blocked", "complete"].includes(state.phase))
      engine.requestPause();
    else if (input === "r" && ["paused", "blocked"].includes(state.phase)) {
      engine.continueRun();
      setRunGeneration((value) => value + 1);
    } else if (input === "q") {
      if (["paused", "blocked", "complete"].includes(state.phase)) exit();
      else {
        setPauseThenExit(true);
        engine.requestPause();
      }
    } else if (key.escape) setShowHelp(false);
  });

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
          <Text bold>v</Text> toggle activity details
        </Text>
        <Text>
          <Text bold>q</Text> pause then quit; exits immediately when already stopped
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
            <Text>
              <Text dimColor>Coordinator </Text>
              {shortId(state.orchestratorThreadId)}
              <Text dimColor>
                {` · ${state.agentSettings.orchestrator.model ?? state.model ?? "default"} · ${state.agentSettings.orchestrator.reasoningEffort}`}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Implementer </Text>
              {shortId(state.implementationThreadId)}
              <Text dimColor>
                {` · ${state.agentSettings.implementation.model ?? state.model ?? "default"} · ${state.agentSettings.implementation.reasoningEffort}`}
              </Text>
            </Text>
            <Text>
              <Text dimColor>Reviewer </Text>
              {shortId(state.reviewThreadId)}
              <Text dimColor>
                {` · ${state.agentSettings.review.model ?? state.model ?? "default"} · ${state.agentSettings.review.reasoningEffort}`}
              </Text>
            </Text>
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

      {state.lastError ? (
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
          <Text wrap="wrap">{state.lastError}</Text>
          <Text dimColor>
            Resolve the cause, then press r to resume from {state.resumePhase ?? "selection"}.
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor> p pause · v details · ? help · q pause & quit </Text>
        <Text dimColor>run {shortId(state.runId, 8)}</Text>
      </Box>
    </Box>
  );
}
