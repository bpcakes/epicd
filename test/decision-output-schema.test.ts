import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DECISION_OUTPUT_SCHEMA } from "../src/orchestrator/sdk-source.js";
import { KernelActionSchema } from "../src/domain/orchestration.js";
import { ReviewReferenceSchema } from "../src/domain/review-references.js";

function unsupportedComposition(value: unknown, path = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((entry, index) => unsupportedComposition(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...([
      "oneOf",
      "allOf",
      "not",
      "if",
      "then",
      "else",
      "dependentRequired",
      "dependentSchemas",
    ].includes(key)
      ? [`${path}.${key}`]
      : []),
    ...unsupportedComposition(entry, `${path}.${key}`),
  ]);
}

describe("coordinator Structured Outputs contract", () => {
  it("contains no unsupported composition at any depth, including review-reference array items", () => {
    // This exact nested path was rejected by the live Astra API with HTTP 400.
    // Checking only request.action misses discriminated unions inside capabilities.
    expect(unsupportedComposition(DECISION_OUTPUT_SCHEMA)).toEqual([]);
  });

  it("retains all three disjoint reference shapes with required selectors and closed objects", () => {
    const object = z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()),
      additionalProperties: z.literal(false),
    });
    const root = object.parse(DECISION_OUTPUT_SCHEMA);
    const request = object.parse(root.properties.request);
    const actions = z.object({ anyOf: z.array(object) }).parse(request.properties.action).anyOf;
    expect(actions).toHaveLength(KernelActionSchema.options.length);
    const review = actions.find(
      (action) =>
        z.object({ const: z.string() }).parse(action.properties.kind).const === "run_review",
    )!;
    expect(review).toBeDefined();
    const references = z
      .object({
        type: z.literal("array"),
        maxItems: z.literal(32),
        items: z.object({ anyOf: z.array(object) }),
      })
      .parse(review.properties.references);
    expect(references.items.anyOf).toHaveLength(3);
    expect(
      references.items.anyOf.map(
        (variant) => z.object({ const: z.string() }).parse(variant.properties.kind).const,
      ),
    ).toEqual(["action", "artifact", "record"]);
    for (const variant of references.items.anyOf)
      expect([...variant.required].sort()).toEqual(Object.keys(variant.properties).sort());
    expect(references.items.anyOf.map((variant) => Object.keys(variant.properties).sort())).toEqual(
      [
        ["actionId", "kind", "limit", "offset"],
        ["artifactId", "kind", "limit", "offset"],
        ["kind", "limit", "offset", "recordId", "recordKind"],
      ],
    );
  });

  it("still validates literal selectors, bounds and unknown fields at kernel admission", () => {
    const references = [
      { kind: "action", actionId: "action", offset: 0, limit: 4000 },
      { kind: "artifact", artifactId: "bc8bb2af-0e89-4d07-a8d0-9caed83a983b", offset: 1, limit: 1 },
      { kind: "record", recordKind: "agent_turn", recordId: "turn", offset: 0, limit: 100 },
    ];
    for (const reference of references) {
      expect(ReviewReferenceSchema.parse(reference)).toEqual(reference);
      for (const invalid of [
        { ...reference, kind: "unknown" },
        { ...reference, offset: -1 },
        { ...reference, limit: 0 },
        { ...reference, limit: 4001 },
        { ...reference, extra: true },
        { ...reference, kind: reference.kind === "action" ? "artifact" : "action" },
      ])
        expect(ReviewReferenceSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
