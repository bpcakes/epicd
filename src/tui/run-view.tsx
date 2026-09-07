import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { OrchestratorController } from "../controller.js";
import { humanRunStatus } from "../status.js";

/** Displays journal facts; no UI state advances the delivery workflow. */
export function RunView({
  controller,
  stop,
}: {
  controller: OrchestratorController;
  stop: () => void;
}) {
  const [status, setStatus] = useState(() => controller.status());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => {
      try {
        setStatus(controller.status());
      } catch (failure) {
        setError(String(failure));
      }
    }, 250);
    return () => clearInterval(timer);
  }, [controller]);
  useInput((input, key) => {
    if (input === "p" || input === "q" || (key.ctrl && input === "c")) {
      try {
        controller.pause();
        stop();
      } catch (failure) {
        setError(String(failure));
      }
    }
  });
  return (
    <Box flexDirection="column">
      <Text>{humanRunStatus(status)}</Text>
      <Text dimColor>p / q: pause, settle owned work, and exit</Text>
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
