import { runProcessWorker } from "./index.js";

await runProcessWorker(async (_request, emit) => {
  const data = "A".repeat(1_100_000);
  emit({
    type: "tool.completed",
    data: {
      callId: "image-read",
      name: "read",
      result: { content: [{ type: "image", data, mimeType: "image/png" }] },
      isError: false,
    },
  });
  emit({
    type: "request.component",
    data: {
      hash: "large-image-message",
      kind: "message",
      content: {
        role: "toolResult",
        content: [{ type: "image", data, mimeType: "image/png" }],
      },
    },
  });
  return { outcome: "completed", finalMessageId: "large-message" };
});
