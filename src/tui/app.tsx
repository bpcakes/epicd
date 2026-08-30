import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { EpicEngine } from "../engine/engine.js";
import { EpicPicker, type PickerItem } from "./picker.js";
import { RunView } from "./run-view.js";

export function EpicdApp({
  items,
  loadEngine,
}: {
  items: PickerItem[];
  loadEngine: (item: PickerItem) => Promise<EpicEngine>;
}) {
  const [engine, setEngine] = useState<EpicEngine | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (engine) return <RunView engine={engine} />;
  if (loading) {
    return (
      <Box borderStyle="round" borderColor="cyan" paddingX={2}>
        <Text color="cyan">Preparing epic graph and recovery state…</Text>
      </Box>
    );
  }
  if (error) {
    return <ErrorPanel error={error} onBack={() => setError(null)} />;
  }
  return (
    <EpicPicker
      items={items}
      onSelect={(item) => {
        setLoading(true);
        void loadEngine(item)
          .then(setEngine)
          .catch((reason: unknown) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          )
          .finally(() => setLoading(false));
      }}
    />
  );
}

function ErrorPanel({ error, onBack }: { error: string; onBack: () => void }) {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "b" || input === "r") onBack();
    else if (input === "q") exit();
  });
  return (
    <Box borderStyle="round" borderColor="red" paddingX={2} flexDirection="column">
      <Text bold color="red">
        Could not start epicd
      </Text>
      <Text>{error}</Text>
      <Box marginTop={1}>
        <Text dimColor>b back · q quit</Text>
      </Box>
    </Box>
  );
}
