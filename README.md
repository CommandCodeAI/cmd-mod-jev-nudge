# cmd-mod-jev-nudge

▶ [Watch the demo](https://github.com/CommandCodeAI/cmd-mod-jev-nudge/raw/main/.github/demo.mp4)

Agents stop too early. They do one step, say "next I'll do X", and hand the prompt back.

This [Command Code](https://commandcode.ai) mod asks [Jev](https://typesafe.ai) at every stop:
would a nudge help? Yes, and the agent keeps going. It won't nudge when the agent is waiting on
you, or when the last nudge got nothing done.

## Install

```bash
cmd login                        # skip if signed in
cmd mods add cmd-mod-jev-nudge   # add -g for all projects
```

That's it. Uses your Command Code key (`CMD_API_KEY` or `cmd login`). If Jev fails, the run stops
as normal.

## See it

```
say hi in five languages. ONE hi per reply, then stop and say how many done. after the fifth say "all done".
```

```
you   ▸ say hi in five languages ...

agent ▸ Hola! 1 of 5 done.
  jev nudge 1: unfinished work found (78%), continuing
agent ▸ Bonjour! 2 of 5 done.
  jev nudge 2: unfinished work found (74%), continuing
agent ▸ Ciao! 3 of 5 done.
  jev nudge 3 ...
agent ▸ Hallo! 4 of 5 done.
  jev nudge 4 ...
agent ▸ Konnichiwa! all done.
                                  ← Jev 5%, no nudge, run ends
you   ▸ _
```

You type once and get five replies. Add "then wait for my go-ahead" to the prompt and it stops after
one, because the agent is now waiting on you.

## How it works

```
agent stops
   │
   ▼
POST api.commandcode.ai/provider/v1/systemone  (typesafe/jev)
   nudge     would a nudge help right now?        p
   waiting   needs you: permission, info, choice? p
   progress  did the last nudge get anywhere?     p   (2nd nudge on)
   │
   ▼
waiting ≥ .5 · progress < .5 · nudge < .5 · error  →  stop
otherwise                                          →  nudge, keep going
```

Command Code allows at most 8 nudges per user turn.

## Flags

`--mod-option name=value`

| Flag | Default | Meaning |
|---|---|---|
| `jev-nudge-threshold` | `0.5` | Min probability to nudge |
| `jev-nudge-max` | none | Max nudges per run, `0` = off |
| `jev-nudge-verbose` | `false` | Show skipped nudges too |
| `jev-nudge-base-url` | `https://api.commandcode.ai` | API root |
| `jev-nudge-model` | `typesafe/jev` | Model id |

`DEBUG=true` logs every decision to stderr.

The 0.5 threshold is measured. Jev says 0.5 to 0.8 with work left and under 0.1 when done.

## Develop

```bash
git clone https://github.com/CommandCodeAI/cmd-mod-jev-nudge.git
cd cmd-mod-jev-nudge && pnpm install
cmd --mod .       # run it
pnpm test
```

Offline, run `node scripts/fake-jev.mjs` and add
`--mod-option jev-nudge-base-url=http://127.0.0.1:4711`. It logs requests to `jev-log.jsonl`.
