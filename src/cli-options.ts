import { InvalidArgumentError, Option } from "commander";
import { ModelIdSchema } from "./domain/types.js";

export function parseModelArgument(value: string): string {
  const parsed = ModelIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError("must not be blank");
  return parsed.data;
}

export function modelOption(flags: string, description: string): Option {
  return new Option(flags, description).argParser(parseModelArgument);
}
