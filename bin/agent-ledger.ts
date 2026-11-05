#!/usr/bin/env bun
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
	Aggregator,
	DuplicateSessionIdError,
	type GroupKey,
	SubagentGraph,
	UnsupportedSessionIdError,
} from '../src/aggregator.ts';
import {
	AmbiguousSessionError,
	analyzeSession,
	DuplicateSessionFileError,
	formatHeuristic,
	llmExplain,
} from '../src/explain.ts';
import { formatMarkdown, formatSummary, formatTable, formatTrend } from '../src/format.ts';
import { escapeForecastLabel, ForecastAccumulator, formatForecast } from '../src/forecast.ts';
import { LogSourceError, parseAll, type ParseDiagnostics } from '../src/parser.ts';
import { isKnownModel } from '../src/pricing.ts';
import { formatTree, formatTreeMarkdown } from '../src/tree.ts';
import type { LedgerReport, SubagentTreeNode } from '../src/types.ts';
import packageJson from '../package.json';

type Period = 'today' | 'week' | 'month';
type Plan = 'payg' | 'pro' | 'max';

interface Args {
	period: Period;
	markdown: boolean;
	json: boolean;
	plan: Plan;
	by: GroupKey;
	summary: boolean;
	tree: boolean;
	anonymize: boolean;
	budget?: number; // USD threshold; non-zero exit if exceeded
	verbose: boolean;
}

function periodRange(period: Period): { from: Date; to: Date } {
	const now = new Date();
	const to = new Date(now);
	const from = new Date(now);

	if (period === 'today') {
		from.setHours(0, 0, 0, 0);
	} else if (period === 'week') {
		from.setDate(from.getDate() - 7);
	} else {
		from.setDate(from.getDate() - 30);
	}
	return { from, to };
}

function usage(exitCode = 1): never {
	const write = exitCode === 0 ? console.log : console.error;
	write(`Usage:
  agent-ledger <today|week|month> [flags]    — aggregate views
  agent-ledger explain <sessionId> [--anonymize]
                                             — root-cause why one session was expensive (new in 0.6)
  agent-ledger forecast [--json] [--plan pro|max] [--verbose]
                                             — transparent next-7-day shadow-cost estimate
  agent-ledger watch [seconds]                — refresh today's cost (2..2147483 seconds; default: 10)

Flags:
  --summary                   One-screen dashboard (start here).
  --by <subagent|model|day|project|session|tool>
                              Group rows by:
                                subagent  (default) — agent attribution
                                model     — opus vs sonnet vs haiku
                                day       — daily ASCII bar chart
                                project   — by Claude Code project (decoded path)
                                session   — by session id (top spenders)
                                tool      — by Read/Bash/Write/Grep — what your turns burn on
  --tree                      Subagent graph: parent→child cost attribution.
                              The MOAT view: orchestrator → 3×researcher + 6×swift-dev = $312.
  --budget <USD>              Exit non-zero (code 2) if total cost > USD. Pipe-friendly.
  --md                        Markdown table output (good for sharing / commits)
  --json                      Raw JSON output for aggregate, summary, or forecast
  --plan pro|max              Mask grouped-table costs; forecast keeps shadow cost visible.
  --anonymize                 Replace project paths and session ids with safe placeholders.
  --verbose                   Print parse stats (files, turns, elapsed) to stderr.

Environment:
  NO_COLOR=1                  Disable ANSI colors
  FORCE_COLOR=1               Force colors when piping

Examples:
  agent-ledger forecast --plan max          # transparent 7-day same-rate projection
  agent-ledger week --summary               # the dashboard
  agent-ledger week --tree                  # subagent fan-out tree
  agent-ledger week --by tool               # which Claude tool ate the budget
  agent-ledger week --json | jq '.total.cost.totalCost'
  agent-ledger today --budget 50            # CI gate: fail if today > $50
`);
	process.exit(exitCode);
}

function explainUsage(exitCode = 1): never {
	const write = exitCode === 0 ? console.log : console.error;
	write(`Usage: agent-ledger explain <sessionId> [--anonymize]
  sessionId can be a full UUID or a letter, number, and hyphen prefix.
  Prefixes must match exactly one local session.`);
	process.exit(exitCode);
}

interface ForecastArgs {
	json: boolean;
	plan: Plan;
	verbose: boolean;
}

