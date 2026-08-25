import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react"
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  House,
  MessageCircle,
  RefreshCcw,
  Route,
  Search,
  Send,
  Settings,
  Users,
  X,
} from "lucide-react"

import { Accordion, Collapsible, Dialog, ScrollArea, Select, Tabs } from "./components/ui/primitives"
import { demoSnapshot } from "./demo"
import type { ConsoleSnapshot, EventView, GoalView, TeamView, ThreadDetailView, ThreadView, TrajectoryItemView, TrajectoryPageView, TurnItemView, TurnView } from "./types"

type View = "overview" | "chat" | "trajectory" | "thread" | "ledger" | "agents" | "settings"

const searchParams = new URLSearchParams(window.location.search)
const isDemo = searchParams.has("demo")
const requestedView = searchParams.get("view")
const initialView: View = requestedView && ["overview", "chat", "trajectory", "thread", "ledger", "agents", "settings"].includes(requestedView) ? requestedView as View : "overview"

export function App() {
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(isDemo ? demoSnapshot : null)
  const [view, setView] = useState<View>(initialView)
  const [selectedAgent, setSelectedAgent] = useState("growth")
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [connection, setConnection] = useState<"loading" | "live" | "error">(isDemo ? "live" : "loading")
  const [approvalsOpen, setApprovalsOpen] = useState(false)

  const load = useCallback(async () => {
    if (isDemo) return
    try {
      const response = await fetch("/api/snapshot", { cache: "no-store" })
      if (!response.ok) throw new Error(`snapshot request failed (${response.status})`)
      const next = await response.json() as ConsoleSnapshot
      setSnapshot(next); setConnection("live")
    } catch { setConnection("error") }
  }, [])

  useEffect(() => {
    if (isDemo) return
    let active = true
    void load()
    const timer = window.setInterval(load, 2_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [load])

  if (!snapshot) return <LoadingState connection={connection} />

  const root = snapshot.goals.find((goal) => goal.parentId === null) ?? snapshot.goals[0] ?? null
  const openThread = (threadId: string) => { setSelectedThreadId(threadId); setView("thread") }
  return (
    <div className="console-shell">
      <Sidebar view={view} onView={setView} />
      <main className="console-main">
        {connection === "error" && <div className="connection-banner">Live refresh paused. Retrying the local Supervisor…</div>}
        {view === "overview" && <Overview snapshot={snapshot} root={root} onView={setView} onTalk={() => setView("chat")} onApprovals={() => setApprovalsOpen(true)} />}
        {view === "chat" && <ChatView snapshot={snapshot} onRefresh={load} />}
        {view === "trajectory" && <OrganizationTrajectory snapshot={snapshot} onOpenThread={openThread} />}
        {view === "thread" && <ThreadTrace snapshot={snapshot} selectedThreadId={selectedThreadId} onSelectThread={setSelectedThreadId} onBack={() => setView("trajectory")} />}
        {view === "ledger" && <Ledger snapshot={snapshot} />}
        {view === "agents" && <Agents snapshot={snapshot} selected={selectedAgent} onSelect={setSelectedAgent} onOpenThread={openThread} />}
        {view === "settings" && <SettingsView snapshot={snapshot} />}
      </main>
      {approvalsOpen && <ApprovalDialog snapshot={snapshot} onRefresh={load} onClose={() => setApprovalsOpen(false)} />}
    </div>
  )
}

function Sidebar({ view, onView }: { view: View; onView(view: View): void }) {
  const items: Array<{ id: View; label: string; icon: typeof House }> = [
    { id: "overview", label: "Overview", icon: House },
    { id: "chat", label: "Chat", icon: MessageCircle },
    { id: "trajectory", label: "Trajectory", icon: Route },
    { id: "ledger", label: "Ledger", icon: Database },
    { id: "agents", label: "Agents", icon: Users },
  ]
  return (
    <aside className="sidebar">
      <div className="brand"><img src="/goah-orbital-mark.png" alt="" /><span>Goah Console</span></div>
      <nav aria-label="Console views">
        {items.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id || id === "trajectory" && view === "thread" ? "nav-item active" : "nav-item"} onClick={() => onView(id)}>
            <Icon aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </nav>
      <button className={view === "settings" ? "nav-item settings active" : "nav-item settings"} onClick={() => onView("settings")}>
        <Settings aria-hidden="true" /><span>Settings</span>
      </button>
      <div className="sidebar-status">
        <p><i className="health-dot" /> System healthy</p>
      </div>
    </aside>
  )
}

function Overview({ snapshot, root, onView, onTalk, onApprovals }: { snapshot: ConsoleSnapshot; root: GoalView | null; onView(view: View): void; onTalk(): void; onApprovals(): void }) {
  const children = snapshot.goals.filter((goal) => goal.parentId === root?.id)
  const ceo = snapshot.team.find((member) => member.agent === "ceo")
  const attention = snapshot.actions.filter((action) => ["requested", "unknown"].includes(action.status))
  const recoveredTurnIds=new Set(snapshot.wakes.flatMap((wake)=>wake.triggerRef.startsWith("recovery:")?[wake.triggerRef.slice("recovery:".length).split(":")[0]!]:[]));const recovery=snapshot.turns.filter((turn)=>turn.status==="failed"&&!recoveredTurnIds.has(turn.id)).map((turn)=>({turn,agent:snapshot.threads.find((thread)=>thread.id===turn.threadId)?.agent??"unknown"}));
  const trajectory = trajectoryEvents(snapshot.events).slice(-3).reverse()
  return (
    <div className="overview-layout">
      <section className="overview-content">
        <header className="goal-header">
          <p>Top-level goal</p>
          <div className="goal-header-row">
            <div className="goal-title-row">
              <h1>{root?.objective ?? "No active root goal"}</h1>
              {root && <><Status status={root.phase} /><span className="metadata">Rev {root.revision}</span></>}
            </div>
            <button className="header-action" onClick={onTalk}><MessageCircle /> Talk to CEO</button>
          </div>
          <p className="observation"><strong>Observation:</strong> {root?.observationMethod ?? "Waiting for the CEO to propose an observation method."}</p>
          {(attention[0] || recovery[0]) && <button type="button" className="attention-strip attention-link" onClick={onApprovals}>
            {attention[0] && <span><CircleAlert /> Approval needed: <strong>{attention[0].kind}</strong></span>}
            {recovery[0] && <span className="danger"><RefreshCcw /> Recovery needed: <strong>{displayAgent(recovery[0].agent)}</strong></span>}
          </button>}
        </header>

        <section className="organization" aria-labelledby="organization-title">
          <h2 id="organization-title" className="sr-only">Organization motion</h2>
          <div className="org-tree">
            <article className="tree-root">
              <img src="/goah-orbital-mark.png" alt="" />
              <div><strong>CEO</strong><span>{root?.objective ?? "Waiting for a root goal"}</span></div>
              <Status status={ceo?.status ?? "waiting"} />
            </article>
            <div className="tree-children">
              {children.map((goal) => <AgentTreeRow key={goal.id} goal={goal} member={snapshot.team.find((item) => item.agent === goal.owner)} now={snapshot.now} />)}
              {children.length === 0 && <Empty text="The CEO has not delegated child goals yet." />}
            </div>
          </div>
        </section>

        <section className="trajectory-preview">
          <div className="section-heading"><h2>Organization trajectory</h2><button onClick={() => onView("trajectory")}>View all</button></div>
          <div className="trajectory-list">
            {trajectory.map((event) => (
              <button key={event.seq} className="trajectory-row" onClick={() => onView("trajectory")}>
                <i className={`event-dot ${eventTone(event)}`} /><time>{formatTime(event.ts)}</time><span className="actor">{displayAgent(event.actor)}</span><strong>{eventNarrative(event)}</strong><small>Seq #{event.seq}</small>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>
  )
}

function AgentTreeRow({ goal, member, now }: { goal: GoalView; member?: TeamView; now: string }) {
  return (
    <article className="tree-agent">
      <Bot />
      <div><strong>{displayAgent(goal.owner)}</strong><span>{goal.objective}</span></div>
      <Status status={member?.status ?? goal.phase} />
      <small>{member?.nextWakeAt ? `Next ${formatTime(member.nextWakeAt)} · ${relativeTime(member.nextWakeAt, now)}` : ""}</small>
    </article>
  )
}

function OrganizationTrajectory({ snapshot, onOpenThread }: { snapshot: ConsoleSnapshot; onOpenThread(threadId: string): void }) {
  const [agent, setAgent] = useState("all")
  const [category, setCategory] = useState("all")
  const [remote, setRemote] = useState<TrajectoryPageView | null>(null)
  const [loading, setLoading] = useState(false)
  const local = organizationItems(snapshot).filter((item) => (agent === "all" || item.agent === agent) && (category === "all" || item.event.type.startsWith(`${category}.`)))

  useEffect(() => {
    if (isDemo) return
    let active = true
    setLoading(true)
    const params = new URLSearchParams({ limit: "100" })
    if (agent !== "all") params.set("agent", agent)
    if (category !== "all") params.set("type", category)
    void fetch(`/api/trajectory?${params}`, { cache: "no-store" }).then((response) => {
      if (!response.ok) throw new Error(`trajectory request failed (${response.status})`)
      return response.json() as Promise<TrajectoryPageView>
    }).then((page) => { if (active) setRemote(page) }).catch(() => { if (active) setRemote(null) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [agent, category])

  const items = isDemo ? local : remote?.items ?? local
  const loadOlder = async () => {
    if (!remote?.nextBeforeSeq || loading) return
    setLoading(true)
    const params = new URLSearchParams({ limit: "100", beforeSeq: String(remote.nextBeforeSeq) })
    if (agent !== "all") params.set("agent", agent)
    if (category !== "all") params.set("type", category)
    try {
      const response = await fetch(`/api/trajectory?${params}`, { cache: "no-store" })
      if (!response.ok) throw new Error(`trajectory request failed (${response.status})`)
      const page = await response.json() as TrajectoryPageView
      setRemote({ items: [...remote.items, ...page.items], nextBeforeSeq: page.nextBeforeSeq })
    } finally { setLoading(false) }
  }

  return <Page title="Organization trajectory" description="Goal, wake, handoff, mail, action, and observation milestones across every agent."><div className="org-trajectory-toolbar"><TrajectorySelect label="Agent" value={agent} onValueChange={setAgent} options={[{ value: "all", label: "All agents" }, ...snapshot.team.map((member) => ({ value: member.agent, label: displayAgent(member.agent) }))]} /><TrajectorySelect label="Event" value={category} onValueChange={setCategory} options={[{ value: "all", label: "All milestones" }, ...["goal", "delegation", "wake", "handoff", "mail", "schedule", "action", "metric"].map((value) => ({ value, label: capitalize(value) }))]} /></div><div className="org-event-list">{items.map((item) => <OrganizationEvent key={item.event.seq} item={item} wake={item.wakeId ? snapshot.wakes.find((wake) => wake.id === item.wakeId) : undefined} thread={item.wakeId ? threadForWake(snapshot, item.wakeId) : undefined} onOpenThread={onOpenThread} />)}{!items.length && <Empty text="No organization milestones match these filters." />}</div>{remote?.nextBeforeSeq && <button className="load-older" disabled={loading} onClick={loadOlder}>{loading ? "Loading…" : "Load older events"}</button>}</Page>
}

function TrajectorySelect({ label, value, onValueChange, options }: { label: string; value: string; onValueChange(value: string): void; options: Array<{ value: string; label: string }> }) {
  return <div className="trajectory-filter"><span>{label}</span><Select.Root value={value} onValueChange={onValueChange}><Select.Trigger aria-label={label}><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="thread-select-content" position="popper" sideOffset={6}><Select.Viewport>{options.map((option) => <Select.Item className="thread-select-item" value={option.value} key={option.value}><Select.ItemText>{option.label}</Select.ItemText><Select.ItemIndicator className="thread-check"><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>
}

function OrganizationEvent({ item, wake, thread, onOpenThread }: { item: TrajectoryItemView; wake?: ConsoleSnapshot["wakes"][number]; thread?: ThreadView; onOpenThread(threadId: string): void }) {
  return <article className="org-event"><time>{formatDateTime(item.event.ts)}</time><i className={`event-dot ${eventTone(item.event)}`} /><div><header><strong>{displayAgent(item.agent)}</strong><span>{item.event.type}</span></header><p>{eventNarrative(item.event, item.agent)}</p><small>Seq #{item.event.seq}</small></div>{thread && <button onClick={() => onOpenThread(thread.id)}>Thread<ChevronRight /></button>}{wake && <Status status={wake.status} />}</article>
}

function ThreadTrace({ snapshot, selectedThreadId, onSelectThread, onBack }: { snapshot: ConsoleSnapshot; selectedThreadId: string | null; onSelectThread(threadId: string): void; onBack(): void }) {
  const threads = [...snapshot.threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const selected = threads.find((thread) => thread.id === selectedThreadId) ?? threads.find((thread) => snapshot.turns.some((turn) => turn.threadId === thread.id && turn.status === "in_progress")) ?? threads[0]
  const [query, setQuery] = useState("")
  const [remoteThread, setRemoteThread] = useState<ThreadDetailView | null>(null)
  useEffect(() => {
    if (!selected) return
    if (isDemo) { setRemoteThread(demoThreadDetail(snapshot, selected)); return }
    let active = true
    const load = async () => {
      const response = await fetch(`/api/threads/${encodeURIComponent(selected.id)}`, { cache: "no-store" })
      if (!response.ok) return
      const thread = await response.json() as ThreadDetailView
      if (active) setRemoteThread(thread)
    }
    void load()
    const timer = window.setInterval(load, 2_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [selected?.id])
  const detail = remoteThread?.thread.id === selected?.id ? remoteThread : null
  const turns = detail?.turns ?? []
  const items = turns.flatMap((turn) => turn.items)
  const visibleTurns = turns.map((turn) => ({ ...turn, items: turn.items.filter((item) => `${item.type} ${JSON.stringify(item.data)}`.toLowerCase().includes(query.toLowerCase())) })).filter((turn) => turn.items.length)
  const calls = items.filter((item) => item.type === "tool_call").length
  const selectThread = (threadId: string) => { setQuery(""); setRemoteThread(null); onSelectThread(threadId) }
  return (
    <Page title="Thread" description="A durable agent conversation, organized into turns and typed items.">
      <button className="back-to-trajectory" onClick={onBack}><ArrowLeft /> Organization trajectory</button>
      <div className="trace-toolbar">
        <div className="thread-field"><span>Thread</span><Select.Root value={selected?.id ?? ""} onValueChange={selectThread}><Select.Trigger className="thread-select" aria-label="Thread"><Select.Value /><Select.Icon><ChevronDown /></Select.Icon></Select.Trigger><Select.Portal><Select.Content className="thread-select-content" position="popper" sideOffset={6}><Select.Viewport>{threads.map((thread) => <Select.Item className="thread-select-item" value={thread.id} key={thread.id}><Select.ItemText>{displayAgent(thread.agent)} · {thread.id}</Select.ItemText><Select.ItemIndicator className="thread-check"><Check /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal></Select.Root></div>
        <div className="trace-stats"><span><Clock3 /> {threadDuration(turns)}</span><span><Route /> {turns.length} turns</span><span><Activity /> {calls} calls</span></div>
        <label className="trace-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this thread" /></label>
      </div>
      {!selected || items.length === 0 ? <ThreadEmptyState /> : visibleTurns.length === 0 ? <TraceNoResults query={query} /> : <ThreadTurnList turns={visibleTurns} />}
    </Page>
  )
}

function ThreadTurnList({ turns }: { turns: Array<TurnView & { items: TurnItemView[] }> }) {
  return <section className="trace-surface"><ScrollArea.Root className="trace-scroll"><ScrollArea.Viewport><div className="trace-list">{turns.map((turn, index) => <div className="thread-turn" key={turn.id}><header><span>Turn {index + 1}</span><code>{turn.id}</code><Status status={turn.status} /><time>{formatDateTime(turn.startedAt)}</time></header>{turn.items.map((item) => <ThreadItemRow item={item} key={item.id} />)}</div>)}</div></ScrollArea.Viewport><ScrollArea.Scrollbar className="trace-scrollbar" orientation="vertical"><ScrollArea.Thumb /></ScrollArea.Scrollbar></ScrollArea.Root></section>
}

function ThreadItemRow({ item }: { item: TurnItemView }) {
  const label = item.type.replaceAll("_", " ")
  const row = <><span className={`trace-kind trace-${itemTone(item.type)}`}>{label}</span><div className="trace-content"><strong>{turnItemText(item)}</strong></div><time>{formatTime(item.createdAt)}</time><code className="trace-seq">#{item.ordinal}</code></>
  if (!item.type.startsWith("tool_")) return <div className="thread-item">{row}</div>
  return <Collapsible.Root><Collapsible.Trigger className="thread-item trace-row-trigger" aria-label={`Show payload for ${label}`}>{row}<ChevronRight className="trace-expand" /></Collapsible.Trigger><Collapsible.Content className="trace-payload"><TracePayload value={item.data} /></Collapsible.Content></Collapsible.Root>
}

function ThreadEmptyState() {
  return <section className="trace-empty-state"><Activity /><h2>No thread items yet</h2><p>The first user message, model response, reasoning block, or tool call will appear here when a turn begins.</p></section>
}

function TraceNoResults({ query }: { query: string }) {
  return <section className="trace-no-results"><Search /><p>No events match “{query}”.</p></section>
}

function Ledger({ snapshot }: { snapshot: ConsoleSnapshot }) {
  const [mode, setMode] = useState<"work" | "raw">("work")
  const [filter, setFilter] = useState("all")
  const [query, setQuery] = useState("")
  const records = snapshot.events.filter((event) => event.type === "handoff.recorded" && `${event.actor} ${JSON.stringify(event.data)}`.toLowerCase().includes(query.toLowerCase())).reverse()
  const filtered = snapshot.events.filter((event) => (filter === "all" || event.type.startsWith(`${filter}.`)) && `${event.actor} ${event.type} ${event.streamId} ${JSON.stringify(event.data)}`.toLowerCase().includes(query.toLowerCase())).reverse()
  return (
    <Page title="Work Ledger" description="Agent-authored records. Raw events remain available for audit.">
      <Tabs.Root value={mode} onValueChange={(value) => setMode(value as "work" | "raw")}>
        <div className="ledger-mode"><Tabs.List aria-label="Ledger view"><Tabs.Trigger value="work">Work records</Tabs.Trigger><Tabs.Trigger value="raw">Raw events</Tabs.Trigger></Tabs.List><label><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={mode === "work" ? "Search work records" : "Search events"} /></label></div>
        <Tabs.Content value="work"><div className="work-ledger">{records.map((event) => <WorkRecord key={event.seq} event={event} onRaw={() => setMode("raw")} />)}{!records.length && <Empty text="No agent-authored work records yet." />}</div></Tabs.Content>
        <Tabs.Content value="raw"><div className="ledger-toolbar"><div>{["all", "goal", "wake", "mail", "action", "thread", "turn", "item", "transcript"].map((item) => <button className={filter === item ? "selected" : ""} key={item} onClick={() => setFilter(item)}>{capitalize(item)}</button>)}</div></div><div className="ledger-table" role="table"><div className="ledger-head" role="row"><span>Seq</span><span>Local time</span><span>Stream</span><span>Actor</span><span>Event</span><span>Fact</span></div>{filtered.map((event) => <div className="ledger-row" role="row" key={event.seq}><code>{event.seq}</code><time>{formatTime(event.ts)}</time><code>{event.streamId}</code><span>{displayAgent(event.actor)}</span><strong>{event.type}</strong><span>{summarize(event.data)}</span></div>)}{!filtered.length && <Empty text="No matching events." />}</div></Tabs.Content>
      </Tabs.Root>
    </Page>
  )
}

function Agents({ snapshot, selected, onSelect, onOpenThread }: { snapshot: ConsoleSnapshot; selected: string; onSelect(agent: string): void; onOpenThread(threadId: string): void }) {
  const member = snapshot.team.find((item) => item.agent === selected) ?? snapshot.team[0]
  const goals = snapshot.goals.filter((goal) => goal.owner === member?.agent)
  const threads = snapshot.threads.filter((thread) => thread.agent === member?.agent).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const workRecords = snapshot.events.filter((event) => event.actor === member?.agent && event.type === "handoff.recorded").reverse()
  return (
    <Page title="Agents">
      <div className="agents-workbench">
        <div className="agent-roster">{snapshot.team.map((item) => <button key={item.agent} className={item.agent === member?.agent ? "selected" : ""} onClick={() => onSelect(item.agent)}><Bot /><span><strong>{displayAgent(item.agent)}</strong><small>{snapshot.goals.find((goal) => goal.owner === item.agent)?.objective ?? "No owned goal"}</small></span><Status status={item.status} /></button>)}</div>
        {member && <div className="agent-detail"><div className="agent-detail-head"><Bot /><div><h2>{displayAgent(member.agent)}</h2><Status status={member.status} /></div></div><section><h3>Owned goals</h3>{goals.map((goal) => <div className="owned-goal" key={goal.id}><strong>{goal.objective}</strong><span>{goal.observationMethod ?? "Observation method pending"}</span></div>)}</section><section><h3>Threads</h3><div className="thread-list">{threads.map((thread) => <button key={thread.id} onClick={() => onOpenThread(thread.id)}><span><strong>{thread.id}</strong><small>{formatDateTime(thread.updatedAt)}</small></span><ChevronRight /></button>)}{!threads.length && <Empty text="No threads for this agent yet." />}</div></section><section><h3>Work records</h3>{workRecords.map((event) => { const thread = event.streamId.startsWith("wake:") ? threadForWake(snapshot, event.streamId.slice("wake:".length)) : undefined; return <WorkRecord key={event.seq} event={event} compact onOpen={thread ? () => onOpenThread(thread.id) : undefined} /> })}{!workRecords.length && <Empty text="No agent-authored work records yet." />}</section></div>}
      </div>
    </Page>
  )
}

function TracePayload({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false)
  const text = formatPayload(value)
  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_200)
  }
  return <div className="trace-payload-inner"><header><span>Full payload</span><button onClick={copy}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</button></header><pre><code>{text}</code></pre></div>
}

function WorkRecord({ event, compact = false, onOpen, onRaw }: { event: EventView; compact?: boolean; onOpen?: () => void; onRaw?: () => void }) {
  const data = record(event.data)
  const observations = stringArray(data.observations)
  const results = stringArray(data.results)
  const nextSteps = stringArray(data.nextSteps)
  const blocker = typeof data.blocker === "string" ? data.blocker : null
  const summary = results[0] ?? observations[0] ?? "Work recorded"
  return <Accordion.Root className={compact ? "work-record compact" : "work-record"} type="single" collapsible><Accordion.Item value={`record-${event.seq}`}><Accordion.Header><Accordion.Trigger className="work-record-summary"><Bot /><span className="record-agent"><strong>{displayAgent(event.actor)}</strong><small>{formatDateTime(event.ts)} · #{event.seq}</small></span><span className="record-outcome">{summary}</span>{nextSteps[0] && <span className="record-next">Next: {nextSteps[0]}</span>}<ChevronRight /></Accordion.Trigger></Accordion.Header><Accordion.Content className="work-record-content"><div className="work-record-body"><RecordSection title="Observed" values={observations} /><RecordSection title="Completed" values={results} /><RecordSection title="Next" values={nextSteps} />{blocker && <RecordSection title="Blocked" values={[blocker]} tone="danger" />}</div>{(onOpen || onRaw) && <footer>{onOpen && <button onClick={onOpen}>Open thread</button>}{onRaw && <button onClick={onRaw}>Raw events</button>}</footer>}</Accordion.Content></Accordion.Item></Accordion.Root>
}

function RecordSection({ title, values, tone }: { title: string; values: string[]; tone?: string }) {
  if (!values.length) return null
  return <section className={tone === "danger" ? "record-section danger" : "record-section"}><h3>{title}</h3>{values.map((value) => <p key={value}>{value}</p>)}</section>
}

function SettingsView({ snapshot }: { snapshot: ConsoleSnapshot }) {
  return <Page title="Settings" description="Local Console runtime details. Agent and connector configuration remains authoritative in goah.config.json."><div className="settings-list"><div><span>Mode</span><strong>Local, loopback only</strong></div><div><span>Refresh</span><strong>Every 2 seconds</strong></div><div><span>Latest event</span><strong>Seq #{snapshot.seq}</strong></div><div><span>Event payloads</span><strong>Redacted by default</strong></div></div></Page>
}

type ChatExchange = { kind: "user" | "ceo"; seq: number; turnId?:string; text: string; handoff?: { observations: string[]; results: string[]; nextSteps: string[]; blocker?: string;goalId?:string;outcome?:string;recordRevision?:number } }
type LiveChat = { status: "running" | "done" | "error";turnId:string|null;prompt:string; text: string; lines: string[]; handoff: ChatExchange["handoff"] }

function chatHistory(snapshot: ConsoleSnapshot): ChatExchange[] {
  const items: ChatExchange[] = [];const ceoThreadIds=new Set(snapshot.threads.filter((thread)=>thread.agent==="ceo").map((thread)=>thread.id));const humanTurnIds=new Set(snapshot.turns.filter((turn)=>turn.source==="human"&&ceoThreadIds.has(turn.threadId)).map((turn)=>turn.id));const messageItems=new Map<string,{seq:number;item:Record<string,unknown>}>();
  for (const event of snapshot.events) {
    if(event.type.startsWith("item.user_message.")||event.type.startsWith("item.assistant_message.")){const item=record(record(event.data).snapshot);if(typeof item.id==="string")messageItems.set(item.id,{seq:event.seq,item});}
    else if (event.type === "handoff.recorded" && event.actor === "ceo") {
      items.push({ kind: "ceo", seq: event.seq,turnId:event.streamId.startsWith("turn:")?event.streamId.slice(5):undefined, text: "", handoff: handoffOf(event.data) })
    }
  }
  for(const {seq,item} of messageItems.values()){if(item.status!=="completed"||!humanTurnIds.has(String(item.turnId)))continue;const data=record(item.data);if(typeof data.text==="string")items.push({kind:item.type==="user_message"?"user":"ceo",seq,turnId:String(item.turnId),text:data.text});}
  return items.sort((a, b) => a.seq - b.seq)
}

function ChatView({ snapshot, onRefresh }: { snapshot: ConsoleSnapshot; onRefresh(): void }) {
  const history = useMemo(() => chatHistory(snapshot), [snapshot])
  const [draft, setDraft] = useState("")
  const [live, setLive] = useState<LiveChat | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }) }, [history.length, live?.text, live?.lines.length])

  const send = async () => {
    const message = draft.trim()
    if (!message || live?.status === "running") return
    setDraft("")
    setLive({ status: "running",turnId:null,prompt:message, text: "", lines: ["CEO Turn started"], handoff: undefined })
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) })
      if (!response.ok || !response.body) throw new Error(`chat request failed (${response.status})`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const chunks = buffer.split("\n\n")
        buffer = chunks.pop() ?? ""
        for (const chunk of chunks) {
          if (!chunk.startsWith("data: ")) continue
          applyFrame(JSON.parse(chunk.slice(6)) as ChatFrame, setLive)
        }
      }
    } catch {
      setLive((current) => current && { ...current, status: "error", lines: [...current.lines, "连接中断"] })
    } finally {
      setLive((current) => current && current.status === "running" ? { ...current, status: "done" } : current)
      onRefresh()
    }
  }

  return (
    <section className="chat">
      <header className="chat-header">
        <div>
          <h1>CEO</h1>
          <p>Messages start or steer a durable CEO Turn. Goal tools add strict Work Record and Handoff policy only when needed.</p>
        </div>
        <span className={`chat-live-pill ${live?.status === "running" ? "busy" : ""}`}>{live?.status === "running" ? "Working…" : "Ready"}</span>
      </header>
      <div className="chat-scroll">
        {history.length === 0 && !live && <p className="chat-empty">还没有对话。说一句话开始一个 durable CEO Turn。</p>}
        {history.filter((item)=>!live?.turnId||item.turnId!==live.turnId).map((item) => item.kind === "user"
          ? <article key={item.seq} className="chat-entry user"><p>{item.text}</p><small>You · #{item.seq}</small></article>
          : <article key={item.seq} className="chat-entry ceo">{item.text&&<p>{item.text}</p>}{item.handoff && <HandoffBlock handoff={item.handoff} seq={item.seq} />}</article>)}
        {live&&<article className="chat-entry user"><p>{live.prompt}</p><small>You</small></article>}
        {live && <article className="chat-entry ceo live">
          {live.lines.length > 0 && <div className="chat-activity">{live.lines.map((line) => <span key={line}>{line}</span>)}</div>}
          {live.text && <p className="chat-stream">{live.text}</p>}
          {live.handoff && <HandoffBlock handoff={live.handoff} seq={0} />}
          {live.status === "error" && <p className="chat-error">连接中断，wake 结果以账本为准。</p>}
        </article>}
        <div ref={bottom} />
      </div>
      <footer className="chat-input-bar">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send() }} placeholder="改变目标、报告约束、或问下一步会发生什么…" disabled={live?.status === "running"} />
        <div>
          <span>⌘↩ 发送 · start / steer CEO Turn</span>
          <button className="primary" disabled={!draft.trim() || live?.status === "running"} onClick={() => void send()}><Send /> 发送</button>
        </div>
      </footer>
    </section>
  )
}

type ChatFrame = { type: "accepted" | "result" | "error" | "event"; turnId?: string; value?: unknown; event?: EventView; error?: string }

function applyFrame(frame: ChatFrame, setLive: Dispatch<SetStateAction<LiveChat | null>>): void {
  if (frame.type === "accepted") {setLive((current)=>current&&{...current,turnId:frame.turnId??current.turnId});return}
  if (frame.type === "error") { setLive((current) => current && { ...current, status: "error", lines: [...current.lines, frame.error ?? "error"] }); return }
  if (frame.type === "result") {
    const value = record(frame.value)
    const turn = record(value.turn) as { status?: unknown }
    const response=record(value.response);setLive((current) => current && { ...current, status: turn.status==="failed"||turn.status==="interrupted"?"error":"done",text:current.text||(typeof response.content==="string"?response.content:""), lines: [...current.lines, `Turn ${String(turn.status ?? "finished")}`] })
    return
  }
  const event = frame.event
  if (!event) return
  if (event.type === "message.assistant.completed") {
    const text = messageContent(record(event.data).message)
    if (text) setLive((current) => current && { ...current, text })
  } else if (event.type === "message.assistant.delta") {
    const delta = record(record(event.data).delta)
    const text = delta.type === "text_delta"&&typeof delta.delta === "string" ? delta.delta : null
    if (text) setLive((current) => current && { ...current, text: current.text + text })
  } else if (event.type === "tool.called") {
    const data = record(event.data)
    setLive((current) => current && { ...current, lines: [...current.lines, `→ ${String(data.name ?? "tool")}`] })
  } else if (event.type === "handoff.recorded") {
    setLive((current) => current && { ...current, handoff: handoffOf(event.data) })
  } else if (event.type === "transcript.interrupted") {
    setLive((current) => current && { ...current, lines: [...current.lines, `! ${JSON.stringify(event.data)}`] })
  }
}

function HandoffBlock({ handoff, seq }: { handoff: NonNullable<ChatExchange["handoff"]>; seq: number }) {
  return (
    <div className="chat-handoff">
      {handoff.goalId&&<section><h3>{handoff.outcome?.replaceAll("_"," ")??"Goal updated"}</h3><p>{handoff.goalId}{handoff.recordRevision!==undefined?` · Work Record r${handoff.recordRevision}`:""}</p></section>}
      {handoff.observations.length > 0 && <section><h3>Observed</h3>{handoff.observations.map((value) => <p key={value}>{value}</p>)}</section>}
      {handoff.results.length > 0 && <section><h3>Completed</h3>{handoff.results.map((value) => <p key={value}>{value}</p>)}</section>}
      {handoff.nextSteps.length > 0 && <section><h3>Next</h3>{handoff.nextSteps.map((value) => <p key={value}>{value}</p>)}</section>}
      {handoff.blocker && <section className="danger"><h3>Blocked</h3><p>{handoff.blocker}</p></section>}
      {seq > 0 && <small>Handoff · #{seq}</small>}
    </div>
  )
}

function ApprovalDialog({ snapshot, onRefresh, onClose }: { snapshot: ConsoleSnapshot; onRefresh(): void; onClose(): void }) {
  const pending = snapshot.actions.filter((action) => ["requested", "unknown"].includes(action.status))
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const decide = async (id: string, decision: "approve" | "reject") => {
    const action = pending.find((item) => item.id === id)
    if (!action) return
    const reason = (reasons[id] ?? "").trim() || (decision === "approve" ? "Approved from Console" : "Rejected from Console")
    setBusy(id)
    try {
      const response = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, decision, reason, evidence: action.evidence }) })
      if (!response.ok) throw new Error("decision failed")
      onRefresh()
    } catch { window.alert("提交失败，请重试") } finally { setBusy(null) }
  }
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal><Dialog.Overlay className="modal-backdrop" /><Dialog.Content className="approval-dialog">
        <Dialog.Close className="close" aria-label="Close"><X /></Dialog.Close>
        <Dialog.Title>需要决策的动作</Dialog.Title>
        <Dialog.Description className="sr-only">审查外部动作的理由和证据，然后批准或拒绝。</Dialog.Description>
        {pending.length === 0 && <p className="chat-empty">没有待决策动作。</p>}
        {pending.map((action) => (
          <article key={action.id} className="approval-card">
            <header><strong>{action.kind}</strong><span className={`status ${action.status === "unknown" ? "status-blocked" : ""}`}><i />{action.status}</span></header>
            <dl>
              <div><dt>Agent</dt><dd>{displayAgent(action.agent)}</dd></div>
              <div><dt>Connector</dt><dd>{action.connector}</dd></div>
              <div><dt>Evidence</dt><dd>{action.evidence.join(", ") || "none"}</dd></div>
            </dl>
            <p className="approval-reason">{action.reason}</p>
            <textarea value={reasons[action.id] ?? ""} onChange={(event) => setReasons((current) => ({ ...current, [action.id]: event.target.value }))} placeholder="你的决定理由（默认提供一条）" />
            <footer>
              <button className="primary" disabled={busy === action.id} onClick={() => void decide(action.id, "approve")}><Check /> 批准</button>
              <button className="reject" disabled={busy === action.id} onClick={() => void decide(action.id, "reject")}>拒绝</button>
            </footer>
          </article>
        ))}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  )
}

