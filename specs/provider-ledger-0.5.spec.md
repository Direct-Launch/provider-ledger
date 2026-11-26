# Provider Ledger 0.5 — OpenChamber-aware attribution: agents, skills, MCPs, subagents

Status: planned with the maintainer 2026-11-26. Follows 0.4.0 (portability, types, local vs cloud).
World-facing release: this is also the release that makes the extension stand apart in the
directory, so the README must carry it.

## 1. The question it answers

"Which part of my own setup is spending the tokens?" — the skills I load, the MCP servers
I run, the subagents I dispatch, the agent I was in — not just which provider billed it.

## 2. What is actually measurable (verified in the protocol types, 2026-11-26)

An OpenCode 2 assistant message is `{ type: "assistant", model, cost, tokens, time,
content: [ … ] }` and its `content` entries are either `{ type: "text" }` or
`{ type: "tool", id, name, executed, state }`, where a completed tool state carries
`input` and `content[]` (the result text). Sessions carry `agent` and an optional
`parentID`; the message stream carries `agent-switched` entries.

So the ledger can see, per reply: the agent in force, every tool it called, and how large
each tool's result was. It cannot see a per-tool invoice — there is no such number.

## 3. Requirements (EARS)

### Attribution
- **T-1** The service shall record, per day / provider / model, a map of **tool buckets**
  keyed by a class and a name: `skill:<name>`, `mcp:<server>`, `agent:<name>`,
  `tool:<name>` (for any other tool), each holding `calls`, `generated` (output + reasoning
  tokens of the reply that issued the call) and `contextChars` (characters of the tool's
  returned `content`).
- **T-2** An MCP tool shall be classed `mcp:<server>` from the tool name under OpenCode's
  `mcp_<server>_<tool>` convention; where the name does not follow it, the class shall be
  `tool:<name>`, never a guessed server.
- **T-3** A skill load shall be classed `skill:<name>` from the skill tool's input
  (`name`); a subagent dispatch (`task`) shall be classed `agent:<subagent_type>` when the
  input carries it, `tool:task` otherwise.
- **T-4** A session with a `parentID` shall be marked a **subagent session**; its spend
  stays in the ledger and is additionally reported as subagent share of the period.
- **T-5** Where a tool's `state` is not `completed`, it counts as a call with no
  `contextChars` — never an estimate.

### Reporting
- **T-6** The panel shall gain a **Surfaces** tab: top 10 skills, top 10 MCP servers and
  top 10 other tools for the period, each with calls, generated tokens and context added,
  plus the subagent share of the period's spend.
- **T-7** Every figure shall carry its meaning: `generated` is "tokens written while
  calling it", `context added` is "characters it put into the conversation, re-read on
  later steps". The tab states plainly that no provider bills per tool.
- **T-8** Types tab gains the agent split already specified in 0.4.0 (C-3) and a line for
  subagents; the agent tool's answer gains a `surfaces` section for the named period.

### Non-goals
- No claim of a per-MCP price, no allocation of input-cache reads to a tool, no parsing of
  tool output beyond its length.

## 4. Acceptance criteria

1. Given a reply that calls `skill` with `{name:"humanizer"}` and writes 900 output tokens
   whose result text is 4 000 characters, the `skill:humanizer` bucket shows 1 call,
   900 generated, 4 000 context characters.
2. Given a tool named `mcp_github_search_issues`, the class is `mcp:github`.
3. Given a tool named `weird_tool`, the class is `tool:weird_tool`, and no MCP row appears.
4. Given a session with `parentID` set, it is in the ledger and in the subagent share,
   and it is not double-counted in the period total.
5. Given a tool state `running` at sync time, the call is counted and `contextChars` is 0.
6. Given no tool calls in the period, the Surfaces tab says so rather than showing zeros.

## 5. Phasing

- **0.5.0** T-1…T-8, store version 5 (buckets rebuilt; tool buckets are additive, so the
  rebuild is required only for the class/agent join, not for the totals).
- **0.5.1** surfaces in the agent tool's text and in Work Status (one line: the biggest
  context contributor this week).
