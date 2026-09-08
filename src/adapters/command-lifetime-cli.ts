import { superviseCommand } from "./command-lifetime.js";
import { redactSensitiveText } from "../util/redact.js";
try {
  await superviseCommand();
} catch (error) {
  process.stderr.write(redactSensitiveText(String(error), 4000));
  process.exitCode = 1;
}
