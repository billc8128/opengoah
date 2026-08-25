import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import type { Supervisor } from "goah-supervisor";
import type { ProcessRunner } from "goah-runner-pi";
import type { SqliteLedger } from "goah-ledger-sqlite";
import type { JsonValue, Ledger } from "goah-ledger-contract";
import { installedVersion } from "./update.js";

export type ControlRequest =
  | { op: "ping" }
  | { op: "status" }
  | { op: "interact"; message: string }
  | { op: "turn.attach"; turnId: string }
  | { op: "turn.steer"; message: string }
  | { op: "turn.interrupt"; turnId: string }
  | { op: "goal.start"; objective: string; id?: string }
  | { op: "goal.update"; id: string; objective?: string; observationMethod?: string | null; verificationMethod?: string | null; owner?: string }
  | { op: "goal.observe"; id: string; observationMethod: string }
  | { op: "goal.transition"; id: string; phase: "paused" | "active" }
  | { op: "goal.complete"; id: string; reason: string; evidence: number[] }
  | { op: "ceo.send"; message: string }
  | { op: "ceo.status" }
  | { op: "ceo.inbox" }
  | { op: "work.records" }
  | { op: "work.record"; goalId: string }
  | { op: "work.history"; goalId: string }
  | { op: "work.diff"; goalId: string; fromRevision: number; toRevision: number }
  | { op: "action.approve"; id: string; reason: string; evidence: number[] }
  | { op: "action.reject"; id: string; reason: string; evidence: number[] }
  | { op: "wake.stop"; agent: string }
  | { op: "daemon.stop" }
  | { op: "daemon.version" }
  | { op: "config.reload"; configPath: string };

export type ControlFrame =
  | { type: "result"; value: JsonValue }
  | { type: "accepted"; turnId: string; value: JsonValue }
  | { type: "event"; event: JsonValue }
  | { type: "error"; error: string };

export function controlEndpoint(stateDir: string): string {
  if (process.platform !== "win32") return join(stateDir, "control.sock");
  return `\\\\.\\pipe\\goah-${createHash("sha256").update(stateDir).digest("hex").slice(0, 16)}`;
}

export async function runControlServer(supervisor: Supervisor, ledger: Ledger, stateDir: string, signal: AbortSignal, options: { reloadRuntime?: (configPath: string) => Promise<RuntimeSwap | undefined>; stop?: () => void } = {}): Promise<void> {
  mkdirSync(stateDir, { recursive: true });
  const endpoint = controlEndpoint(stateDir);
  if (process.platform !== "win32" && existsSync(endpoint)) rmSync(endpoint);
  const sockets = new Set<Socket>();
    const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => undefined); socket.once("close", () => sockets.delete(socket)); void serve(socket, supervisor, ledger, options.reloadRuntime, options.stop); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  if (process.platform !== "win32") chmodSync(endpoint, 0o600);
  await new Promise<void>((resolve) => {
    const stop = () => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); };
    if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
  });
  if (process.platform !== "win32" && existsSync(endpoint)) rmSync(endpoint);
}

export async function requestControl(stateDir: string, request: ControlRequest): Promise<JsonValue> {
  let result: JsonValue | undefined;
  await streamControl(stateDir, request, (frame) => {
    if (frame.type === "error") throw new Error(frame.error);
    if (frame.type === "result") result = frame.value;
  });
  if (result === undefined) throw new Error("control request ended without a result");
  return result;
}

export async function streamControl(stateDir: string, request: ControlRequest, onFrame: (frame: ControlFrame) => void, signal?: AbortSignal): Promise<void> {
  if(signal?.aborted)return;
  const socket = createConnection(controlEndpoint(stateDir));
  const abort = () => socket.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  try{
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject);socket.once("close",()=>signal?.aborted?resolve():reject(new Error("control connection closed before connecting"))); });
    if(signal?.aborted)return;
    socket.write(`${JSON.stringify(request)}\n`);
    let buffer = "";
    await new Promise<void>((resolve, reject) => {
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          if (!line) continue;
          try { onFrame(JSON.parse(line) as ControlFrame); } catch (error) { reject(error); socket.destroy(); }
        }
      });
      socket.once("end", resolve);
      socket.once("close", resolve);
      socket.once("error", reject);
    });
  }finally{signal?.removeEventListener("abort",abort);socket.destroy();}
}