function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <section className="page"><header><h1>{title}</h1>{description && <span>{description}</span>}</header>{children}</section>
}

function Status({ status }: { status: string }) { return <span className={`status status-${status}`}><i />{capitalize(status.replaceAll("_", " "))}</span> }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p> }

function LoadingState({ connection }: { connection: string }) { return <main className="loading"><img src="/goah-orbital-mark.png" alt="" /><h1>Goah Console</h1><p>{connection === "error" ? "Could not reach the local Supervisor." : "Connecting to the local Supervisor…"}</p></main> }
function trajectoryEvents(events: EventView[]): EventView[] { return events.filter((event) => isOrganizationEvent(event.type)) }
function organizationItems(snapshot: ConsoleSnapshot): TrajectoryItemView[] {
  const wakeAgents = new Map(snapshot.wakes.map((wake) => [wake.id, wake.agent]))
  return trajectoryEvents(snapshot.events).slice().reverse().map((event) => {
    const wakeId = event.streamId.startsWith("wake:") ? event.streamId.slice("wake:".length) : null
    return { event, wakeId, agent: wakeId ? wakeAgents.get(wakeId) ?? event.actor : event.actor }
  })
}
function isOrganizationEvent(type: string): boolean { return ["goal.", "delegation.", "handoff.", "wake.", "mail.", "schedule.", "action.", "metric.", "observation.", "ceo.", "human."].some((prefix) => type.startsWith(prefix)) }
function eventNarrative(event: EventView, resolvedAgent = event.actor): string {
  const data = record(event.data)
  if (event.type === "handoff.recorded") return `Handoff: ${firstString(data.results) || firstString(data.observations) || "work recorded"}`
  if (event.type === "goal.delegated") return `CEO delegated: ${String(data.reason ?? data.goalId ?? "child goal")}`
  if (event.type === "delegation.created") return `Delegated a child goal: ${String(data.reason ?? data.goalId ?? "new responsibility")}`
  if (event.type === "goal.changed") { const snapshot = record(data.snapshot); return `Goal ${String(data.operation??snapshot.phase??"updated")}: ${String(snapshot.objective ?? "goal state changed")}` }
  if (event.type === "goal.reassigned") return `Reassigned goal from ${displayAgent(String(data.oldOwner ?? "unknown"))} to ${displayAgent(String(data.newOwner ?? "unknown"))}`
  if (event.type === "metric.evaluated" || event.type === "observation.confirmed") return `Observation confirmed: ${String(data.summary ?? data.status ?? "evidence recorded")}`
  if (event.type === "action.requested") return `Action awaiting approval: ${String(data.kind ?? "external action")}`
  if (event.type === "wake.enqueued") return "Wake queued"
  if (event.type === "wake.claimed") return "Wake claimed"
  if (event.type === "wake.consumed") return "Wake created a Turn"
  if (event.type === "wake.cancelled") return "Wake cancelled"
  if (event.type === "schedule.put") { const snapshot = record(data.snapshot); return `Next wake scheduled for ${formatDateTime(String(snapshot.nextWakeAt ?? ""))}: ${String(snapshot.reason ?? "scheduled work")}` }
  if (event.type === "mail.put") { const snapshot = record(data.snapshot); return `Mail from ${displayAgent(String(snapshot.from ?? event.actor))} to ${displayAgent(String(snapshot.to ?? "unknown"))}` }
  if (event.type === "mail.sent" || event.type === "mail.delivered") return `Mail delivered: ${String(data.summary ?? data.level ?? "message")}`
  return `${event.type.replaceAll(".", " ")}: ${summarize(event.data)}`
}
function eventTone(event: EventView): string { if (event.type.includes("abnormal") || event.type.includes("failed")) return "danger"; if (event.type.startsWith("action.")) return "attention-tone"; if (event.type.startsWith("metric.") || event.type.includes("confirmed")) return "success"; return "active-tone" }
function displayAgent(value: string): string { if (value === "ceo") return "CEO"; if (value === "human") return "Human"; if (value === "supervisor") return "Supervisor"; return `${capitalize(value.replaceAll("-", " "))} Agent` }
function capitalize(value: string): string { return value ? value[0]!.toUpperCase() + value.slice(1) : value }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) }
function formatDateTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) }
function relativeTime(value: string, from = new Date().toISOString()): string { const minutes = Math.round((new Date(value).getTime() - new Date(from).getTime()) / 60_000); return minutes > 0 ? `in ${minutes}m` : minutes === 0 ? "now" : `${Math.abs(minutes)}m ago` }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }

