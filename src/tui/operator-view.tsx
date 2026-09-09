import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  OperatorRequestSchema,
  type OperatorRequest,
  type RunOperator,
} from "../operator-controls.js";
import { humanRunStatus, type RunStatus } from "../status.js";
import { redactSensitiveText } from "../util/redact.js";

type Kind = OperatorRequest["kind"];
type Field = { name: string; label: string; optional?: true };
const fields: Record<Kind, Field[]> = {
  pause: [],
  respond: [{ name: "message", label: "Response (instruction only, not authority)" }],
  grant_fixture: [
    { name: "fixtureId", label: "Declared fixture ID" },
    {
      name: "operations",
      label: "Operations, comma-separated (inspect/create; reset/cleanup unavailable)",
    },
    { name: "expiresAt", label: "Expiry (ISO time in the next 24 hours)" },
    { name: "psqlPath", label: "Canonical native psql executable" },
  ],
  revoke_fixture: [{ name: "grantId", label: "Exact management grant ID to revoke" }],
  grant_sql: [
    { name: "fixtureId", label: "Declared fixture ID" },
    { name: "expiresAt", label: "Expiry (ISO time in the next 24 hours)" },
    { name: "psqlPath", label: "Canonical native psql executable" },
  ],
  revoke_sql: [{ name: "grantId", label: "Exact SQL-access grant ID to revoke" }],
  handoff: [
    {
      name: "runtime",
      label: "Target runtime (sdk/herdr; native Herdr requires a managed caller)",
    },
    {
      name: "codexPath",
      label: "Codex executable override (blank: runtime default)",
      optional: true,
    },
    { name: "herdrPath", label: "Herdr executable override (blank: PATH)", optional: true },
  ],
};
const choices: Record<string, Kind> = {
  "1": "pause",
  "2": "respond",
  "3": "grant_fixture",
  "4": "revoke_fixture",
  "5": "grant_sql",
  "6": "revoke_sql",
  "7": "handoff",
};
type Draft = { action: Kind; observed: RunStatus; index: number; values: Record<string, string> };
type Screen =
  | { kind: "menu" }
  | { kind: "form"; draft: Draft }
  | { kind: "confirm"; request: OperatorRequest; observed: RunStatus }
  | { kind: "busy" };
const visible = (text: string) =>
  redactSensitiveText(text, 32_000).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");

function requestFrom(draft: Draft): OperatorRequest {
  const input: Record<string, unknown> = {
    kind: draft.action,
    controlVersion: draft.observed.control.controlVersion,
    ...draft.values,
  };
  if (draft.action === "respond") input.escalationId = draft.observed.escalation?.escalationId;
  if (draft.action === "grant_fixture")
    input.operations = draft.values.operations!.split(",").map((value) => value.trim());
  for (const field of fields[draft.action])
    if (field.optional && !input[field.name]) delete input[field.name];
  return OperatorRequestSchema.parse(input);
}

/** Pure preview of the exact submitted request plus its frozen declared authority scope. */
export function operatorRequestPreview(request: OperatorRequest, observed: RunStatus): string {
  const lines = [JSON.stringify(request, null, 2)];
  if ("fixtureId" in request) {
    const definition = observed.fixtures.declarations.find((item) => item.id === request.fixtureId);
    if (!definition) throw new Error("Fixture is absent from the frozen repository policy");
    lines.push(`Declared endpoint and resource: ${JSON.stringify(definition)}`);
    if (request.kind === "grant_sql") {
      const policy = observed.fixtures.validationPolicies.find(
        (item) => item.fixtureId === request.fixtureId,
      );
      if (!policy) throw new Error("This fixture has no SQL-access declaration");
      lines.push(`Dedicated validation role and broker: ${JSON.stringify(policy)}`);
    }
  }
  if (request.kind === "respond")
    lines.push(
      `Question ${request.escalationId}: ${observed.escalation?.question}`,
      "Instruction only. This does not grant fixture, SQL, or destructive-action authority.",
    );
  if (request.kind === "grant_fixture" || request.kind === "grant_sql")
    lines.push(
      "Replaces this fixture's existing grant of the same kind. Does not answer a question, adopt a database, or start work.",
    );
  if (request.kind === "handoff")
    lines.push(
      "Requires settled work and no live controller. Preserves evidence and budgets; native Herdr stays native. Does not start a model or answer a question.",
    );
  if (request.kind === "pause")
    lines.push("Stops admission; actual work needs confirmed stop receipts.");
  if (request.kind === "revoke_fixture" || request.kind === "revoke_sql")
    lines.push(
      "Revokes only this grant. Does not delete a resource or prove in-flight work stopped.",
    );
  return visible(lines.join("\n"));
}

