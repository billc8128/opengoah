# Goah TUI v2 — Turn-first presentation

Status: design proposal and interactive demo; no production behavior changes.

## Design intent

The TUI should answer three questions at a glance:

1. What did I ask?
2. What is Goah doing now?
3. What is the answer or next decision?

The current event stream already distinguishes Human messages, reasoning, tools,
Assistant messages, Handoffs, and errors. The presentation must preserve that
structure instead of flattening every event into one transcript log.

## Presentation model

```ts
interface TurnPresentation {
  id: string;
  user: UserBlock;
  activity: ActivityBlock;
  response?: AssistantBlock;
  receipt?: ReceiptBlock;
}
```

System notices that do not belong to a Turn remain separate `NoticeBlock`s. The
view groups consecutive tool calls inside one Activity block and never stores
thinking as a peer of an Assistant response.

## Visual grammar

| Content | Default treatment | Expanded treatment |
| --- | --- | --- |
| Human message | Full-width, low-chroma tinted row; no `You` label | Same |
| Thinking | One summary row: elapsed time, step count, latest useful action | Full reasoning inside the Activity surface |
| Tools | Running and failed rows visible; completed rows summarized | All rows with target, result summary, and duration |
| Assistant response | Highest-contrast prose with a one-cell accent rail | Same |
| Error | Dedicated error surface with cause and recovery action | Optional technical detail |
| Handoff / Goal update | Compact receipt after the response | `/status` carries full metadata |
| System notice | One neutral line outside the Turn | N/A |

Color reinforces structure but never carries it alone. Prefixes, indentation,
spacing, and wording remain meaningful under `NO_COLOR`.

## Turn rhythm

```text
[ Human message background ]

◇ Thinking summary                            Ctrl+O details
  Tools 3 · 2 done · 1 running

│ Assistant response
│ continues here

✓ Goal progress saved · Work Record r7 · next wake 10:00


[ Next Human message ]
```

- Two blank lines separate Turns.
- Activity is visually subordinate to the response.
- Thinking never streams as an unbounded wall. While active, it exposes only a
  bounded latest-action summary; `Ctrl+O` toggles Turn details.
- Running and failed tools never collapse. Completed tools may collapse into the
  Activity summary after the response commits.

## Tool rows

Tool rows use four stable columns when width permits:

```text
✓ ledger_search       “余额 ~ 40.40”                 420ms
● work_record_update  updating r7…                    08s
× bash                npm test · exit 1              1.2s
```

At narrow widths, duration drops first, then the result wraps below the tool
name. The tool result should provide a bounded human-readable summary; raw output
stays available through detail expansion or Thread inspection.

## Status architecture

The header contains stable identity only:

```text
 GOAH  pi · ark/glm-5.3                                      v0.13.8
```

The bottom rail is an organization summary rendered into one stable row. Live
Turn state remains in the Ledger transcript instead of competing with durable
context:

```text
 GOAL baseline verification │ MODEL ark/glm-5.3 │ CHILD 2 │ WAKE tomorrow 10:00
```

Fields:

| Field | Meaning |
| --- | --- |
| `GOAL` | Short title of the active Root; `CHAT` when no Goal is active |
| `MODEL` | Current Runner Profile target; refreshed after `/model` and `/setup` |
| `CHILD` | Active Child Agents participating in the current Root, excluding the CEO |
| `WAKE` | Earliest pending wake across the current Root Goal tree; `—` when none exists |

Full objective, Agent identities, later wakes, Human actions, evidence, and Work
Record metadata belong in `/status`, not the persistent rail. Human actions stay
out of the status line until they have a real structured read model.

The input remains one Human message channel in every runtime state:

```text
──────────────────────────────────────────────────────────────────────────────
› Message Goah…
```

It never says `Steer this Turn` or `Enter retry`. Steering and recovery are
runtime behavior; the Human should always be able to send a normal message.

## Terminal-native variants

The visual system should avoid web-style cards and large filled surfaces. Four
valid directions preserve the same information model:

| Variant | Primary axis | Character |
| --- | --- | --- |
| Linear Ledger | Hierarchy | A continuous tree/timeline similar to build output and `git log` |
| Dense Operator | Density | Reverse-video labels and compact aligned rows for expert operators |
| Quiet Transcript | Progressive disclosure | One Activity summary line; answer dominates the viewport |
| Channel Gutter | Typographic structure | Fixed left gutter labels process, output, and receipt channels |

The comparison prototype lives in `docs/design/tui-v2-variants.html`.

## Interaction

- `Ctrl+O`: toggle details for the current Turn; the preference may persist for
  the session.
- A normal Human message may correct, redirect, or request recovery in every state.
- `/status`: full Goal, Agent, queue, and recovery detail.
- Mouse/keyboard focus on an Activity header toggles only that Turn.
- New output follows the end only while the user is already at the bottom.

## Restart reconstruction

- Rebuild history by Turn, never as a flat speaker/text list.
- A Human Turn keeps its committed user messages, canonical committed response,
  and terminal error even when the Turn failed or was interrupted.
- An automatic CEO Goal Wake renders as its own Turn block without borrowing the
  preceding Human prompt.
- Provisional Assistant content remains hidden after failure; an in-progress
  Human Turn is attached live and replays its durable user message before new
  activity.

## Theme and accessibility

- Resolve light/dark terminal scheme and choose separate ANSI palettes.
- Meet at least 4.5:1 for ordinary text on both reference palettes.
- Never rely on italic, dim, green, or red alone.
- Preserve readable prefixes in `NO_COLOR`: `USER`, `THINKING`, `RUNNING`,
  `DONE`, `FAILED`, `ANSWER`, and `GOAL` may be visually hidden only when color
  and layout are available.
- Validate 40, 80, and 120 columns and low-height terminals.

## Implementation boundary

This is a presentation refactor, not a Supervisor or protocol refactor. The TUI
may need `turnId`, timing, bounded tool result summaries, and current activity in
its control frames, but policy and Goal decisions remain outside the view.

Recommended implementation sequence:

1. Introduce `TurnPresentation` and `OrganizationStatusModel` reducers with snapshot tests.
2. Build components for User, Activity, Assistant, Receipt, Error, and Status.
3. Add bounded reasoning and tool-result summaries.
4. Add color-scheme-aware tokens and `NO_COLOR` structural fallbacks.
5. Verify full shells at 40/80/120 columns for ready, working, waiting, failed,
   and setup states.
