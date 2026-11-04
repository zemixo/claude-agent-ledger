# Changelog

All notable changes to `claude-agent-ledger` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add `agent-ledger forecast` with a seven-complete-local-day basis and an
  equally sized constant-rate projection over the next seven complete days.
- Include seven daily basis rows, activity coverage, captured pricing time,
  plan context, and separate pricing/record diagnostics in a versioned v2 JSON
  schema.
- Mark every reported amount as a lower bound when model pricing or detected
  record coverage is incomplete, while keeping JSON stdout clean and reporting
  coverage warnings on stderr.
- Freeze rates at `pricing.asOf`; scheduled price changes in the projection
  window are deliberately not simulated.
- Define a tool-owned log contract with named, versioned, fully synthetic
  fixtures for assistant usage, context events, auxiliary events, and subagent
  sidecars.
- Emit bounded machine-readable diagnostics for malformed JSON, unknown record
  types, invalid assistant timestamps/usage, and invalid subagent metadata.
- Surface those diagnostics from aggregate, forecast, watch, and explain flows;
  watch deduplicates unchanged warnings, and explain fails closed when an
  existing session contains no supported billable turns.

### Changed

- Treat missing, unreadable, or untraversable source paths and nested symbolic
  links as forecast errors instead of presenting a partial scan as trustworthy
  zero activity.
- Reject missing timestamps and expose malformed-line diagnostics instead of
  inventing a current timestamp or silently accepting incomplete data; validate
  forecast timestamps as RFC3339 calendar values while retaining supported
  legacy date strings in aggregate and explain commands.
- Retain only billing and attribution fields in parsed turns. Forecast keeps
  invalid assistant activity evidence without including its costs. Known context
  and auxiliary records are ignored; prompt, response, tool, attachment, and
  arbitrary usage metadata payloads are not retained.
- Reject unknown cost-bearing usage keys and unknown nested cache/server-tool
  keys under the v1 contract, unexpected direct usage on known non-billable
  records, and assistant usage outside `message.usage`, so upstream shape drift
  is reported instead of silently undercounted. Scope timestamped invalid
  records to the requested date range while retaining unassignable diagnostics
  source-wide.

### Fixed

- Validate log record shapes, timestamps and token counters before aggregation;
  report skipped records without printing their contents. Directory discovery
  now terminates on symlink cycles. Public author attribution uses a pseudonym.
- Keep concurrent JSONL parsing bounded to one pending turn per active file.
  The previous batch implementation drained as many as eight complete logs and
  retained every in-range turn in arrays before yielding.
- Yield turns without waiting for every file in the batch to reach EOF, while
  preserving the eight-file concurrency limit and date filtering.
- Keep equal-cost rows and tree nodes deterministic when concurrent files
  complete in a different order.
- Price historical aggregate, tree, and explain results at each turn's logged
  timestamp so scheduled rate changes do not retroactively reprice older usage.
- Honor `--anonymize` in `agent-ledger explain` by replacing the displayed
  session identifier and avoiding identifier echo on failed anonymous lookups.
- Reject unsupported flags and extra positional arguments in `explain` instead
  of silently ignoring them.
- Validate session prefixes before local lookup, avoid echoing raw local I/O
  errors in anonymous mode, and never echo raw API transport errors that may
  contain paths, identifiers, or credentials.
- Reject ambiguous `explain` prefixes instead of analyzing whichever matching
  session log happens to be discovered first, while preferring an exact full ID
  over longer IDs that share the same prefix.
- Keep colliding session IDs in separate `--by session` rows and emit the
  shortest directly resolvable display label, including collisions from logs
  outside the requested date range. Reported duplicate full IDs or labels
  outside the supported CLI form fail closed without printing IDs or paths.
- Keep `--tree` grand totals and `--budget` checks complete when more than 20
  roots exist, and display in-range children whose parent is outside the period.

## [0.7.2] — 2026-07-23

### Fixed

- Make `agent-ledger --help`, `agent-ledger -h`, and `agent-ledger help`
  print usage to stdout and exit successfully.
- Add `agent-ledger --version` and `agent-ledger -v`, matching the public issue
  template and standard CLI behavior.

## [0.7.1] — 2026-07-23

### Fixed

- Refresh model rates against Anthropic's 2026-07-23 pricing, including Opus
  4.5–4.8, Haiku 4.5, Fable 5, and Mythos 5. Sonnet 5 switches from its
  introductory rate to the published standard rate on 2026-09-01.
- Stop charging a per-request fee for `web_fetch`; only `web_search` has the
  documented $0.01 request fee.
