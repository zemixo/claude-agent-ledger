import { describe, expect, test } from 'bun:test';
import { costFor, costForTimestamp, isKnownModel } from '../src/pricing.ts';

describe('costFor()', () => {
	test('Opus 4.7 output is $25/M', () => {
		const cost = costFor(
			{ input_tokens: 0, output_tokens: 1_000_000 },
			'claude-opus-4-7',
		);
		expect(cost.outputCost).toBeCloseTo(25, 6);
	});

	test('Opus 4.7 input is $5/M', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 0 },
			'claude-opus-4-7',
		);
		expect(cost.inputCost).toBeCloseTo(5, 6);
	});

	test('5-minute cache creation is 1.25× base input', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation: { ephemeral_5m_input_tokens: 1_000_000 },
			},
			'claude-opus-4-7',
		);
		// Opus input $5 × 1.25 = $6.25 per 1M
		expect(cost.cacheCreation5mCost).toBeCloseTo(6.25, 4);
		expect(cost.cacheCreation1hCost).toBeCloseTo(0, 6);
	});

	test('1-hour cache creation is 2× base input (the TTL trap)', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
			},
			'claude-opus-4-7',
		);
		// Opus input $5 × 2 = $10 per 1M
		expect(cost.cacheCreation1hCost).toBeCloseTo(10, 4);
		expect(cost.cacheCreation5mCost).toBeCloseTo(0, 6);
	});

	test('cache read is 10% of base input', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: 1_000_000,
			},
			'claude-opus-4-7',
		);
		// Opus input $5 × 0.1 = $0.50 per 1M
		expect(cost.cacheReadCost).toBeCloseTo(0.5, 4);
	});

	test('legacy flat cache_creation_input_tokens falls back to 5m TTL pricing', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 1_000_000,
			},
			'claude-opus-4-7',
		);
		expect(cost.cacheCreation5mCost).toBeCloseTo(6.25, 4);
	});

	test('Opus 4.6 uses the current $5/M input price', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 0 },
			'claude-opus-4-6',
		);
		expect(cost.inputCost).toBeCloseTo(5, 6);
	});

	test('prior-generation Opus 4.1 keeps its historical $15/M input price', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 0 },
			'claude-opus-4-1-20250805',
		);
		expect(cost.inputCost).toBeCloseTo(15, 6);
	});

	test('Sonnet 5 uses the introductory price through 2026-08-31', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 1_000_000 },
			'claude-sonnet-5',
			new Date('2026-08-31T23:59:59Z'),
		);
		expect(cost.inputCost).toBeCloseTo(2, 6);
		expect(cost.outputCost).toBeCloseTo(10, 6);
	});

	test('Sonnet 5 switches to standard pricing on 2026-09-01', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 1_000_000 },
			'claude-sonnet-5',
			new Date('2026-09-01T00:00:00Z'),
		);
		expect(cost.inputCost).toBeCloseTo(3, 6);
		expect(cost.outputCost).toBeCloseTo(15, 6);
	});

	test('timestamp pricing preserves current-rate fallback for malformed legacy timestamps', () => {
		const cost = costForTimestamp(
			{ input_tokens: 1_000_000, output_tokens: 1_000_000 },
			'claude-sonnet-5',
			'not-a-timestamp',
			new Date('2026-08-31T23:59:59Z'),
		);
		expect(cost.inputCost).toBeCloseTo(2, 6);
		expect(cost.outputCost).toBeCloseTo(10, 6);
	});

	test('Haiku 4.5 uses $1/M input and $5/M output', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 1_000_000 },
			'claude-haiku-4-5-20251001',
		);
		expect(cost.inputCost).toBeCloseTo(1, 6);
		expect(cost.outputCost).toBeCloseTo(5, 6);
	});

	test('Fable 5 and Mythos 5 use $10/M input and $50/M output', () => {
		for (const model of ['claude-fable-5', 'claude-mythos-5']) {
			const cost = costFor(
				{ input_tokens: 1_000_000, output_tokens: 1_000_000 },
				model,
			);
			expect(cost.inputCost).toBeCloseTo(10, 6);
			expect(cost.outputCost).toBeCloseTo(50, 6);
		}
	});

	test('unknown future model is not assigned an invented family price', () => {
		const cost = costFor(
			{ input_tokens: 1_000_000, output_tokens: 0 },
			'claude-opus-9-9',
		);
		expect(cost.inputCost).toBe(0);
		expect(isKnownModel('claude-opus-9-9')).toBe(false);
	});

	test('<synthetic> model is free', () => {
		const cost = costFor(
			{
				input_tokens: 1_000_000,
				output_tokens: 1_000_000,
				cache_read_input_tokens: 1_000_000,
			},
			'<synthetic>',
		);
		expect(cost.totalCost).toBe(0);
	});

	test('isKnownModel recognizes current, prior, and family matches', () => {
		expect(isKnownModel('claude-opus-4-7')).toBe(true);
		expect(isKnownModel('claude-opus-4-7-provider-suffix')).toBe(true);
		expect(isKnownModel('claude-opus-4-6')).toBe(true);
		expect(isKnownModel('claude-fable-5')).toBe(true);
		expect(isKnownModel('claude-mythos-5')).toBe(true);
		expect(isKnownModel('claude-sonnet-5')).toBe(true);
		expect(isKnownModel('claude-sonnet-4-6')).toBe(true);
		expect(isKnownModel('<synthetic>')).toBe(true);
		expect(isKnownModel('something-entirely-unknown')).toBe(false);
		expect(isKnownModel(undefined)).toBe(false);
	});

	test('server_tool_use: web_search at $0.01/req', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				server_tool_use: { web_search_requests: 100 },
			},
			'claude-opus-4-7',
		);
		// 100 × $0.01 = $1.00
		expect(cost.serverToolUseCost).toBeCloseTo(1.0, 6);
		expect(cost.totalCost).toBeCloseTo(1.0, 6);
	});

	test('server_tool_use: web_fetch has no per-request charge', () => {
		const cost = costFor(
			{
				input_tokens: 0,
				output_tokens: 0,
				server_tool_use: { web_search_requests: 50, web_fetch_requests: 50 },
			},
			'claude-opus-4-7',
		);
		// Only the 50 web searches are billed. Web fetch adds token cost only.
		expect(cost.serverToolUseCost).toBeCloseTo(0.5, 6);
	});

	test('server_tool_use absent → no cost', () => {
		const cost = costFor(
			{ input_tokens: 1000, output_tokens: 1000 },
			'claude-opus-4-7',
		);
		expect(cost.serverToolUseCost).toBe(0);
	});
});
