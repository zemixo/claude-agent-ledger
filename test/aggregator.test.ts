import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { aggregate, Aggregator, SubagentGraph, DuplicateSessionIdError, UnsupportedSessionIdError } from '../src/aggregator.ts';
import { parseFile } from '../src/parser.ts';
import type { SessionTurn } from '../src/types.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'sample.jsonl');

function zeroCostTurn(
	sessionId: string,
	subagentType: string,
	parentSessionId?: string,
): SessionTurn {
	return {
		type: 'assistant',
		timestamp: '2026-04-21T12:00:00Z',
		sessionId,
		subagentType,
		parentSessionId,
		model: '<synthetic>',
		usage: { input_tokens: 0, output_tokens: 0 },
		raw: null,
	};
}

function sonnet5Turn(timestamp: string): SessionTurn {
	return {
		type: 'assistant',
		timestamp,
		sessionId: 'pricing-boundary-session',
		model: 'claude-sonnet-5',
		usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
		raw: {},
	};
}

function sessionTurn(sessionId: string, inputTokens: number): SessionTurn {
	return {
		type: 'assistant',
		timestamp: '2026-04-21T12:00:00Z',
		sessionId,
		model: 'claude-sonnet-4-6',
		usage: { input_tokens: inputTokens, output_tokens: 0 },
		raw: {},
	};
}

function pricedTurn(sessionId: string, parentSessionId?: string): SessionTurn {
	return {
		type: 'assistant',
		timestamp: '2026-04-21T12:00:00Z',
		sessionId,
		subagentType: 'synthetic-agent',
		parentSessionId,
		model: 'claude-sonnet-4-6',
		usage: { input_tokens: 1_000_000, output_tokens: 0 },
		raw: null,
	};
}

