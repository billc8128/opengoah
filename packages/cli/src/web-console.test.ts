import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createRuntime, defaultConfig, loadConfig } from "./index.js"
import { consoleMetadataPath, readConsoleMetadata, runWebConsole } from "./web-console.js"

test("local Console serves assets, redacted snapshots, and CEO control through Supervisor", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-"))
  const configPath = join(root, "goah.config.json")
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const runtime = createRuntime(loadConfig(configPath))
  runtime.ledger.putMail({ id: "secret-mail", to: "ceo", from: "human", level: "decision", body: { apiKey: "sk-do-not-expose-123456789" }, readAt: null }, "human")

  const controller = new AbortController()
  let resolveListening!: () => void
  const listening = new Promise<void>((resolve) => { resolveListening = resolve })
  const server = runWebConsole(runtime.supervisor, runtime.ledger, config.stateDir, controller.signal, { onListening: resolveListening })
  await listening
  const metadata = readConsoleMetadata(config.stateDir)
  assert.ok(metadata)

  const page = await fetch(metadata.url)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Goah Console/)

  const ceoResponse = await fetch(`${metadata.url}api/ceo?token=${metadata.token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Launch a profitable store" }),
  })
  assert.equal(ceoResponse.status, 202)
  const accepted = await ceoResponse.json() as { threadId: string; turnId: string }
  assert.equal(runtime.ledger.goals().length, 0)

  const snapshotResponse = await fetch(`${metadata.url}api/snapshot?token=${metadata.token}`)
  assert.equal(snapshotResponse.status, 200)
  const snapshotText = await snapshotResponse.text()
  assert.match(snapshotText, /Launch a profitable store/)
  assert.doesNotMatch(snapshotText, /sk-do-not-expose/)
  assert.match(snapshotText, /\[REDACTED\]/)

  const trajectoryResponse = await fetch(`${metadata.url}api/trajectory?limit=2&token=${metadata.token}`)
  assert.equal(trajectoryResponse.status, 200)
  const trajectory = await trajectoryResponse.json() as { items: Array<{ event: { seq: number; type: string }; agent: string; wakeId: string | null }> }
  assert.ok(trajectory.items.length > 0)
  assert.ok(trajectory.items.every((item, index, items) => index === 0 || items[index - 1]!.event.seq > item.event.seq))

  const threadResponse = await fetch(`${metadata.url}api/threads/${encodeURIComponent(accepted.threadId)}?token=${metadata.token}`)
  assert.equal(threadResponse.status, 200)
  const thread = await threadResponse.json() as { thread: { id: string }; turns: Array<{ id: string; items: unknown[] }> }
  assert.equal(thread.thread.id, accepted.threadId)
  assert.equal(thread.turns[0]?.id, accepted.turnId)

  while (runtime.ledger.turn(accepted.turnId)?.status === "in_progress") await new Promise((resolve) => setTimeout(resolve, 5))

  controller.abort()
  await server
  assert.equal(readConsoleMetadata(config.stateDir), null)
  assert.equal(consoleMetadataPath(config.stateDir), join(config.stateDir, "console.json"))
  runtime.ledger.close()
})

test("Console chat streams a CEO interaction and decisions resolve gated actions", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-console-chat-"))
  const configPath = join(root, "goah.config.json")
  const config = { ...defaultConfig(root, { provider: "faux" }), stateDir: join(root, "state") }
  config.runnerProfiles![0]!.config = { provider: "faux", model: "faux-goah", fauxHandoff: { observations: ["oriented"], results: ["plan ready"], nextSteps: [], blocker: "waiting for data" } }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  const runtime = createRuntime(loadConfig(configPath))

  const controller = new AbortController()
  let resolveListening!: () => void
  const listening = new Promise<void>((resolve) => { resolveListening = resolve })
  const server = runWebConsole(runtime.supervisor, runtime.ledger, config.stateDir, controller.signal, { onListening: resolveListening })
  await listening
  const metadata = readConsoleMetadata(config.stateDir)
  assert.ok(metadata)
  try {
    const chatResponse = await fetch(`${metadata.url}api/chat?token=${metadata.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Operate the store" }),
    })
    assert.equal(chatResponse.status, 200)
    assert.match(chatResponse.headers.get("content-type") ?? "", /text\/event-stream/)
    const frames: Array<{ type: string; event?: { type: string } }> = []
    const text = await chatResponse.text()
    for (const chunk of text.split("\n\n")) {
      if (chunk.startsWith("data: ")) frames.push(JSON.parse(chunk.slice(6)))
    }
    assert.equal(frames.at(-1)?.type, "result")
    assert.ok(frames.some((frame) => frame.type === "accepted"))
    assert.equal(frames.some((frame) => frame.type === "event" && frame.event?.type === "handoff.recorded"), false)
    assert.equal(runtime.ledger.goals().length, 0)
    const second = await fetch(`${metadata.url}api/chat?token=${metadata.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Keep going" }),
    })
    const reader = second.body!.getReader()
    const firstChunk = new TextDecoder().decode((await reader.read()).value)
    assert.equal(firstChunk.includes('"accepted"'), true)
    await reader.cancel()
    assert.ok(runtime.ledger.turns().some((turn) => turn.source === "human"))

    const seed = runtime.ledger.appendEvent({ streamId: "control:test", ts: new Date().toISOString(), actor: "worker", type: "fact", data: { text: "evidence" } })
    const now=new Date().toISOString();runtime.ledger.putThread({id:"thread:worker",agent:"worker",parentThreadId:runtime.ledger.threads().find((thread)=>thread.agent==="ceo")!.id,createdAt:now,updatedAt:now},"supervisor");runtime.ledger.putTurn({id:"turn:worker",threadId:"thread:worker",source:"system",goalId:null,goalRevision:null,status:"in_progress",attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:new Date(Date.now()+60_000).toISOString(),leaseToken:"test",runnerPid:null},"supervisor");
    await runtime.supervisor.submitAction({ id: "web-action", agent: "worker", createdInTurn:"turn:worker",kind: "publish", payload: {}, reason: "publish needs review", evidence: [seed.seq], auditAdvice: null, adviceAcked: false }, "missing-connector")
    assert.equal(runtime.ledger.action("web-action")?.status, "requested")
    const decision = await fetch(`${metadata.url}api/action?token=${metadata.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "web-action", decision: "reject", reason: "not during the test", evidence: [seed.seq] }),
    })
    assert.equal(decision.status, 200)
    assert.equal(runtime.ledger.action("web-action")?.status, "failed")
  } finally {
    controller.abort()
    await server
    runtime.ledger.close()
  }
})
