# Parser benchmarks

The parser benchmark makes scale changes reproducible without reading a real
Claude Code log. It generates a temporary, deterministic corpus, drains
`parseAll()` in fresh Bun processes, validates every record count, and removes
the corpus afterward.

## Workload

Both profiles keep the discovery shape fixed at four synthetic projects and
four JSONL files per project (16 files total). This exercises two batches at
the parser's concurrency of eight without mixing file-count growth into the
record-count measurement.

| Profile | Small | Medium | Large | Use |
|---|---:|---:|---:|---|
| `smoke` | 1,000 | 10,000 | 100,000 records | Ordinary PR and main CI check |
| `full` | 10,000 | 100,000 | 1,000,000 records | Parser-relevant PR, manual, and weekly receipt |

Every ten input records contain eight current assistant-usage records, one
legacy assistant-usage record, and one known non-billable context record. The
expected result is therefore 90% accepted, 10% ignored, and zero diagnostics.
All values, identifiers, timestamps, paths, and empty content arrays are fixed
synthetic data. No default `~/.claude/projects` path is ever consulted.

The generator streams lines into the 16 files and then re-reads the completed
files to verify their byte count and a SHA-256 over fixed relative filenames
and exact contents. Corpus generation and verification are outside the timed
region.

## Run it

Run these maintainer commands from a source checkout. Benchmark sources are not
part of the runtime npm tarball.

```bash
# Fast correctness and scale smoke
bun run benchmark:check

# Full receipt; the JSON file is optional and should stay untracked locally
bun run benchmark -- --profile full --check --output parser-benchmark.json

# Add a historical comparison to the receipt (always advisory)
bun run benchmark -- --profile full --baseline previous.json
```

The full benchmark runs one fresh-process warm-up per size, then three measured
samples per size in this order:

```text
small / medium / large
medium / large / small
large / small / medium
```

The worker uses `performance.now()` around discovery plus the complete
`parseAll()` drain. The parent also records spawn-to-exit wall time, but parser
throughput uses only the worker timer and divides by all input records,
including the known ignored records. Peak RSS is the fresh child's lifetime
high-water value from `Bun.Subprocess.resourceUsage()` after exit; it is not a
JavaScript heap measurement or an incremental RSS delta. Wall time is the
median of three samples, while peak RSS is the maximum of the three raw
samples. Corpus verification and a warm-up read precede the measurements, so
the throughput is a best-effort warm-filesystem-cache result; the harness does
not claim cold-storage performance or try to purge an OS-wide cache.

Bun 1.3.13 exposes native `ru_maxrss` units despite its byte-oriented API
typing: KiB on Linux and bytes on Darwin. The parent explicitly multiplies the
Linux value by 1024 before storing `peakRssBytes` and refuses to benchmark an
unverified platform or Bun version. This normalization is identified as
`bun-1.3.13-rumaxrss-linux-kib-darwin-bytes-v1` in receipt schema v2; schema v1
receipts predate the Linux correction and must not be used as baselines.

## Hard checks

Every warm-up and measured sample fails immediately on a timeout, non-zero
child exit, malformed or multiple result objects, invalid peak RSS, an
unexpected accepted/ignored count, or any diagnostic line. Each child has a
60-second timeout.

Two deliberately broad scale guards catch regressions rather than ordinary
host noise:

- The large / medium median parse-time ratio must be no more than 15×
  (1,000,000 / 100,000 records for full; 100,000 / 10,000 for smoke).
  This check is skipped when the medium median is below 100 ms, where fixed
  process and filesystem overhead dominates.
- `max(medium peak RSS, large peak RSS) - small peak RSS` must be no more than
  192 MiB for the fixed 16-file workload. This is an allocation high-water
  envelope, not a claim that process memory is constant.

Stored receipt comparisons never fail a hosted job. Even matching Bun,
platform, architecture, OS release, CPU model, profile, and corpus-generator
versions does not make two shared runners equivalent. The receipt flags a
throughput decline over 25% or a peak RSS increase over `max(25%, 32 MiB)` as
advisory. A hard performance regression decision requires base and head
measured back-to-back in the same job (with alternated order), or a stable
self-hosted runner.

## Receipt and privacy contract

The JSON receipt contains the source commit and dirty flag; exact corpus
version, algorithm, seed, SHA-256, bytes, mix, and maximum line length;
Bun/platform/architecture/OS release/CPU model; all per-run parse wall,
process wall, and normalized peak RSS samples; aggregation rules;
observations; and checks.

It never serializes the temporary directory, cwd, home directory, username,
hostname, environment variables, runner name, argv, or real source filenames.
Only receipts from a clean CI checkout are suitable for publication. The
parser-relevant PR, scheduled, and manual workflow uploads the sanitized JSON
and writes the Markdown table to the job summary.

## What this does not prove

The fixed-file benchmark isolates record-count scaling in the streaming parser.
It does not measure aggregation (which retains unique grouping keys and
session-ID sets), file-discovery scaling, arbitrary maximum line sizes, real
prompt/tool payloads, network storage, or end-to-end CLI rendering. A successful
1,000,000-record run does not prove 10 GB safety, asymptotically constant
memory, or a universal speedup. Any broader claim needs a workload and receipt
that directly tests it.