function handoffOf(value: unknown): NonNullable<ChatExchange["handoff"]> {
  const handoff = record(value)
  return {
    observations: stringList(handoff.observations),
    results: stringList(handoff.results),
    nextSteps: stringList(handoff.nextSteps),
    ...(typeof handoff.goalId==="string"?{goalId:handoff.goalId}:{}),
    ...(typeof handoff.outcome==="string"?{outcome:handoff.outcome}:{}),
    ...(typeof handoff.recordRevision==="number"?{recordRevision:handoff.recordRevision}:{}),
    ...(typeof handoff.blocker === "string" && handoff.blocker ? { blocker: handoff.blocker } : {}),
  }
}

function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function firstString(value: unknown): string { return Array.isArray(value) && typeof value[0] === "string" ? value[0] : "" }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function messageContent(value: unknown): string { const message = record(value); const content = message.content; if (typeof content === "string") return content; if (!Array.isArray(content)) return "Message recorded"; return content.map((item) => typeof item === "string" ? item : typeof item === "object" && item !== null && "text" in item ? String((item as { text?: unknown }).text ?? "") : "").filter(Boolean).join(" ") }
function threadForWake(snapshot: ConsoleSnapshot, wakeId: string): ThreadView | undefined { const wake=snapshot.wakes.find((candidate)=>candidate.id===wakeId);const turn = wake?.turnId?snapshot.turns.find((candidate) => candidate.id === wake.turnId):undefined; return turn ? snapshot.threads.find((thread) => thread.id === turn.threadId) : undefined }
function threadDuration(turns: TurnView[]): string { if (!turns.length) return "0s"; const start = new Date(turns[0]!.startedAt).getTime(); const end = new Date(turns.at(-1)!.endedAt ?? turns.at(-1)!.startedAt).getTime(); const seconds = Math.max(0, Math.round((end - start) / 1_000)); return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s` }
function itemTone(type: TurnItemView["type"]): string { if (type === "user_message") return "user"; if (type === "assistant_message" || type === "reasoning") return "assistant"; if (type.startsWith("tool_")) return "tool"; if (type === "handoff") return "handoff"; return "context" }
function turnItemText(item: TurnItemView): string {
  const data = record(item.data)
  if (typeof data.text === "string") return data.text
  if (item.type === "tool_call") return `${String(data.tool ?? "tool")} called`
  if (item.type === "tool_result") return `${String(data.callId ?? "tool")} returned ${summarize(data.result)}`
  if (item.type === "handoff") return firstString(data.results) || firstString(data.observations) || "Work record updated"
  return summarize(item.data)
}
function demoThreadDetail(snapshot: ConsoleSnapshot, thread: ThreadView): ThreadDetailView {
  const turns = snapshot.turns.filter((turn) => turn.threadId === thread.id).map((turn) => {
    const events = snapshot.events.filter((event) => event.streamId === `wake:${turn.id}`)
    const items = events.flatMap((event, index): TurnItemView[] => {
      const data = record(event.data)
      let type: TurnItemView["type"] | null = null
      let itemData = event.data
      if (event.type === "message.user") { type = "user_message"; itemData = { text: messageContent(data.message) } }
      else if (event.type === "message.assistant.completed") { type = "assistant_message"; itemData = { text: messageContent(data.message) } }
      else if (event.type === "tool.called") { type = "tool_call"; itemData = { tool: String(data.name ?? "tool"), arguments: (data.arguments ?? null) as TurnItemView["data"] } }
      else if (event.type === "tool.completed") { type = "tool_result"; itemData = { callId: String(data.callId ?? "tool"), result: (data.result ?? null) as TurnItemView["data"] } }
      else if (event.type === "handoff.recorded") type = "handoff"
      if (!type) return []
      return [{ id: `demo:${event.seq}`, turnId: turn.id, ordinal: index + 1, type, status: "completed", data: itemData, createdAt: event.ts, completedAt: event.ts }]
    })
    return { ...turn, items }
  })
  return { thread, turns }
}
function summarize(value: unknown): string { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > 110 ? `${text.slice(0, 107)}…` : text }
function formatPayload(value: unknown): string { return typeof value === "string" ? value : JSON.stringify(value, null, 2) }
