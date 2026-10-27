# claude-agent-ledger

<img src="https://raw.githubusercontent.com/zemixo/claude-agent-ledger/main/quiet-orbit-banner.svg" alt="Agent Ledger: Follow the token trail. Zemixo pixel robot workshop." width="100%">

> See exactly where your Claude Code budget goes — per subagent, per model, per day.

[![npm](https://img.shields.io/npm/v/claude-agent-ledger.svg)](https://www.npmjs.com/package/claude-agent-ledger)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> Use `--anonymize` before sharing output. It replaces project paths and
> session IDs, but it does not rename subagent or tool names — review those
> before you post a screenshot.

[Install](#install) · [Example](#example) · [Flags](#flags) · [Source install](#install-from-source)

---

## Why

Claude Code's invoice at month-end tells you one number. It doesn't tell you:

- Which of your subagents burned most of it
- Which model (Opus / Sonnet / Haiku) ate the budget
- Which day of last week was the expensive one
- Whether your "cheap" Haiku agent is actually quietly expensive

If you run **one** Claude Code session, this is fine — you already know.
If you run **seven** subagents daily (reliability, release, review, iOS factory, docs, ...), you're flying blind.

`claude-agent-ledger` reads Claude Code's local session logs and gives you a per-subagent ledger. That's it.

## Install

Requires [Bun](https://bun.sh/) 1.1 or newer. The CLI is Bun-native even when
you install it from npm.

```bash
bun install -g claude-agent-ledger
# or, with Bun already available: npm install -g claude-agent-ledger

agent-ledger week --summary        # the dashboard (start here)
agent-ledger week --tree           # parent → child subagent attribution
agent-ledger week --by tool        # which tool ate the budget (Read/Bash/Grep/MCP)
agent-ledger week --by model       # opus vs sonnet vs haiku
agent-ledger week --by project     # which project ate your tokens
agent-ledger week --by session     # which single sessions went sideways
agent-ledger week --by day         # daily bar chart with peak/avg/variance
agent-ledger today --budget 50     # CI gate: exit 2 if today > $50
agent-ledger week --json | jq      # JSON output for any view, including summary
agent-ledger month --md > report.md

# Live tail — polling delta meter
agent-ledger watch                          # refresh every 10s
agent-ledger watch 4                        # refresh every 4s

# Root-cause analysis on a single expensive session
agent-ledger explain <session-id>           # heuristic: top-3 turns + tool/model breakdown
agent-ledger explain <session-id> --anonymize
                                            # replace the displayed session id with sess-A
ANTHROPIC_API_KEY=sk-ant-... agent-ledger explain <session-id>
                                            # LLM mode: Haiku 4.5 ≤4-bullet root cause (typically <$0.005/run)
```

All aggregate commands run locally, require no account, and make no network
requests. `explain` is also local by default. If you explicitly set
`ANTHROPIC_API_KEY`, it sends derived session metrics — subagent/model/tool
names, timestamps, token counts, and cost totals — to the
Anthropic API. The session identifier is redacted. It does **not** send prompts,
responses, tool content, or project paths. For shareable local heuristic output,
pass `--anonymize`; it replaces the displayed session identifier, but subagent,
model, tool, timestamp, token, and cost evidence remains visible for review.
The flag sanitizes command output only: the supplied identifier can still be
visible in shell history and process arguments.
Session prefixes must match exactly one local log. If a prefix is ambiguous,
use the collision-safe prefix shown by `--by session` or the full session ID;
the CLI does not list matching IDs or paths. Session reports group by full ID,
then display the shortest directly resolvable label of at least eight characters
(or the full ID when shorter) against every discovered local log, including
logs outside the requested date range. Exact full IDs take precedence over
longer IDs that begin with the same text. If a reported full ID exists at
multiple paths, or no directly resolvable label has the CLI-safe alphanumeric-
and-hyphen form, `--by session` fails closed with a generic error. `explain`
likewise fails closed when the requested full ID exists at multiple paths.

## Why this and not `/cost`?

Claude Code's built-in `/cost` shows the **current session** cost. That's it.

`claude-agent-ledger` answers questions `/cost` can't:

- Which of my **10+ subagents** burned the budget? (default)
- Which **Claude model** burned the budget — Opus vs Sonnet vs Haiku? (`--by model`)
- Which **project** in `~/.claude/projects/` ate the tokens? (`--by project`)
- Which **single sessions** went sideways and burned $X? (`--by session`)
- Which **day** of last week was the expensive one? (`--by day`)
- What would my Claude Max usage have cost on **pay-as-you-go**? (the "shadow cost" framing)
- Is my **cache reuse ratio** healthy? (auto-derived insight)
- What's the **leverage** I'm getting from my $200/mo subscription? (e.g. 250×)

Run `agent-ledger week --summary` once and decide.

## Example

This is deterministic output from the repository's synthetic fixture, using the
price snapshot documented below:

```text
agent-ledger today summary

  Shadow cost           $0.08
  Sessions              2
  Projects              1

  Top subagent          Reality Checker  $0.06 (74%)
  Top model             claude-sonnet-4-6  $0.06 (74%)
  Cache reads           56K tokens · $0.02
  Cache reuse           28× reads/writes
```

## Shadow cost vs actual bill

The `cost` column shows what you **would** pay at Anthropic's pay-as-you-go API rates.

If you're on a fixed-price subscription (Claude Pro / Max / Claude Code plan), your actual bill is capped — the shadow cost is what the same usage **would** have cost through the raw API. Useful for:

- Understanding where time-and-token budget goes, regardless of how you pay
- Spotting runaway agents (a 10× spike is still a 10× spike, capped or not)
- Deciding when to downshift to Haiku or up to Opus per task
- Comparing usage concentration with a fixed-price plan. Shadow cost is an
  estimate, not a claim that subscription usage is interchangeable with raw API
  capacity.

If you're on pay-as-you-go, treat the `cost` column as a directional estimate.
Batch discounts, long-context premiums, provider-specific rates, retries, and
future price changes can make an invoice differ.

## How it works

Claude Code writes every conversation turn to `~/.claude/projects/<encoded-path>/*.jsonl`.
Each turn records input/output tokens, cache tokens (with TTL split), the model used,
and any `server_tool_use` (web_search / web_fetch) requests. Subagent invocations live
under `<session>/subagents/agent-*.jsonl`, with a sidecar `.meta.json` carrying the real
subagent name (e.g. `Reality Checker`, `ios-factory`).

`claude-agent-ledger` walks the tree, resolves subagent types from the sidecar
metadata, and aggregates by your chosen key. Pricing is applied locally from
`src/pricing.ts`. Aggregate commands never touch the network after install; the
optional API-backed `explain` mode is disclosed in [Install](#install).

The tree view displays up to 20 highest-cost roots. Its grand total and
`--budget` check still include every selected turn, including roots outside the
display cap. When a parent is outside the selected period, its in-range child is
shown as a root instead of being dropped.

### Cache accounting

Anthropic's prompt caching has two TTLs in current logs:

| Bucket | Multiplier | Notes |
|---|---|---|
| `ephemeral_5m_input_tokens` | 1.25× base input | 5-minute TTL (default) |
| `ephemeral_1h_input_tokens` | 2.00× base input | 1-hour TTL (long-lived sessions) |
| `cache_read_input_tokens` | 0.10× base input | Read price (90% discount, TTL-agnostic) |

Naive trackers lump these together as "input" and either overstate (by counting all creation as 1.25×) or understate (by ignoring the 1-hour writes entirely). `claude-agent-ledger` breaks them out explicitly — see `src/pricing.ts`.

### Server tool pricing

`web_search_requests` cost $0.01/request. `web_fetch_requests` are counted for
observability but have no per-request charge; fetched content still contributes
normal token costs. Both appear in the footer:

```
  server tools: web_search ×7, web_fetch ×0  ($0.07)
```

Rates were checked against Anthropic's official pricing page on 2026-07-23.
If a log contains a model ID without a verified rate, the CLI warns on stderr
and leaves that model's token cost at `$0.00` instead of guessing.

## Flags

| Flag | What it does |
|---|---|
| `--summary` | One-screen dashboard with all the headline numbers |
| `--by <subagent\|model\|day\|project\|session\|tool>` | Group rows. Default: `subagent`. `day` renders as ASCII bar chart. |
| `--tree` | Render parent → child subagent cost attribution |
| `--budget <USD>` | Exit with code 2 when estimated cost exceeds the threshold |
| `--anonymize` | Replace project paths and session ids with `~/repo-A`, `sess-A`, ... so you can share screenshots without doxing your employer / private repos. |
| `--md` | Markdown table output (good for committing or sharing) |
| `--json` | Raw JSON output (pipe into jq) |
| `--plan pro\|max` | Mask estimated costs in grouped table views; `--summary` and `--tree` keep their cost-oriented output |
| `--verbose` | Print parse counts and elapsed time to stderr |

| Env | What it does |
|---|---|
| `NO_COLOR=1` | Disable ANSI colors |
| `FORCE_COLOR=1` | Force ANSI colors when piping |

## What it's not

- Not a real-time dashboard (post-hoc log reader)
- Not a tracker for direct Anthropic API calls (those logs live server-side)
- Not a cost-limiter or kill-switch (read-only, by design)
- Not affiliated with Anthropic

## Who this is for

- You run ≥ 2 Claude Code subagents and genuinely don't know the per-agent split
- You're on Claude Max and want to know what your "free" usage is worth
- You're building AI Agent systems and want observability primitives, not vendor dashboards

## Status

The npm badge above reports the current published version. See
[`CHANGELOG.md`](CHANGELOG.md) for release history.

The source price table was checked against Anthropic's published rates on
2026-07-23. Sonnet 5 automatically switches from its introductory rate to the
published standard rate on 2026-09-01. Pricing can change, so shadow costs are
estimates rather than invoice replicas; check
[`src/pricing.ts`](src/pricing.ts) and the
[official pricing page](https://platform.claude.com/docs/en/about-claude/pricing)
before making billing decisions. Historical aggregate, tree, and explain views
select date-dependent rates from each turn's logged timestamp, so a scheduled
price change does not retroactively reprice earlier usage.

- [x] Log parser (bounded JSONL streaming, recursive subagent discovery)
- [x] Per-subagent aggregation
- [x] Per-model aggregation (`--by model`)
- [x] Per-day aggregation with bar chart (`--by day`)
- [x] Terminal table + Markdown + JSON output
- [x] ANSI color, TTY-aware
- [x] Cache 1h/5m TTL split pricing
- [x] `--plan pro|max` to mask shadow cost
- [x] `server_tool_use` accounting (paid web search, no-fee web fetch)
- [ ] Cost forecasting (trailing 7-day burn rate)
- [ ] Calibration against real Anthropic invoices
- [ ] Homebrew tap

The parser reads up to eight JSONL files concurrently and keeps at most one
in-flight or ready turn per active file. It still retains discovered file
paths, each stream's decode buffer, the aggregator's unique grouping keys, and
session-ID sets; it does not retain every parsed turn.
Records with malformed JSON, invalid timestamps, or invalid token counters are
skipped. Aggregate commands report the skipped count on stderr so incomplete
cost evidence stays visible while JSON output remains machine-readable.
Missing timestamps are never replaced with the current time.

## Install from source

Fixes listed under **Unreleased** in [the changelog](CHANGELOG.md) are available
from `main`. The npm package follows tagged releases; use the source install
below to try changes that have not been published yet.

```bash
git clone https://github.com/zemixo/claude-agent-ledger.git
cd claude-agent-ledger
bun install
bun link
agent-ledger today
```

## Development

```bash
bun test
bun run typecheck
bun run build
```

## Author

Built by [Zemixo](https://github.com/zemixo).

## License

MIT.