- Build for Bun rather than Node, matching the CLI's Bun runtime dependencies.
- Limit the npm tarball to runtime source, README, and license files.
- Apply `--anonymize` to session identifiers in the `--tree` view.
- Keep `--budget` enforcement active when `--plan` masks displayed costs.
- Reject unknown CLI flags instead of silently ignoring them.
- Redact the session identifier sent by API-backed `explain` mode and document
  the remaining derived metrics that leave the machine.
- Refuse to invent a family price for unknown future model IDs; warn and leave
  their token cost unpriced until an official rate is added.

## [0.7.0] — 2026-04-23

### Added — live tail + property tests

- **`agent-ledger watch [intervalSec]`** — live polling mode. Re-aggregates
  today's cost every N seconds (default 10), prints a delta meter:

  ```
  [14:46:34] today $3310.71  ↑ +$3310.71  · 9560 turns (Δ9560) · top: (main) $3167.95
  [14:46:40] today $3310.71  · +$0.00  · 9560 turns (Δ0) · top: (main) $3167.95
  ```

  Answers "what's happening right now" without needing to re-run queries.
  Ctrl-C to exit.

- **Property tests via `fast-check`** — 7 new tests, 1400+ generated cases
  covering:
  - `costFor()` returns non-negative for any valid input
  - `totalCost === sum(components)` exactly (ε < 1e-9)
  - `cache_read ≤ fresh input` cost (90% discount holds)
  - `cache_1h ≥ cache_5m` cost (1h tier always more expensive)
  - `Aggregator.total === sum(rows)` for any random turn stream
  - Non-assistant turns contribute 0 cost
  - `SubagentGraph.totalCost ≥ selfCost` (children only add)

  Total test count: 22 → 29 (kept all prior tests passing).

## [0.6.0] — 2026-04-23

### Added — `agent-ledger explain <sessionId>` (the LLM-native move)

A new subcommand that answers **"why was this single session expensive?"**
This is the question Helicone / Langfuse / OpenLLMetry physically cannot
answer — they observe API calls, not Claude Code's prompts and tool calls.

Two modes:

- **Heuristic mode** (default, no API key needed) — analyzes the session
  JSONL and prints:
  - Subagent + total cost + turn count
  - Model breakdown (which model dominated)
  - Tool invocation count (Read/Bash/Grep/Edit/MCP — top 8)
  - Top 3 most expensive turns with full token + tool breakdown
  - Cache reuse ratio + verdict (`<5×` warning, `>20×` good)

- **LLM mode** (set `ANTHROPIC_API_KEY`) — pipes the heuristic evidence into
  Haiku 4.5 with a tightly-scoped prompt: "identify the SPECIFIC root cause
  + ONE concrete action to cut this session's cost by 50%+." Costs about
  typically under $0.005/run. Cite turn numbers from the breakdown.

```bash
agent-ledger explain 63063a38
agent-ledger explain b988bd89-803a-4c78    # full uuid or 8-char prefix both work
```

## [0.5.0] — 2026-04-23

### Added — performance + production-readiness foundation

- **Streaming JSONL parser** — replaces `await file.text()` (which OOM'd on
  10GB+ logs). Now reads via `Bun.file().stream()` + `TextDecoder` line-by-line.
  Memory profile is constant regardless of log size.
- **Concurrent file walk** — `findSessionLogs` parallelizes per-project
  `readdir` (`Promise.all`), and `parseAll` reads up to 8 JSONL files
  concurrently. ~5–10× cold-start speedup on multi-project setups.
- **Zero materialization** — bin no longer collects every turn into an array
  before aggregating. Instead one parser stream fans out to N `Aggregator`
  instances in parallel. Memory is now O(unique-keys) not O(turns).
- **`--by tool`** — new GroupKey. Attribute spend per tool call (`Read`,
  `Bash`, `Grep`, `Write`, MCP tool names). Answers "which tool is eating my
  budget" — the most actionable lens for a Claude Code user.
- **`--tree` (the MOAT)** — subagent-graph cost attribution. Walks the
  parent→child orchestration tree and shows
  `orchestrator → 3×researcher + 6×swift-dev = $312`. Helicone / Langfuse /
  OpenLLMetry can't do this — they observe API calls, not Claude Code's
  multi-agent runtime.
- **`--budget <USD>`** — exit code `2` if total cost exceeds budget. Wire it
  into your CI / shell startup / `pre-commit` to gate spend.
- **`--json` works for `--summary`** — previously summary was text-only.
  Now pipe-friendly: `agent-ledger week --summary --json | jq`.
- **`--verbose`** — print parse stats (turns / elapsed) to stderr.

### Changed

- `Aggregator` is now a class (`add()` / `finalize()`) instead of an async
  function. Enables single-pass fan-out and live-tail in v0.6.
- `parseAll` and `parseFile` no longer block on full file reads.
- `SessionTurn` adds `parentSessionId` and `toolUses[]` fields.