function parseForecastArgs(argv: string[]): ForecastArgs {
	let plan: Plan = 'payg';
	let json = false;
	let verbose = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === '--json') {
			json = true;
		} else if (flag === '--verbose') {
			verbose = true;
		} else if (flag === '--plan') {
			const next = argv[index + 1];
			if (next !== 'pro' && next !== 'max') {
				console.error('agent-ledger forecast: --plan requires pro or max');
				usage();
			}
			plan = next;
			index++;
		} else {
			console.error('agent-ledger forecast: unknown flag');
			usage();
		}
	}
	return { json, plan, verbose };
}

function parseArgs(argv: string[]): Args {
	const [period, ...rest] = argv;
	if (!period || !['today', 'week', 'month'].includes(period)) usage();

	let plan: Plan = 'payg';
	let by: GroupKey = 'subagent';
	let budget: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === '--plan') {
			const next = rest[i + 1];
			if (next === 'pro' || next === 'max') {
				plan = next;
				i++;
			} else {
				usage();
			}
		} else if (flag === '--by') {
			const next = rest[i + 1];
			if (
				next === 'subagent' ||
				next === 'model' ||
				next === 'day' ||
				next === 'project' ||
				next === 'session' ||
				next === 'tool'
			) {
				by = next;
				i++;
			} else {
				console.error(`agent-ledger: unknown --by value '${next}'`);
				usage();
			}
		} else if (flag === '--budget') {
			const next = rest[i + 1];
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) {
				console.error(`agent-ledger: --budget requires a positive number (got '${next}')`);
				usage();
			}
			budget = n;
			i++;
		} else if (
			flag !== '--md' &&
			flag !== '--json' &&
			flag !== '--summary' &&
			flag !== '--tree' &&
			flag !== '--anonymize' &&
			flag !== '--verbose'
		) {
			console.error(`agent-ledger: unknown flag '${flag}'`);
			usage();
		}
	}
	return {
		period: period as Period,
		markdown: rest.includes('--md'),
		json: rest.includes('--json'),
		plan,
		by,
		summary: rest.includes('--summary'),
		tree: rest.includes('--tree'),
		anonymize: rest.includes('--anonymize'),
		budget,
		verbose: rest.includes('--verbose'),
	};
}

interface ExplainArgs {
	sessionPrefix: string;
	anonymize: boolean;
}

function parseExplainArgs(argv: string[]): ExplainArgs {
	let sessionPrefix: string | undefined;
	let anonymize = false;

	for (const arg of argv) {
		if (arg === '--anonymize') {
			anonymize = true;
			continue;
		}
		if (arg.startsWith('-')) {
			console.error(
				'agent-ledger explain: unsupported flag (only --anonymize is accepted)',
			);
			explainUsage();
		}
		if (sessionPrefix !== undefined) {
			console.error('agent-ledger explain: expected exactly one sessionId argument');
			explainUsage();
		}
		sessionPrefix = arg;
	}

	if (!sessionPrefix) {
		console.error('agent-ledger explain: missing sessionId argument');
		explainUsage();
	}
	if (!/^[A-Za-z0-9-]+$/.test(sessionPrefix)) {
		console.error(
			'agent-ledger explain: sessionId may contain only letters, numbers, and hyphens',
		);
		explainUsage();
	}

	return { sessionPrefix, anonymize };
}

function anonymizeReport(report: LedgerReport, group: GroupKey): LedgerReport {
	if (group !== 'project' && group !== 'session') return report;
	const prefix = group === 'project' ? '~/repo-' : 'sess-';
	const labelFor = (i: number): string => {
		if (i < 26) return prefix + String.fromCharCode(65 + i);
		return prefix + String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
	};
	const newRows = report.rows.map((r, i) => ({ ...r, subagent: labelFor(i) }));
	return { ...report, rows: newRows };
}

function anonymizeTrees(roots: SubagentTreeNode[]): SubagentTreeNode[] {
	const labels = new Map<string, string>();
	const labelFor = (sessionId: string): string => {
		const existing = labels.get(sessionId);
		if (existing) return existing;
		const i = labels.size;
		const suffix =
			i < 26
				? String.fromCharCode(65 + i)
				: String.fromCharCode(65 + Math.floor(i / 26) - 1) +
					String.fromCharCode(65 + (i % 26));
		const label = `sess-${suffix}`;
		labels.set(sessionId, label);
		return label;
	};
	const visit = (node: SubagentTreeNode): SubagentTreeNode => ({
		...node,
		sessionId: labelFor(node.sessionId),
		children: node.children.map(visit),
	});
	return roots.map(visit);
}

