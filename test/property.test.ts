// Property tests — invariants that must hold for ANY input, not just fixtures.
// (Backend audit recommendation: cover pricing math + aggregator math.)

import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import { Aggregator, SubagentGraph } from '../src/aggregator.ts';
import { costFor } from '../src/pricing.ts';
import type { SessionTurn, TokenUsage } from '../src/types.ts';

// Bounded-positive token counter — Anthropic emits non-negative integers.
const arbTokens = (): fc.Arbitrary<number> => fc.integer({ min: 0, max: 10_000_000 });

// Realistic Anthropic models that should price correctly.
const arbModel = (): fc.Arbitrary<string> =>
	fc.constantFrom(
		'claude-opus-4-7',
		'claude-sonnet-4-6',
		'claude-haiku-4-5-20251001',
		'claude-opus-4-6',
		'claude-sonnet-4-5',
	);

const arbUsage = (): fc.Arbitrary<TokenUsage> =>
	fc.record({
		input_tokens: arbTokens(),
		output_tokens: arbTokens(),
		cache_read_input_tokens: fc.option(arbTokens(), { nil: undefined }),
		cache_creation: fc.option(
			fc.record({
				ephemeral_5m_input_tokens: fc.option(arbTokens(), { nil: undefined }),
				ephemeral_1h_input_tokens: fc.option(arbTokens(), { nil: undefined }),
			}),
			{ nil: undefined },
		),
	});

const arbAssistantTurn = (): fc.Arbitrary<SessionTurn> =>
	fc
		.record({
			usage: arbUsage(),
			model: arbModel(),
			sessionId: fc.string({ minLength: 8, maxLength: 36 }),
			timestamp: fc.integer({ min: 1735689600000, max: 1798800000000 }).map(
				(ms) => new Date(ms).toISOString(),
			),
			subagentType: fc.option(fc.string({ minLength: 1, maxLength: 20 }), { nil: undefined }),
			projectId: fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: undefined }),
			parentSessionId: fc.option(fc.string({ minLength: 8, maxLength: 36 }), { nil: undefined }),
			toolUses: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 10 }), { maxLength: 5 }), {
				nil: undefined,
			}),
		})
		.map((r) => ({
			type: 'assistant' as const,
			...r,
		}));

describe('costFor() invariants', () => {
	test('cost is non-negative for any valid usage + model', () => {
		fc.assert(
			fc.property(arbUsage(), arbModel(), (usage, model) => {
				const c = costFor(usage, model);
				expect(c.totalCost).toBeGreaterThanOrEqual(0);
				expect(c.inputCost).toBeGreaterThanOrEqual(0);
				expect(c.outputCost).toBeGreaterThanOrEqual(0);
				expect(c.cacheReadCost).toBeGreaterThanOrEqual(0);
			}),
			{ numRuns: 200 },
		);
	});

	test('totalCost equals sum of components', () => {
		fc.assert(
			fc.property(arbUsage(), arbModel(), (usage, model) => {
				const c = costFor(usage, model);
				const sum =
					c.inputCost +
					c.outputCost +
					c.cacheCreation5mCost +
					c.cacheCreation1hCost +
					c.cacheReadCost +
					c.serverToolUseCost;
				// Floating point — allow tiny epsilon.
				expect(Math.abs(c.totalCost - sum)).toBeLessThan(1e-9);
			}),
			{ numRuns: 200 },
		);
	});

	test('cache_read is always cheaper than the same input as fresh tokens', () => {
		fc.assert(
			fc.property(arbTokens(), arbModel(), (n, model) => {
				const fresh = costFor({ input_tokens: n, output_tokens: 0 }, model).totalCost;
				const cached = costFor(
					{ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: n },
					model,
				).totalCost;
				// Cached should be ≤ fresh (90% discount).
				expect(cached).toBeLessThanOrEqual(fresh + 1e-9);
			}),
			{ numRuns: 100 },
		);
	});

	test('cache_creation_1h is always more expensive than cache_creation_5m for same tokens', () => {
		fc.assert(
			fc.property(fc.integer({ min: 1, max: 1_000_000 }), arbModel(), (n, model) => {
				const fiveMin = costFor(
					{
						input_tokens: 0,
						output_tokens: 0,
						cache_creation: { ephemeral_5m_input_tokens: n },
					},
					model,
				).totalCost;
				const oneH = costFor(
					{
						input_tokens: 0,
						output_tokens: 0,
						cache_creation: { ephemeral_1h_input_tokens: n },
					},
					model,
				).totalCost;
				expect(oneH).toBeGreaterThanOrEqual(fiveMin - 1e-9);
			}),
			{ numRuns: 100 },
		);
	});
});

describe('Aggregator invariants', () => {
	test('total.cost equals sum of row.cost across any group key', () => {
		fc.assert(
			fc.property(fc.array(arbAssistantTurn(), { minLength: 0, maxLength: 50 }), (turns) => {
				const agg = new Aggregator(
					'subagent',
					new Date('2025-01-01'),
					new Date('2027-01-01'),
				);
				for (const t of turns) agg.add(t);
				const report = agg.finalize();
				const rowSum = report.rows.reduce((s, r) => s + r.cost.totalCost, 0);
				expect(Math.abs(report.total.cost.totalCost - rowSum)).toBeLessThan(1e-6);
			}),
			{ numRuns: 100 },
		);
	});

	test('non-assistant turns are ignored (no cost contribution)', () => {
		fc.assert(
			fc.property(arbUsage(), arbModel(), (usage, model) => {
				const userTurn: SessionTurn = {
					type: 'user',
					usage,
					model,
					sessionId: 'sess',
					timestamp: '2026-04-23T00:00:00Z',
				};
				const agg = new Aggregator('subagent', new Date('2025-01-01'), new Date('2027-01-01'));
				agg.add(userTurn);
				const report = agg.finalize();
				expect(report.total.cost.totalCost).toBe(0);
			}),
			{ numRuns: 50 },
		);
	});
});

describe('SubagentGraph invariants', () => {
	test('parent totalCost ≥ self cost (children only add)', () => {
		fc.assert(
			fc.property(
				fc.array(arbAssistantTurn(), { minLength: 1, maxLength: 30 }),
				(turns) => {
					const graph = new SubagentGraph();
					for (const t of turns) graph.add(t);
					const roots = graph.finalize(50);
					for (const r of roots) {
						expect(r.totalCost).toBeGreaterThanOrEqual(r.selfCost - 1e-9);
					}
				},
			),
			{ numRuns: 50 },
		);
	});
});
