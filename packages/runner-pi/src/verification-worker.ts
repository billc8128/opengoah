import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { createPiModel, resolvedApiKey } from "./model-provider.js";
interface VerificationResult {
  findings: Array<{ id: string; body: unknown; evidence: number[]; riskWeight: number }>;
  priority: "low" | "normal" | "high";
  tokensUsed: number;
}

export async function runVerificationWorker(): Promise<void> {
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const request = JSON.parse(line) as {
      operation: "verify_turn" | "blind_audit";
      input: unknown;
    };
    const provider = process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const configured = createPiModel(provider, modelId);
    const models = configured.models as unknown as MutableModels;
    const model = configured.model as unknown as import("@earendil-works/pi-ai").Model<
      import("@earendil-works/pi-ai").Api
    >;
    if (provider === "faux") {
      const faux = configured.faux!;
      const findings = JSON.parse(process.env.GOAH_VERIFIER_FAUX_FINDINGS ?? "[]");
      const priority =
        process.env.GOAH_VERIFIER_FAUX_PRIORITY ?? (findings.length ? "normal" : "low");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("report_findings", { findings, priority }), {
          stopReason: "toolUse",
        }),
      ]);
    }

    let result: VerificationResult | null = null;
    let tokensUsed = 0;
    const tool: AgentTool<any> = {
      name: "report_findings",
      label: "Report findings",
      description: "Return evidence-backed verification findings.",
      parameters: Type.Object({
        priority: Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]),
        findings: Type.Array(
          Type.Object({
            id: Type.String(),
            body: Type.Any(),
            evidence: Type.Array(Type.Number()),
            riskWeight: Type.Number(),
          }),
        ),
      }),
      execute: async (_id, params) => {
        const input = params as {
          findings: VerificationResult["findings"];
          priority: VerificationResult["priority"];
        };
        result = { findings: input.findings, priority: input.priority, tokensUsed };
        return {
          content: [{ type: "text", text: "findings recorded" }],
          details: result,
          terminate: true,
        };
      },
    };
    const systemPrompt =
      request.operation === "blind_audit"
        ? "Independently audit durable facts. Report only evidence-backed findings."
        : "Verify the handoff against trace facts. Never trust self-report without support.";
    const agent = new Agent({
      initialState: {
        systemPrompt: `${systemPrompt} You must call report_findings exactly once. Choose high priority only for urgent/time-sensitive risk, normal for actionable findings, and low when no prompt action is needed.`,
        model,
        tools: [tool],
      },
      streamFn: models.streamSimple.bind(models),
      getApiKey: (id) => resolvedApiKey(configured.models, id),
      shouldStopAfterTurn: () => result !== null,
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant")
        tokensUsed += event.message.usage.totalTokens;
    });
    await agent.prompt(JSON.stringify(request.input));
    const finalResult = result as VerificationResult | null;
    if (!finalResult) throw new Error("verifier exited without findings");
    finalResult.tokensUsed = tokensUsed;
    process.stdout.write(JSON.stringify(finalResult));
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  await runVerificationWorker();