function planMask(report: LedgerReport, plan: Plan): LedgerReport {
	if (plan === 'payg') return report;
	const zero = () => ({
		inputCost: 0,
		outputCost: 0,
		cacheCreation5mCost: 0,
		cacheCreation1hCost: 0,
		cacheReadCost: 0,
		serverToolUseCost: 0,
		totalCost: 0,
	});
	return {
		period: report.period,
		rows: report.rows.map((r) => ({ ...r, cost: zero() })),
		total: { ...report.total, cost: zero() },
	};
}

// `--watch` live-tail mode. Re-aggregates "today" every N seconds and
// prints a clean delta meter. Polling-based (no inotify) so it works on
// any platform Bun runs on. Ctrl-C to exit.
const MIN_WATCH_INTERVAL_SECONDS = 2;
const MAX_WATCH_INTERVAL_SECONDS = Math.floor(2_147_483_647 / 1000);

function watchUsageError(): never {
	console.error(
		`agent-ledger watch: interval must be a decimal integer from ${MIN_WATCH_INTERVAL_SECONDS} to ${MAX_WATCH_INTERVAL_SECONDS} seconds`,
	);
	console.error('Usage: agent-ledger watch [seconds]');
	process.exit(1);
}

function parseWatchInterval(args: string[]): number {
	if (args.length === 0) return 10;
	const raw = args[0];
	if (args.length !== 1 || raw === undefined || !/^[0-9]+$/.test(raw)) {
		watchUsageError();
	}
	const interval = Number(raw);
	if (
		!Number.isSafeInteger(interval) ||
		interval < MIN_WATCH_INTERVAL_SECONDS ||
		interval > MAX_WATCH_INTERVAL_SECONDS
	) {
		watchUsageError();
	}
	return interval;
}

async function watchCmd(interval: number): Promise<void> {
	let prevCost = 0;
	let prevTurnCount = 0;
	const t0 = Date.now();
	console.log(`agent-ledger watch — refreshing every ${interval}s · Ctrl-C to exit`);
	console.log('');
	const tick = async () => {
		const { from, to } = periodRange('today');
		const agg = new Aggregator('subagent', from, to);
		let turns = 0;
		for await (const turn of parseAll({ from, to })) {
			turns++;
			agg.add(turn);
		}
		const report = agg.finalize();
		const cost = report.total.cost.totalCost;
		const dCost = cost - prevCost;
		const dTurns = turns - prevTurnCount;
		const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
		const arrow = dCost > 0 ? '↑' : dCost < 0 ? '↓' : '·';
		const ts = new Date().toISOString().slice(11, 19);
		const top = report.rows[0];
		const topLabel = top ? `top: ${top.subagent} ${fmtUsdInline(top.cost.totalCost)}` : 'no data';
		console.log(
			`[${ts}] today $${cost.toFixed(2)}  ${arrow} +$${dCost.toFixed(2)}  · ${turns} turns (Δ${dTurns}) · ${topLabel} · live ${elapsedMin}m`,
		);
		prevCost = cost;
		prevTurnCount = turns;
	};
	await tick();
	const id = setInterval(() => {
		tick().catch((e) => console.error('watch tick error:', e));
	}, interval * 1000);
	process.on('SIGINT', () => {
		clearInterval(id);
		console.log('\nagent-ledger watch — exiting');
		process.exit(0);
	});
	// Keep process alive
	await new Promise(() => {});
}

const fmtUsdInline = (n: number): string => '$' + n.toFixed(n < 0.01 ? 4 : 2);

async function explainCmd(sessionPrefix: string, anonymize: boolean): Promise<void> {
	let analysis: Awaited<ReturnType<typeof analyzeSession>>;
	try {
		analysis = await analyzeSession(sessionPrefix);
	} catch (error) {
		if (error instanceof DuplicateSessionFileError) {
			console.error('agent-ledger explain: multiple local logs use this full session ID');
			console.error('  (remove or reconcile duplicate local log copies before retrying)');
			process.exit(1);
		}
		if (error instanceof AmbiguousSessionError) {
			console.error('agent-ledger explain: multiple sessions match the supplied ID');
			console.error(
				'  (use the prefix from `agent-ledger week --by session`, or the full ID)',
			);
			process.exit(1);
		}
		if (!anonymize) throw error;
		console.error('agent-ledger explain: unable to inspect local sessions');
		process.exit(1);
	}
	if (!analysis) {
		console.error(
			anonymize
				? 'agent-ledger explain: no session found matching the supplied ID'
				: `agent-ledger explain: no session found matching '${sessionPrefix}'`,
		);
		console.error(
			'  (try the prefix from `agent-ledger week --by session`, or the full ID)',
		);
		process.exit(1);
	}
	const heuristic = formatHeuristic(
		anonymize ? { ...analysis, sessionId: 'sess-A' } : analysis,
	);
	console.log(heuristic);
	const llm = await llmExplain(analysis);
	if (llm) {
		console.log('');
		console.log(llm);
	} else if (!process.env.ANTHROPIC_API_KEY) {
		console.log('');
		console.log(
			'💡 Set ANTHROPIC_API_KEY to enable LLM root-cause analysis (typically <$0.005/run via Haiku 4.5)',
		);
	}
}