export async function controlAvailable(stateDir: string): Promise<boolean> {
  try { return (await requestControl(stateDir, { op: "ping" })) === "pong"; } catch { return false; }
}

async function serve(socket: Socket, supervisor: Supervisor, ledger: Ledger, reloadRuntime?: (configPath: string) => Promise<RuntimeSwap | undefined>, stop?: () => void): Promise<void> {
  let buffer = "";
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    socket.removeAllListeners("data");
    const line = buffer.slice(0, index);
    let request: ControlRequest;
    try { request = JSON.parse(line) as ControlRequest; }
    catch (error) { write(socket, { type: "error", error: error instanceof Error ? error.message : String(error) }); socket.end(); return; }
    void dispatch(request, socket, supervisor, ledger, reloadRuntime, stop).catch((error) => {
      write(socket, { type: "error", error: error instanceof Error ? error.message : String(error) });
      socket.end();
    });
  });
}

async function dispatch(request: ControlRequest, socket: Socket, supervisor: Supervisor, ledger: Ledger, reloadRuntime?: (configPath: string) => Promise<RuntimeSwap | undefined>, stop?: () => void): Promise<void> {
  if (request.op === "interact") { await interact(request.message, socket, supervisor, ledger); return; }
  if (request.op === "turn.attach") { for await (const frame of turnFrames(request.turnId, ledger, () => !socket.destroyed)) write(socket, frame); socket.end(); return; }
  let value: unknown;
  if (request.op === "daemon.stop") {
    value = { stopping: true };
    setTimeout(() => stop?.(), 10);
  } else if (request.op === "daemon.version") value = installedVersion();
  else if (request.op === "config.reload") {
    const swap = reloadRuntime ? await reloadRuntime(request.configPath) : undefined;
    if (swap) { supervisor.swapRunner(swap.runner, swap.profiles); if (swap.ledger) { ledger.close(); ledger = swap.ledger; } }
    value = { reloaded: Boolean(swap) };
  } else if (request.op === "ping") value = "pong";
  else if (request.op === "status") value = snapshot(ledger, supervisor);
  else if (request.op === "goal.start") value = supervisor.startGoal(request.objective, request.id);
  else if (request.op === "goal.update") value = supervisor.updateGoal(request.id, { ...(request.objective !== undefined ? { objective: request.objective } : {}), ...(request.observationMethod !== undefined ? { observationMethod: request.observationMethod } : {}), ...(request.verificationMethod !== undefined ? { verificationMethod: request.verificationMethod } : {}), ...(request.owner !== undefined ? { owner: request.owner } : {}) }, "human");
  else if (request.op === "goal.observe") value = supervisor.confirmObservationMethod(request.id, request.observationMethod);
  else if (request.op === "goal.transition") value = supervisor.transitionGoal(request.id, request.phase, "human");
  else if (request.op === "goal.complete") value = supervisor.completeGoal({ goalId: request.id, revision: requiredGoal(ledger, request.id).revision, reason: request.reason, evidence: request.evidence }, "human");
  else if (request.op === "ceo.send") value = supervisor.sendToCeo({ message: request.message });
  else if (request.op === "ceo.status") value = ceoStatus(ledger, supervisor);
  else if (request.op === "ceo.inbox") value = ledger.unreadMail("human");
  else if (request.op === "work.records") value = ledger.workRecords();
  else if (request.op === "work.record") value = ledger.workRecord(request.goalId);
  else if (request.op === "work.history") value = ledger.workRecordHistory(request.goalId);
  else if (request.op === "work.diff") value = ledger.workRecordDiff(request.goalId, request.fromRevision, request.toRevision);
  else if (request.op === "action.approve") value = await supervisor.approveAction(request.id, "human", request.reason, request.evidence);
  else if (request.op === "action.reject") value = await supervisor.rejectAction(request.id, "human", request.reason, request.evidence);
  else if (request.op === "wake.stop") value = await supervisor.stopAgentWake(request.agent);
  else if (request.op === "turn.interrupt") value = await supervisor.interruptTurn(request.turnId);
  else if (request.op === "turn.steer") value = await supervisor.startHumanTurn(request.message);
  else value = { unknown: String(request) };
  write(socket, { type: "result", value: value as JsonValue });
  socket.end();
}