### Internal

- Backwards-compatible: the old `aggregate(turns, from, to, group)` async
  function still exists and wraps the new `Aggregator` class. All v0.4.x
  tests pass without modification (22/22).

## [0.4.1] — 2026-04-22

### Added
- `--anonymize` flag — replaces project paths with `~/repo-A`, `~/repo-B`,
  ... and session ids with `sess-A`, `sess-B`, ... ordered by spend descending.
  Use this when you want to share your output publicly (HN / Bluesky /
  presentation) without leaking employer names or internal repo names.
  Subagent / model / day labels stay untouched (those are public info).

## [0.4.0] — 2026-04-22

### Added
- `--by project` — group spend by Claude Code project directory.
  Decodes `~/.claude/projects/-Users-example-project` → `~/project` so you can
  see which project is burning budget.
- `--by session` — group by session ID. Surfaces the single most expensive
  conversations (useful for hunting the one that went sideways).
- Summary dashboard now shows:
  - `Projects` count
  - `Top project` line
  - `Project mix` block — top 3 projects with $ and %
- `decodeProjectId()` exported for reuse. Special-cases the `~/` home prefix,
  falls back to slash-joined path for other roots.
- Row label column now auto-widens up to 40 chars for project paths.

### Changed
- `formatTable` takes an optional `groupName` arg so the header column matches
  the group (e.g. "project", "session").

## [0.3.0] — 2026-04-22

### Added
- `--summary` flag — single-screen dashboard with shadow cost, top subagent /
  model / day, cache reuse ratio, and **leverage vs $200/mo Max plan**.
  This is the killer view for "why install over /cost?"
- Auto-derived insights footer on the default table:
  - Top contributor with %
  - 1h cache spend call-out (when ≥5% of total)
  - Cache reuse ratio (read/write) with verdict
  - Monthly $ equivalent + leverage vs Max plan
- Daily-mode insights: peak day, avg/day, peak/trough variance

### Changed
- `--by day` polish:
  - Bar fixed to 40-char width so session counts align in their own column
  - Brighter cyan (`\x1b[96m`) bar character
  - Total row separated by horizontal rule, properly aligned
- Header line now shows period + total + sessions + group count at a glance:
  `agent-ledger week  2026-04-15 → 2026-04-22  ·  $13,356.27 shadow  ·  217 sessions  ·  7 agents`

## [0.2.0] — 2026-04-21

### Added
- `--by <subagent|model|day>` flag — group rows by subagent (default), by
  Claude model, or by date. The `day` mode renders an ASCII bar chart of
  daily spend, useful for spotting "expensive Tuesdays."
- Server-tool pricing: `web_search_requests` and `web_fetch_requests` from
  the `server_tool_use` block are now counted at $0.01/request and surface
  in a footer row when present.
- ANSI color output, TTY-aware (NO_COLOR / FORCE_COLOR respected).
  - Subagent / model / day labels in cyan
  - Cost amounts color-coded by magnitude (red ≥$1000, yellow ≥$100,
    green ≥$1, dim <$1)
  - Total row bolded
- New tests for server-tool pricing, `--by model`, and `--by day`
  (22 tests, up from 17).

### Changed
- `aggregate(turns, from, to)` accepts an optional 4th arg `group: GroupKey`
  (`'subagent' | 'model' | 'day'`). Default behavior unchanged.
- `AggregatedRow` now carries `webSearchRequests` and `webFetchRequests`
  counters; `CostBreakdown` adds `serverToolUseCost`.

### Not yet
- Calibration against real Anthropic invoices (need volunteers — see
  `.github/ISSUE_TEMPLATE/`)
- Cost forecasting (trailing 7-day burn rate)
- Homebrew tap

## [0.1.0] — 2026-04-21

Initial public release.

### Added
- JSONL parser with recursive walk of `~/.claude/projects/**`, including nested
  `subagents/` directories
- Per-subagent attribution via sidecar `agent-<hash>.meta.json` files
- Pricing with cache TTL split: `ephemeral_5m_input_tokens` (1.25×) vs
  `ephemeral_1h_input_tokens` (2×)
- Terminal table output (default) and Markdown export (`--md`)
- JSON output (`--json`) for piping into other tools
- `--plan pro|max` to suppress dollar columns on fixed-price subscriptions
- Support for current and prior-generation model IDs (Opus 4.6/4.7,
  Sonnet 4.5/4.6, Haiku 4.0/4.5)
- Family-prefix fallback for unknown future models (e.g. `claude-opus-5-*`
  resolves to Opus pricing)
- `<synthetic>` turns (Claude Code context compaction) correctly priced at $0
- Published to npm as `claude-agent-ledger`
