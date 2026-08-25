import { runProcessWorker } from "./index.js";

await runProcessWorker(async (_request, _emit, _rpc, controls) => new Promise((resolve) => {
  controls.onSteer((message) => { resolve({ outcome: "response", response: { content: message } }); return true; });
}));
