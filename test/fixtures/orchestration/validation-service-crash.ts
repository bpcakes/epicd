import { startConfinedCommand, type ConfinedCommand } from "../../../src/adapters/sandbox.js";
import {
  withValidationServices,
  type BoundValidationService,
} from "../../../src/adapters/validation-services.js";

const input = JSON.parse(process.argv[2]!) as {
  request: ConfinedCommand;
  services: BoundValidationService[];
};
const handle = await startConfinedCommand(withValidationServices(input.request, input.services));
await handle.result;
