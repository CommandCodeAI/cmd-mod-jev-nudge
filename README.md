# cmd-mod-jev-nudge

![cmd-mod-jev-nudge](https://raw.githubusercontent.com/CommandCodeAI/cmd-mod-jev-nudge/refs/heads/main/.github/workflows/image.png)

Agents stop too early. They finish one step, write "next I'll do X", and hand the prompt back.

This [Command Code](https://commandcode.ai) mod catches that. When a run is about to end, it asks
[Jev](https://typesafe.ai) whether a nudge would help the agent keep working on what you asked for.
Jev answers with a probability. A confident yes sends the agent back to work.

Two guards stop a bad nudge. One checks if the agent is waiting on you (permission, a decision,
missing info). The other checks if the last nudge got anything done.

```
model finishes turn (no tool calls)
        │
        ▼
onStop → state {user_requests, latest_assistant_message, recent_tool_calls, previous_nudges}
        │
        ▼
POST api.commandcode.ai/provider/v1/systemone ──► Jev
   nudge    "would a gentle nudge help… right now?"      → p
   waiting  "needs permission / decision / info / event?"  → p
   progress "moved on since the reply we nudged?"        → p  (2nd+ nudge only)
        │
        ▼
waiting ≥ .5 · progress < .5 · nudge < .5 · error/timeout ──► run stops as normal
otherwise ──► {continue: true} + nudge turn ──► model keeps working
              (Command Code allows 8 of these per user turn, then ends the run)
```

## Install

```bash
cmd login                                      # skip if signed in
cmd mods add cmd-mod-jev-nudge                # add -g for all projects
```

That's it. The mod uses your Command Code key, from `CMD_API_KEY` or `cmd login`. With no
key it stays off and says so. If Jev fails or times out, the run stops like it would without the mod.

## Flags

Pass with `--mod-option name=value`.

| Flag | Default | Meaning |
|---|---|---|
| `jev-nudge-threshold` | `0.5` | Minimum "a nudge would help" probability |
| `jev-nudge-max` | none | Max nudges per run. `0` turns nudging off |
| `jev-nudge-base-url` | `https://api.commandcode.ai` | API root, for a proxy or the fake server |
| `jev-nudge-model` | `typesafe/jev` | Model id |
| `jev-nudge-verbose` | `false` | Show declined stops in the feed too |

`DEBUG=true` prints every decision to stderr.

Why 0.5? I measured it. Jev says 0.5 to 0.8 when real work is left and 0.04 to 0.08 when the agent is
done. 0.5 sits in the gap. At 0.6 the first nudge depended on how the model worded its status line.

Why no nudge cap by default? Stopping after N nudges without looking is the same "stopped too early"
bug. The guards end runs on evidence instead. Command Code still caps stop-hook continues at 8 per
user turn, and no mod can raise that. A task that needs more than 8 nudges should be split up anyway.

## Try it from a clone

```bash
git clone git@github.com:CommandCodeAI/cmd-mod-jev-nudge.git
cd cmd-mod-jev-nudge
pnpm install      # --mod doesn't install deps, cmd mods add does
cmd --mod .       # loads this mod for one session
```

This prompt forces early stops on purpose:

```
Five steps: (1) create smoke-1-ignite.txt containing ignite, (2) create smoke-2-kindle.txt
containing kindle, (3) create smoke-3-blaze.txt containing blaze, (4) create smoke-4-ember.txt
containing ember, (5) create smoke-5-ash.txt containing ash. Ignore any other files in the folder.
Rule for this exercise: do exactly ONE step per reply, then end your reply with a short status
line saying which steps remain. When all five files exist, say "all five files are done".
```

One prompt, five replies. You type once. Percentages vary run to run.

```
you   ▸ Five steps: (1) create smoke-1-ignite.txt ...

agent ▸ write smoke-1-ignite.txt
        Created smoke-1-ignite.txt. Remaining: 2, 3, 4, 5.
        ┊ stop → Jev: nudge 78% · waiting 6%
  jev nudge 1: unfinished work found (78%), continuing

agent ▸ write smoke-2-kindle.txt
        Created smoke-2-kindle.txt. Remaining: 3, 4, 5.
        ┊ stop → Jev: nudge 74% · waiting 5% · progress 91%
  jev nudge 2: unfinished work found (74%), continuing

agent ▸ write smoke-3-blaze.txt  ...  (nudge 3)
agent ▸ write smoke-4-ember.txt  ...  (nudge 4)

agent ▸ write smoke-5-ash.txt
        all five files are done
        ┊ stop → Jev: nudge 5%  → no nudge, run ends

you   ▸ _
```

Tell it "do one step, then wait for my go-ahead" instead and the waiting guard blocks the nudge:

```
agent ▸ Created smoke-1-ignite.txt. Want me to go on?
        ┊ stop → Jev: nudge 41% · waiting 88%
  jev-nudge: turn 2, no nudge (waiting on the user (88%))   ← only with jev-nudge-verbose=true
you   ▸ _
```

The `┊ stop → Jev` lines show what happens under the hood. The feed shows only the `jev nudge`
rows. Add `DEBUG=true` to print every decision to stderr.

### Offline

`scripts/fake-jev.mjs` fakes the API with fixed rules. It nudges unless the reply says it's done,
reports waiting when the reply ends in a question, and counts progress when tools ran since the last
nudge. Every request lands in `jev-log.jsonl`.

```bash
node scripts/fake-jev.mjs &
CMD_API_KEY=x cmd --mod . --mod-option jev-nudge-base-url=http://127.0.0.1:4711 --mod-option jev-nudge-verbose=true
```

## Develop

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
```

`src/protocol.ts` builds the state, questions, and decision with no I/O. `src/client.ts` makes the
HTTP call. `src/index.ts` registers the hooks.