async function forecastCmd(argv: string[]): Promise<void> {
	const args = parseForecastArgs(argv);
	const asOf = new Date();
	const projectsDir = join(homedir(), '.claude', 'projects');
	try {
		const source = await stat(projectsDir);
		if (!source.isDirectory()) throw new Error('not a directory');
		await access(projectsDir, constants.R_OK | constants.X_OK);
	} catch {
		console.error('agent-ledger forecast: Claude projects directory is not readable');
		process.exit(1);
	}

	const accumulator = new ForecastAccumulator(asOf, args.plan);
	const { historyFrom, historyToExclusive } = accumulator.window;
	// parseAll() currently uses an inclusive upper bound; subtract one
	// millisecond to preserve the forecast's [start, end) contract.
	const parserTo = new Date(historyToExclusive.getTime() - 1);
	const startedAt = Date.now();
	let candidateTurns = 0;
	const diagnostics: ParseDiagnostics = { malformedJsonLines: 0 };
	try {
		for await (const turn of parseAll({
			from: historyFrom,
			to: parserTo,
			projectsDir,
			strictSource: true,
			includeInvalidTimestamps: true,
			strictTimestamps: true,
			includeInvalidUsage: true,
			diagnostics,
		})) {
			candidateTurns++;
			accumulator.add(turn);
		}
	} catch (error) {
		const detail = error instanceof LogSourceError && error.reason === 'symbolic-link'
			? ' (symbolic link is not allowed)' : '';
		console.error(`agent-ledger forecast: failed to read Claude projects source${detail}`);
		process.exit(1);
	}
	const report = accumulator.finalize(diagnostics);

	if (report.amountsAreLowerBounds) {
		const gaps: string[] = [];
		gaps.push(...report.pricing.unpricedModels.map(escapeForecastLabel));
		if (report.pricing.missingModelTurns > 0) {
			gaps.push(`${report.pricing.missingModelTurns} missing-model turn(s)`);
		}
		if (report.records.malformedJsonLines > 0) {
			gaps.push(`${report.records.malformedJsonLines} malformed JSON line(s)`);
		}
		if (report.records.invalidTimestampTurns > 0) {
			gaps.push(`${report.records.invalidTimestampTurns} invalid-timestamp turn(s)`);
		}
		if (report.records.invalidUsageTurns > 0) {
			gaps.push(`${report.records.invalidUsageTurns} invalid-usage turn(s)`);
		}
		console.error(
			`agent-ledger forecast: incomplete cost coverage (${gaps.join(', ')}); ` +
				'all reported amounts are lower bounds',
		);
	}
	if (args.verbose) {
		console.error(
			`agent-ledger forecast: parsed ${candidateTurns} candidate turns in ${Date.now() - startedAt}ms`,
		);
	}

	console.log(args.json ? JSON.stringify(report, null, 2) : formatForecast(report));
}