async function interact(message: string, socket: Socket, supervisor: Supervisor, ledger: Ledger): Promise<void> {
  for await (const frame of interactFrames(message, supervisor, ledger, () => !socket.destroyed)) write(socket, frame);
  socket.end();
}

/** Shared CEO Turn stream used by the interactive shell and the web Console. */
export async function* interactFrames(message: string, supervisor: Supervisor, ledger: Ledger, isActive: () => boolean = () => true): AsyncGenerator<ControlFrame> {
  if (!message.trim()) throw new Error("message is required");
  const accepted = await supervisor.startHumanTurn(message);
  yield { type: "accepted", turnId: accepted.turnId, value: accepted as unknown as JsonValue };
  yield* turnFrames(accepted.turnId, ledger, isActive);
}

async function* turnFrames(turnId: string, ledger: Ledger, isActive: () => boolean): AsyncGenerator<ControlFrame> {
  let nextStreamSeq = 1; const turn = ledger.turn(turnId); if (!turn) throw new Error("Turn not found");
  const drain=async function*():AsyncGenerator<ControlFrame>{const events=ledger.readStream(`turn:${turnId}`,nextStreamSeq);for(const event of events){nextStreamSeq=event.streamSeq+1;if(isTurnPresentationEvent(event.type))yield{type:"event",event:event as unknown as JsonValue};}};
  while (true) {
    if (!isActive()) return;
    yield* drain();
    const current = ledger.turn(turnId); if (!current) throw new Error("Turn disappeared");
    if (current.status !== "in_progress") {yield* drain();const answer = ledger.turnItems(turnId).filter((item) => item.type === "assistant_message").at(-1);const answerText=String((answer?.data as {text?:unknown}|undefined)?.text??"");const streamed=answerText!==""&&ledger.readStream(`turn:${turnId}`).some((event)=>event.type==="message.assistant.completed"&&assistantEventText(event.data)===answerText);yield { type: "result", value: { turn:{...current,leaseToken:null}, ...(answer&&!streamed ? { response: { content: answerText } } : {}) } as unknown as JsonValue }; return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function snapshot(ledger: Ledger, supervisor: Supervisor): JsonValue {
  return { seq: ledger.events().at(-1)?.seq ?? 0, threads: ledger.threads(), turns: ledger.turns().map((turn)=>({...turn,leaseToken:null})), goals: ledger.goals(), team: supervisor.teamList(), wakes: ledger.wakes(), actions: ledger.actions() } as unknown as JsonValue;
}
function ceoStatus(ledger: Ledger, supervisor: Supervisor): JsonValue {
  return { roots: ledger.goals().filter((goal) => goal.parentId === null && goal.owner === "ceo"), team: supervisor.teamList(), pendingHuman: ledger.unreadMail("human"), recentCeoHandoffs: ledger.eventsSince(0, ["handoff.recorded"]).filter((event) => event.actor === "ceo").slice(-10) } as unknown as JsonValue;
}
function requiredGoal(ledger: Ledger, id: string) { const goal = ledger.goal(id); if (!goal) throw new Error("goal not found"); return goal; }
function assistantEventText(value:JsonValue):string{if(!value||typeof value!=="object"||Array.isArray(value)||!value.message||typeof value.message!=="object"||Array.isArray(value.message))return"";const content=value.message.content;if(typeof content==="string")return content;if(!Array.isArray(content))return"";return content.map((item)=>item&&typeof item==="object"&&!Array.isArray(item)&&item.type==="text"&&typeof item.text==="string"?item.text:"").filter(Boolean).join("\n");}
export function isTurnPresentationEvent(type:string):boolean{return type.startsWith("message.")||type.startsWith("tool.")||type.startsWith("item.")||type.startsWith("turn.")||type==="handoff.recorded"||type==="transcript.interrupted"||type==="transcript.completed";}
function write(socket: Socket, frame: ControlFrame): void { socket.write(`${JSON.stringify(frame)}\n`); }

export interface RuntimeSwap { runner: ProcessRunner | import("goah-ledger-contract").Runner; ledger?: SqliteLedger; profiles?: import("goah-ledger-contract").RunnerProfile[] }