/** One explicitly selected run. Reads do not acquire a controller lease or grant authority. */
export function OperatorView({
  controls,
  close,
}: {
  controls: Pick<RunOperator, "status" | "submit">;
  close: () => void;
}) {
  const [status, setStatus] = useState(() => controls.status());
  const [screen, setScreen] = useState<Screen>({ kind: "menu" });
  const [input, setInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const busy = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => {
      try {
        setStatus(controls.status());
      } catch (failure) {
        setError(visible(String(failure)));
      }
    }, 250);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [controls]);
  const confirm = (draft: Draft) => {
    const request = requestFrom(draft);
    operatorRequestPreview(request, draft.observed); // Reject unavailable scope before confirmation.
    setScreen({ kind: "confirm", request, observed: draft.observed });
    setInput("");
  };
  useInput((text, key) => {
    if ((key.ctrl && text === "c") || (screen.kind === "menu" && text === "q")) {
      close();
      return;
    }
    if (busy.current) return;
    if (key.escape) {
      setScreen({ kind: "menu" });
      setInput("");
      setError(null);
      return;
    }
    try {
      if (screen.kind === "menu") {
        if (text === "[") setPage((value) => Math.max(0, value - 1));
        else if (text === "]")
          setPage((value) =>
            Math.min(
              Math.max(0, Math.ceil(status.fixtures.declarations.length / 4) - 1),
              value + 1,
            ),
          );
        const action = choices[text];
        if (!action) return;
        const observed = controls.status();
        setStatus(observed);
        setMessage(null);
        setError(null);
        setInput("");
        if (action === "respond" && !observed.escalation)
          throw new Error("There is no pending question to answer");
        const draft: Draft = { action, observed, index: 0, values: {} };
        if (fields[action].length) setScreen({ kind: "form", draft });
        else confirm(draft);
      } else if (key.return) {
        if (screen.kind === "form") {
          const field = fields[screen.draft.action][screen.draft.index]!;
          if (!input.trim() && !field.optional) throw new Error("This field is required");
          const draft = {
            ...screen.draft,
            values: { ...screen.draft.values, [field.name]: input },
          };
          if (draft.index + 1 < fields[draft.action].length) {
            setScreen({ kind: "form", draft: { ...draft, index: draft.index + 1 } });
            setInput("");
          } else confirm(draft);
        } else if (screen.kind === "confirm") {
          if (input !== "confirm") throw new Error("Type confirm, then Enter, or Esc to cancel");
          busy.current = true;
          setScreen({ kind: "busy" });
          setInput("");
          setError(null);
          void controls
            .submit(screen.request)
            .then(
              (result) => {
                if (mounted.current) setMessage(visible(result));
              },
              (failure) => {
                if (mounted.current) setError(visible(String(failure)));
              },
            )
            .finally(() => {
              busy.current = false;
              if (mounted.current) {
                setScreen({ kind: "menu" });
              }
            });
        }
      } else if (key.backspace || key.delete)
        setInput((value) => Array.from(value).slice(0, -1).join(""));
      else if (!key.ctrl && !key.meta && !key.tab) {
        const next = input + text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
        if (Buffer.byteLength(next) > 7000)
          throw new Error("Input exceeds 7000 bytes; nothing was truncated or submitted");
        setInput(next);
      }
    } catch (failure) {
      setError(visible(String(failure)));
    }
  });
  const shown = status.fixtures.declarations.slice(page * 4, page * 4 + 4);
  return (
    <Box flexDirection="column">
      <Text>{visible(humanRunStatus(status))}</Text>
      <Text bold>Operator console — no controller is started here</Text>
      {screen.kind === "menu" ? (
        <>
          <Text>1 pause · 2 answer question · 3 grant fixture · 4 revoke fixture grant</Text>
          <Text>5 grant SQL access · 6 revoke SQL access · 7 runtime handoff · q close</Text>
          <Text dimColor>
            Every operation requires review and typed confirmation. Closing does not pause delivery.
          </Text>
          <Text>
            Fixtures {page + 1}/{Math.max(1, Math.ceil(status.fixtures.declarations.length / 4))} ([
            / ] to page)
          </Text>
          {shown.map((definition) => {
            const authority = status.fixtures.authority.find(
              (item) => item.fixtureId === definition.id,
            );
            return (
              <Box key={definition.id} flexDirection="column">
                <Text>
                  {visible(
                    `${definition.id}: ${definition.database} at ${definition.socketDirectory}:${definition.port}; owner ${definition.expectedOwner}`,
                  )}
                </Text>
                {authority?.grants.map((grant) => (
                  <Text key={grant.grantId}>
                    {visible(
                      `  management ${grant.grantId}: ${grant.operations.join(",")}; expires ${grant.expiresAt}${grant.expired ? " (expired)" : ""}`,
                    )}
                  </Text>
                ))}
                {authority?.validation.grants.map((grant) => (
                  <Text key={grant.grantId}>
                    {visible(`  SQL ${grant.grantId}: expires ${grant.expiresAt}`)}
                  </Text>
                ))}
              </Box>
            );
          })}
        </>
      ) : null}
      {screen.kind === "form" ? (
        <>
          <Text>
            {screen.draft.action} · observed control version{" "}
            {screen.draft.observed.control.controlVersion}
          </Text>
          <Text>{fields[screen.draft.action][screen.draft.index]!.label}</Text>
          <Text>{visible(input)}▏</Text>
          <Text dimColor>Enter: next · Esc: cancel</Text>
        </>
      ) : null}
      {screen.kind === "confirm" ? (
        <>
          <Text>{operatorRequestPreview(screen.request, screen.observed)}</Text>
          <Text>Type confirm and Enter to submit exactly this request; Esc cancels.</Text>
          <Text>{visible(input)}▏</Text>
        </>
      ) : null}
      {screen.kind === "busy" ? (
        <Text>
          Settling operator request; no second request can start. Ctrl+C closes after settlement.
        </Text>
      ) : null}
      {message ? <Text color="green">{message}</Text> : null}
      {error ? <Text color="red">{error}</Text> : null}
    </Box>
  );
}