async function main(): Promise<void> {
	const cliArgs = process.argv.slice(2);
	const command = cliArgs[0];
	if (command === 'help') {
		usage(0);
	}
	if (command === 'explain') {
		const explainArgv = cliArgs.slice(1);
		if (
			explainArgv.length === 1 &&
			(explainArgv[0] === '--help' || explainArgv[0] === '-h')
		) {
			explainUsage(0);
		}
		const args = parseExplainArgs(explainArgv);
		return explainCmd(args.sessionPrefix, args.anonymize);
	}
	if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
		usage(0);
	}
	if (command === '--version' || command === '-v') {
		console.log(packageJson.version);
		return;
	}

	// Subcommand dispatch.
	if (command === 'watch') {
		const interval = parseWatchInterval(cliArgs.slice(1));
		return watchCmd(interval);
	}
	if (command === 'forecast') {
		return forecastCmd(cliArgs.slice(1));
	}
	const args = parseArgs(cliArgs);
	const { from, to } = periodRange(args.period);
	const t0 = Date.now();

	// Determine which aggregators we need based on flags.
	// Single parser pass dispatches to all in parallel — no buffering.
	const aggBySub = new Aggregator('subagent', from, to);
	const aggByMod = args.summary ? new Aggregator('model', from, to) : undefined;
	const aggByDay = args.summary ? new Aggregator('day', from, to) : undefined;
	const aggByProj = args.summary ? new Aggregator('project', from, to) : undefined;
	const aggUser = !args.summary && !args.tree ? new Aggregator(args.by, from, to) : undefined;
	const graph = args.tree ? new SubagentGraph() : undefined;
	const allSessionIds = args.by === 'session' && aggUser ? [] as string[] : undefined;

	let turnCount = 0;
	let skippedRecordCount = 0;
	const unknownModels = new Set<string>();
	try {
		for await (const turn of parseAll({
			from,
			to,
			onSkippedRecord: () => { skippedRecordCount++; },
			...(allSessionIds
				? { onSessionLog: (sessionId: string) => allSessionIds.push(sessionId) }
				: {}),
		})) {
			turnCount++;
			if (turn.model && !isKnownModel(turn.model)) {
				unknownModels.add(turn.model);
			}
			aggBySub.add(turn);
			aggByMod?.add(turn);
			aggByDay?.add(turn);
			aggByProj?.add(turn);
			aggUser?.add(turn);
			graph?.add(turn);
		}
	} catch (error) {
		if (!args.anonymize) throw error;
		console.error('agent-ledger: unable to inspect local session logs');
		process.exit(1);
	}

	if (skippedRecordCount > 0) {
		console.error(`agent-ledger: skipped ${skippedRecordCount} invalid log record(s); cost totals may be incomplete`);
	}
	if (unknownModels.size > 0) {
		console.error(
			'agent-ledger: no verified price for model(s): ' +
				[...unknownModels].sort().join(', ') +
				'; their token cost is shown as $0.00',
		);
	}

	if (args.verbose) {
		const elapsed = Date.now() - t0;
		console.error(
			`agent-ledger: parsed ${turnCount} turns from ~/.claude/projects in ${elapsed}ms`,
		);
	}

	let totalCost = aggBySub.finalize().total.cost.totalCost;

	if (args.tree) {
		const rawRoots = graph!.finalize(20);
		const roots = args.anonymize ? anonymizeTrees(rawRoots) : rawRoots;
		const out =
			args.json
				? JSON.stringify({ roots, totalCost }, null, 2)
				: args.markdown
					? formatTreeMarkdown(roots, totalCost)
					: formatTree(roots, totalCost);
		console.log(out);
	} else if (args.summary) {
		const bySubR = aggBySub.finalize();
		const byModR = aggByMod!.finalize();
		const byDayR = aggByDay!.finalize();
		let byProjR = aggByProj!.finalize();
		if (args.anonymize) byProjR = anonymizeReport(byProjR, 'project');
		totalCost = bySubR.total.cost.totalCost;
		if (args.json) {
			console.log(
				JSON.stringify(
					{ subagent: bySubR, model: byModR, day: byDayR, project: byProjR, totalCost },
					null,
					2,
				),
			);
		} else {
			console.log(formatSummary(bySubR, byModR, byDayR, byProjR, args.period));
		}
	} else {
		let report: LedgerReport;
		try {
			report = aggUser!.finalize(
				allSessionIds ? { sessionIds: allSessionIds } : {},
			);
		} catch (error) {
			if (error instanceof DuplicateSessionIdError) {
				console.error(
					'agent-ledger: duplicate full session IDs prevent an unambiguous --by session report',
				);
				process.exit(1);
			}
			if (!(error instanceof UnsupportedSessionIdError)) throw error;
			console.error('agent-ledger: a reported session cannot be labeled safely for explain');
			process.exit(1);
		}
		if (args.anonymize) report = anonymizeReport(report, args.by);
		// Keep the unmasked estimate for --budget even when --plan hides it.
		totalCost = report.total.cost.totalCost;
		report = planMask(report, args.plan);
		const output =
			args.json
				? JSON.stringify(report, null, 2)
				: args.markdown
					? formatMarkdown(report, args.period)
					: args.by === 'day'
						? formatTrend(report, args.period)
						: formatTable(report, args.period, args.by);
		console.log(output);
	}

	// Budget gate — non-zero exit code so this can be a CI/shell hook.
	if (args.budget !== undefined && totalCost > args.budget) {
		console.error(
			`agent-ledger: BUDGET EXCEEDED — total $${totalCost.toFixed(2)} > budget $${args.budget.toFixed(2)}`,
		);
		process.exit(2);
	}
}

main().catch((err) => {
	console.error('agent-ledger: fatal error');
	console.error(err);
	process.exit(1);
});
