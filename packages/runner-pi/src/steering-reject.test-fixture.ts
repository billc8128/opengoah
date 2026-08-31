import { runProcessWorker } from "./index.js";

await runProcessWorker(
  async (request, emit, _rpc, controls) =>
    new Promise((resolve) => {
      controls.onSteer(() => {
        const finalMessageId = `steering:${request.execution.id}`;
        emit({
          type: "message.assistant.completed",
          data: {
            message: {
              id: finalMessageId,
              role: "assistant",
              content: [{ type: "text", text: "finished" }],
            },
            commitState: "committed",
          },
        });
        resolve({ outcome: "completed", finalMessageId });
        return false;
      });
    }),
);
