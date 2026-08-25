import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runProcessWorker } from "goah-runner-pi";
import type { JsonValue, RunnerResult, WakeOutput } from "goah-ledger-contract";

interface WorkerStep {
  trace?: Array<{ type: string; data: JsonValue }>;
  response?: string;
  write?: { path: string; content: string };
  handoff?: WakeOutput;
  crash?: string;
  hang?: boolean;
  delayMs?: number;
  rpc?: { method: import("goah-ledger-contract").AgentCapability; params: JsonValue };
}

await runProcessWorker(async (request, emit, rpc): Promise<RunnerResult> => {
  if (process.env.GOAH_FAUX_CONTEXT_FILE) writeFileSync(process.env.GOAH_FAUX_CONTEXT_FILE, JSON.stringify(request.context));
  const byAgent = JSON.parse(process.env.GOAH_FAUX_STEPS_BY_AGENT ?? "{}") as Record<string, WorkerStep[]>;
  const byTrigger = JSON.parse(process.env.GOAH_FAUX_STEPS_BY_TRIGGER ?? "{}") as Record<string, WorkerStep[]>;
  const triggerSteps = request.sourceWake ? Object.entries(byTrigger).find(([prefix]) => request.sourceWake!.triggerRef.startsWith(prefix))?.[1] : undefined;
  const steps = triggerSteps ?? byAgent[request.agent] ?? JSON.parse(process.env.GOAH_FAUX_STEPS ?? "[]") as WorkerStep[];
  let goalBinding = request.turn?.goalBinding;
  let recordUpdated = false;
  for (const step of steps) {
    if (step.write) {
      const path = join(process.cwd(), step.write.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.write.content);
    }
    for (const trace of step.trace ?? []) emit(trace);
    if (step.rpc) {
      const result = await rpc(step.rpc.method, resolveParams(step.rpc.params, request.context));
      emit({ type: "runner.rpc.result", data: result });
      if (step.rpc.method === "goal.create" || step.rpc.method === "goal.work") goalBinding = bindingFrom(result) ?? goalBinding;
      if (step.rpc.method === "work_record.update") recordUpdated = true;
    }
    if (step.crash) throw new Error(step.crash);
    if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
    if (step.hang) await new Promise(() => undefined);
    if (step.response !== undefined) return { outcome: "response", response: { content: step.response } };
    if (step.handoff) {
      if (goalBinding && !recordUpdated) {
        const current = await rpc("work_record.read", { goalId: goalBinding.goalId });
        const record = current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, JsonValue> : {};
        const evidence = sourceSeqs(request.context);
        await rpc("work_record.update", { expectedRevision: Number(record.recordRevision ?? 0), content: handoffRecord(step.handoff, request.execution.id), reason: "record faux Goal progress", evidence: evidence.length ? [Math.max(...evidence)] : [] });
      }
      return { outcome: "handoff", output: step.handoff };
    }
  }
  return { outcome: "abnormal", reason: "faux worker stopped without handoff" };
});

function resolveParams(value: JsonValue, context: JsonValue): JsonValue {
  const latest = Math.max(0, ...sourceSeqs(context));
  const visit = (item: JsonValue): JsonValue => {
    if (item === "$LATEST_SOURCE_SEQ") return latest;
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, nested]) => [key, visit(nested)]));
    return item;
  };
  return visit(value);
}

function sourceSeqs(context: JsonValue): number[] { return context && typeof context === "object" && !Array.isArray(context) && Array.isArray(context.sourceSeqs) ? context.sourceSeqs.filter((item): item is number => typeof item === "number") : []; }
function bindingFrom(value: JsonValue): { goalId: string; goalRevision: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.goalBinding || typeof value.goalBinding !== "object" || Array.isArray(value.goalBinding)) return undefined;
  const binding = value.goalBinding as Record<string, JsonValue>;
  return typeof binding.goalId === "string" && typeof binding.goalRevision === "number" ? { goalId: binding.goalId, goalRevision: binding.goalRevision } : undefined;
}
function handoffRecord(output: WakeOutput, wakeId: string): string {
  if ("goalId" in output.handoff) return `# Current State\n\nGoal outcome: ${output.handoff.outcome}.\n\n# Observations\n\nSee Ledger evidence ${output.handoff.evidence.join(", ") || "none"}.\n\n# Work Completed\n\nRecorded Goal progress.\n\n# Decisions\n\nRecorded by the faux Goal runner in ${wakeId}.\n\n# Blockers\n\n${output.handoff.outcome === "blocked" ? "Blocked." : "None."}\n\n# Next Steps\n\nContinue from the current Goal state.\n`;
  const list = (values: string[]) => values.length ? values.map((value) => `- ${value}`).join("\n") : "None.";
  return `# Current State\n\n${output.handoff.blocker ?? "Work progressed."}\n\n# Observations\n\n${list(output.handoff.observations)}\n\n# Work Completed\n\n${list(output.handoff.results)}\n\n# Decisions\n\nRecorded by the faux Goal runner in ${wakeId}.\n\n# Blockers\n\n${output.handoff.blocker ?? "None."}\n\n# Next Steps\n\n${list(output.handoff.nextSteps)}\n`;
}
