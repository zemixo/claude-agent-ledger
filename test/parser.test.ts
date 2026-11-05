import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate } from '../src/aggregator.ts';
import { mergeAsyncIterables, parseAll, streamLogFiles } from '../src/parser.ts';
import type { SessionTurn } from '../src/types.ts';

const PROJECTS_DIR = join(import.meta.dir, 'fixtures', 'projects');

async function withTimeout<T>(promise: Promise<T>, timeoutMs = 100): Promise<T | 'timed-out'> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<'timed-out'>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

describe('parseAll()', () => {
	test('walks nested subagents/ directories and attributes subagent type', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		const agents = report.rows.map((r) => r.subagent).sort();
		expect(agents).toContain('(main)');
		expect(agents).toContain('Reality Checker');
	});

	test('main-session turns are attributed to (main), not to any subagent', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		const main = report.rows.find((r) => r.subagent === '(main)');
		const realityChecker = report.rows.find((r) => r.subagent === 'Reality Checker');

		expect(main).toBeDefined();
		expect(realityChecker).toBeDefined();
		expect(main!.sessionCount).toBe(1);
		expect(realityChecker!.sessionCount).toBe(1);
	});

	test('respects date range filter', async () => {
		const from = new Date('2030-01-01T00:00:00Z');
		const to = new Date('2030-01-02T00:00:00Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		expect(report.rows.length).toBe(0);
	});

	test('reports every session log before filtering turns by date', async () => {
		const discovered: string[] = [];
		for await (const _turn of parseAll({
			from: new Date('2030-01-01T00:00:00Z'),
			to: new Date('2030-01-02T00:00:00Z'),
			projectsDir: PROJECTS_DIR,
			onSessionLog: (sessionId) => discovered.push(sessionId),
		})) {
			// The fixture has no turns in 2030; discovery still covers every log.
		}

		expect(discovered.sort()).toEqual(['agent-deadbeef', 'session-abc']);
	});
	test('does not invent timestamps and can expose invalid records with diagnostics', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-parser-'));
		try {
			const project = join(root, 'project');
			mkdirSync(project);
			writeFileSync(
				join(project, 'damaged.jsonl'),
				[
					JSON.stringify({
						type: 'assistant',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}),
					'{malformed-json',
				].join('\n') + '\n',
			);

			const defaultTurns = [];
			for await (const turn of parseAll({ projectsDir: root })) defaultTurns.push(turn);
			expect(defaultTurns).toEqual([]);

			const diagnostics = { malformedJsonLines: 0 };
			const diagnosticTurns = [];
			for await (const turn of parseAll({
				projectsDir: root,
				includeInvalidTimestamps: true,
				diagnostics,
			})) {
				diagnosticTurns.push(turn);
			}
			expect(diagnosticTurns).toHaveLength(1);
			expect(diagnosticTurns[0]?.timestamp).toBe('');
			expect(diagnostics.malformedJsonLines).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('keeps aggregate validation while forecast explicitly preserves incomplete usage', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-parser-modes-'));
		try {
			const project = join(root, 'project');
			mkdirSync(project);
			writeFileSync(join(project, 'modes.jsonl'), [
				{ input_tokens: -1, output_tokens: 0 },
				{ input_tokens: 1 },
			].map((usage) => JSON.stringify({
				type: 'assistant', timestamp: '2026-08-03T12:00:00Z',
				message: { model: 'claude-sonnet-4-6', usage },
			})).join('\n') + '\n');

			const skipped: string[] = [];
			const discovered: string[] = [];
			const aggregateTurns = [];
			for await (const turn of parseAll({
				projectsDir: root,
				onSkippedRecord: (reason) => skipped.push(reason),
				onSessionLog: (id) => discovered.push(id),
			})) aggregateTurns.push(turn);
			expect(skipped).toEqual(['invalid_usage']);
			expect(discovered).toEqual(['modes']);
			expect(aggregateTurns.map((turn) => turn.usage)).toEqual([
				{ input_tokens: 1, output_tokens: 0 },
			]);

			const diagnosticTurns = [];
			for await (const turn of parseAll({ projectsDir: root, includeInvalidUsage: true })) {
				diagnosticTurns.push(turn);
			}
			const rawUsages: unknown[] = diagnosticTurns.map((turn) => turn.usage);
			expect(rawUsages).toEqual([
				{ input_tokens: -1, output_tokens: 0 },
				{ input_tokens: 1 },
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});


	test('keeps legacy timestamps for aggregates while forecast requires explicit RFC3339 instants', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-timestamp-modes-'));
		try {
			const project = join(root, 'project');
			mkdirSync(project);
			const timestamps = ['2026-08-03', '2026-08-03T12:00:00', '2026-08-03T12:00:00Z'];
			writeFileSync(join(project, 'timestamps.jsonl'), timestamps.map((timestamp) => JSON.stringify({
				type: 'assistant', timestamp,
				message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 0 } },
			})).join('\n') + '\n');
			const options = {
				projectsDir: root,
				from: new Date('2026-08-02T00:00:00Z'),
				to: new Date('2026-08-05T00:00:00Z'),
			};
			const aggregateTimestamps = [];
			for await (const turn of parseAll(options)) aggregateTimestamps.push(turn.timestamp);
			expect(aggregateTimestamps).toEqual(timestamps);

			const strictTimestamps = [];
			const skipped: string[] = [];
			for await (const turn of parseAll({
				...options, strictTimestamps: true,
				onSkippedRecord: (reason) => skipped.push(reason),
			})) strictTimestamps.push(turn.timestamp);
			expect(strictTimestamps).toEqual(['2026-08-03T12:00:00Z']);
			expect(skipped).toEqual(['invalid_timestamp', 'invalid_timestamp']);

			const diagnosticTimestamps = [];
			for await (const turn of parseAll({
				...options, strictTimestamps: true, includeInvalidTimestamps: true,
			})) diagnosticTimestamps.push(turn.timestamp);
			expect(diagnosticTimestamps).toEqual(timestamps);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

});

describe('mergeAsyncIterables()', () => {
	test('yields a turn before every source reaches EOF', async () => {
		let releaseTail!: () => void;
		const tail = new Promise<void>((resolve) => {
			releaseTail = resolve;
		});
		let fastFinished = false;

		async function* fastSource() {
			yield 'fast:first';
			await tail;
			fastFinished = true;
			yield 'fast:last';
		}

		async function* slowSource() {
			await tail;
			yield 'slow:first';
		}

		const merged = mergeAsyncIterables([slowSource(), fastSource()]);
		const first = await merged.next();

		expect(first).toEqual({ value: 'fast:first', done: false });
		expect(fastFinished).toBe(false);

		releaseTail();
		const rest: string[] = [];
		for await (const value of merged) rest.push(value);
		expect(rest.sort()).toEqual(['fast:last', 'slow:first']);
	});

	test('keeps at most one pending read per source while reading concurrently', async () => {
		let activeReads = 0;
		let maxActiveReads = 0;
		const maxReadsBySource = [0, 0, 0];
		const activeBySource = [0, 0, 0];
		const nextValueBySource = [0, 0, 0];

		const sources = [0, 1, 2].map((source) => ({
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<string>> {
						const value = nextValueBySource[source] ?? 0;
						if (value >= 3) return { value: undefined, done: true };
						nextValueBySource[source] = value + 1;
						activeReads++;
						activeBySource[source] = (activeBySource[source] ?? 0) + 1;
						maxActiveReads = Math.max(maxActiveReads, activeReads);
						maxReadsBySource[source] = Math.max(
							maxReadsBySource[source] ?? 0,
							activeBySource[source] ?? 0,
						);
						await Promise.resolve();
						activeReads--;
						activeBySource[source] = (activeBySource[source] ?? 1) - 1;
						return { value: `${source}:${value}`, done: false };
					},
				};
			},
		}));

		const values: string[] = [];
		for await (const value of mergeAsyncIterables(sources)) values.push(value);

		expect(maxActiveReads).toBe(3);
		expect(maxReadsBySource).toEqual([1, 1, 1]);
		expect(values).toHaveLength(9);
		for (const source of [0, 1, 2]) {
			expect(values.filter((value) => value.startsWith(`${source}:`))).toEqual([
				`${source}:0`,
				`${source}:1`,
				`${source}:2`,
			]);
		}
	});

	test('propagates a source error without waiting for a blocked sibling', async () => {
		const failure = new Error('broken stream');
		const returnCalls = [0, 0];
		const blocked = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<number>>(() => undefined),
					async return(): Promise<IteratorResult<number>> {
						returnCalls[0] = (returnCalls[0] ?? 0) + 1;
						return { value: undefined, done: true };
					},
				};
			},
		};
		const failing = {
			[Symbol.asyncIterator]() {
				return {
					next: () => Promise.reject<IteratorResult<number>>(failure),
					async return(): Promise<IteratorResult<number>> {
						returnCalls[1] = (returnCalls[1] ?? 0) + 1;
						return { value: undefined, done: true };
					},
				};
			},
		};

		const merged = mergeAsyncIterables([blocked, failing]);
		const outcome = await withTimeout(
			merged.next().then(
				() => 'resolved',
				(error: unknown) => (error === failure ? 'rejected' : 'wrong-error'),
			),
		);
		expect(outcome).toBe('rejected');
		expect(returnCalls).toEqual([1, 1]);
	});

	test('consumer cancellation does not wait for a blocked sibling', async () => {
		const returnCalls = [0, 0];
		const blocked = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<number>>(() => undefined),
					async return(): Promise<IteratorResult<number>> {
						returnCalls[0] = (returnCalls[0] ?? 0) + 1;
						return { value: undefined, done: true };
					},
				};
			},
		};
		const fast = {
			[Symbol.asyncIterator]() {
				let emitted = false;
				return {
					async next(): Promise<IteratorResult<number>> {
						if (emitted) return { value: undefined, done: true };
						emitted = true;
						return { value: 1, done: false };
					},
					async return(): Promise<IteratorResult<number>> {
						returnCalls[1] = (returnCalls[1] ?? 0) + 1;
						return { value: undefined, done: true };
					},
				};
			},
		};

		const merged = mergeAsyncIterables([blocked, fast]);
		expect(await merged.next()).toEqual({ value: 1, done: false });
		const outcome = await withTimeout(
			merged.return(undefined).then(() => 'returned'),
		);
		expect(outcome).toBe('returned');
		expect(returnCalls).toEqual([1, 1]);
	});

	test('closes initialized sources when later iterator setup throws', async () => {
		const setupError = new Error('iterator setup failed');
		let closed = 0;
		let started = 0;
		const initialized = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<number>> {
						started++;
						return { value: undefined, done: true };
					},
					async return(): Promise<IteratorResult<number>> {
						closed++;
						return { value: undefined, done: true };
					},
				};
			},
		};
		const broken = {
			[Symbol.asyncIterator](): AsyncIterator<number> {
				throw setupError;
			},
		};

		const merged = mergeAsyncIterables([initialized, broken]);
		await expect(merged.next()).rejects.toBe(setupError);
		expect(closed).toBe(1);
		expect(started).toBe(0);
	});

	test('does not close a source again after natural EOF', async () => {
		let returnCalls = 0;
		const complete = {
			[Symbol.asyncIterator]() {
				return {
					async next(): Promise<IteratorResult<number>> {
						return { value: undefined, done: true };
					},
					async return(): Promise<IteratorResult<number>> {
						returnCalls++;
						throw new Error('return after EOF');
					},
				};
			},
		};

		const merged = mergeAsyncIterables([complete]);
		expect(await merged.next()).toEqual({ value: undefined, done: true });
		expect(returnCalls).toBe(0);
	});

	test('production scheduler starts eight files without draining them', async () => {
		const files = Array.from({ length: 9 }, (_, index) => ({
			path: `session-${index}.jsonl`,
			projectId: 'synthetic-project',
			subagentType: undefined,
		}));
		const produced = Array.from({ length: files.length }, () => 0);

		async function* readLog(path: string): AsyncGenerator<SessionTurn> {
			const index = Number(path.match(/\d+/)?.[0]);
			for (let turn = 0; turn < 100; turn++) {
				produced[index] = (produced[index] ?? 0) + 1;
				yield {
					type: 'assistant',
					timestamp: '2026-08-03T00:00:00Z',
					sessionId: `session-${index}`,
					raw: null,
				};
			}
		}

		const turns = streamLogFiles(files, {}, readLog);
		expect((await turns.next()).done).toBe(false);
		expect(produced[8]).toBe(0);
		expect(produced.slice(0, 8).every((count) => count >= 1 && count <= 2)).toBe(true);
		expect(produced.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(9);
		let count = 1;
		for await (const _turn of turns) count++;
		expect(count).toBe(900);
		expect(produced).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100]);
	});
});
