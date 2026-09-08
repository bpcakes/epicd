import { startConfinedCommand, type ConfinedCommand } from "../../../src/adapters/sandbox.js";
import type { FixtureBridgeTransport } from "../../../src/adapters/fixture-bridge.js";

const input = JSON.parse(process.argv[2]!) as {
  request: ConfinedCommand;
  bridge: FixtureBridgeTransport;
};
const handle = await startConfinedCommand(input.request, { fixtureBridge: input.bridge });
await handle.result;