describe('aggregate()', () => {
	test('groups assistant turns by subagent', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to);

		const agents = report.rows.map((r) => r.subagent);
		expect(agents).toContain('ios-factory');
		expect(agents).toContain('Reality Checker');
		expect(agents).toContain('(main)');
	});

	test('skips user turns (no usage data)', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to);

		// 4 assistant turns in fixture (3 subagents, some with >1 turn each).
		const totalSessions = report.total.sessionCount;
		expect(totalSessions).toBeGreaterThan(0);
	});

	test('rows are sorted by total cost descending', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to);

		for (let i = 1; i < report.rows.length; i++) {
			const prev = report.rows[i - 1]!.cost.totalCost;
			const curr = report.rows[i]!.cost.totalCost;
			expect(prev).toBeGreaterThanOrEqual(curr);
		}
	});

	test('total row sums all agent rows', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to);

		const sumCost = report.rows.reduce((s, r) => s + r.cost.totalCost, 0);
		expect(report.total.cost.totalCost).toBeCloseTo(sumCost, 6);
	});

	test('--by model groups by model id', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to, 'model');

		// Fixture has assistant turns with claude-opus-4-7 model
		const labels = report.rows.map((r) => r.subagent);
		expect(labels.some((l) => l.includes('claude-') || l === '(no-model)')).toBe(true);
	});

	test('--by day groups by ISO date and sorts chronologically', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const report = await aggregate(parseFile(FIXTURE), from, to, 'day');

		// Each row label should look like a date YYYY-MM-DD
		for (const row of report.rows) {
			expect(row.subagent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
		// Ascending date order
		for (let i = 1; i < report.rows.length; i++) {
			expect(report.rows[i - 1]!.subagent <= report.rows[i]!.subagent).toBe(true);
		}
	});

	test('equal-cost rows use a stable label tie-breaker', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const aggregator = new Aggregator('subagent', from, to);
		aggregator.add(zeroCostTurn('session-z', 'zeta'));
		aggregator.add(zeroCostTurn('session-a', 'alpha'));

		expect(aggregator.finalize().rows.map((row) => row.subagent)).toEqual([
			'alpha',
			'zeta',
		]);
	});

	test('equal-cost tree nodes use a stable session tie-breaker', () => {
		const graph = new SubagentGraph();
		graph.add(zeroCostTurn('root-z', 'zeta'));
		graph.add(zeroCostTurn('root-a', 'alpha'));

		expect(graph.finalize().map((node) => node.sessionId)).toEqual([
			'root-a',
			'root-z',
		]);
	});
	test('prices each turn at the rate effective for its timestamp', () => {
		const from = new Date('2026-08-31T00:00:00Z');
		const to = new Date('2026-09-01T23:59:59Z');
		const aggregator = new Aggregator('day', from, to);
		aggregator.add(sonnet5Turn('2026-08-31T23:59:59Z'));
		aggregator.add(sonnet5Turn('2026-09-01T00:00:00Z'));

		const report = aggregator.finalize();
		expect(report.rows.map((row) => row.cost.totalCost)).toEqual([12, 18]);
		expect(report.total.cost.totalCost).toBe(30);
	});

	test('subagent trees preserve historical rates across a price boundary', () => {
		const graph = new SubagentGraph();
		graph.add(sonnet5Turn('2026-08-31T23:59:59Z'));
		graph.add(sonnet5Turn('2026-09-01T00:00:00Z'));

		const roots = graph.finalize();
		expect(roots).toHaveLength(1);
		expect(roots[0]?.selfCost).toBe(30);
		expect(roots[0]?.totalCost).toBe(30);
	});
	test('--by session keeps colliding ids and their costs separate', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const firstId = 'agent-aa-first';
		const secondId = 'agent-aa-second';
		const outsideId = 'agent-aa-third-outside';
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn(firstId, 1_000_000));
		agg.add(sessionTurn(secondId, 2_000_000));

		const report = agg.finalize({ sessionIds: [outsideId, secondId, firstId] });
		const rowsByLabel = new Map(report.rows.map((row) => [row.subagent, row]));

		expect([...rowsByLabel.keys()].sort()).toEqual(['agent-aa-f', 'agent-aa-s']);
		expect(rowsByLabel.get('agent-aa-f')!.inputTokens).toBe(1_000_000);
		expect(rowsByLabel.get('agent-aa-s')!.inputTokens).toBe(2_000_000);
		expect(report.rows.every((row) => row.sessionCount === 1)).toBe(true);
		expect(report.total.sessionCount).toBe(2);
	});

	test('--by session labels are deterministic and preserve an exact shorter id', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const shorterId = 'abcdefgh';
		const longerId = 'abcdefgh-longer';
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn(shorterId, 1));
		agg.add(sessionTurn(longerId, 1));

		const forward = agg.finalize({ sessionIds: [shorterId, longerId] });
		const reverse = agg.finalize({ sessionIds: [longerId, shorterId] });

		expect(forward.rows.map((row) => row.subagent).sort()).toEqual([
			'abcdefgh',
			'abcdefgh-',
		]);
		expect(reverse.rows.map((row) => row.subagent).sort()).toEqual(
			forward.rows.map((row) => row.subagent).sort(),
		);
	});

	test('--by session fails closed when full ids are duplicated across logs', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const duplicateId = 'duplicate-session-id';
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn(duplicateId, 1));

		expect(() =>
			agg.finalize({ sessionIds: [duplicateId, duplicateId] }),
		).toThrow(DuplicateSessionIdError);
	});

	test('--by session ignores duplicated logs that have no row in the report', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const currentId = 'current-session-id';
		const outsideId = 'outside-session-id';
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn(currentId, 1));

		const report = agg.finalize({
			sessionIds: [currentId, outsideId, outsideId],
		});
		expect(report.rows.map((row) => row.subagent)).toEqual(['current-']);
	});

	test('--by session rejects row ids that explain cannot accept safely', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn('agent_bad-session', 1));

		expect(() => agg.finalize()).toThrow(UnsupportedSessionIdError);
	});

	test('--by session accepts a safe prefix before unsupported filename characters', () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');
		const agg = new Aggregator('session', from, to);
		agg.add(sessionTurn('abcdefgh_unsupported-suffix', 1));

		expect(agg.finalize().rows.map((row) => row.subagent)).toEqual(['abcdefgh']);
	});
});

describe('SubagentGraph', () => {
	test('promotes an in-range child when its parent is outside the selected period', () => {
		const graph = new SubagentGraph();
		graph.add(pricedTurn('in-range-child', 'outside-period-parent'));

		const roots = graph.finalize();
		expect(roots).toHaveLength(1);
		expect(roots[0]?.sessionId).toBe('in-range-child');
		expect(roots[0]?.totalCost).toBeCloseTo(3, 6);
	});

	test('keeps an in-range child nested when its parent is present', () => {
		const graph = new SubagentGraph();
		graph.add(pricedTurn('in-range-parent'));
		graph.add(pricedTurn('in-range-child', 'in-range-parent'));

		const roots = graph.finalize();
		expect(roots).toHaveLength(1);
		expect(roots[0]?.sessionId).toBe('in-range-parent');
		expect(roots[0]?.children.map((child) => child.sessionId)).toEqual([
			'in-range-child',
		]);
		expect(roots[0]?.totalCost).toBeCloseTo(6, 6);
	});
});
