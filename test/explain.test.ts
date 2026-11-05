import { expect, test } from 'bun:test';
import { analyzeTurns, llmExplain } from '../src/explain.ts';
import type { SessionTurn } from '../src/types.ts';

function sonnet5Turn(timestamp: string): SessionTurn {
	return {
		type: 'assistant',
		timestamp,
		sessionId: 'pricing-boundary-session',
		model: 'claude-sonnet-5',
		usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
	};
}

test('historical explain prices each turn at its own timestamp', () => {
	const analysis = analyzeTurns(
		[
			sonnet5Turn('2026-08-31T23:59:59Z'),
			sonnet5Turn('2026-09-01T00:00:00Z'),
		],
		'pricing-boundary',
	);

	expect(analysis.totalCost).toBe(30);
	expect(analysis.models.get('claude-sonnet-5')).toBe(30);
	expect(analysis.topTurns.map((turn) => turn.cost)).toEqual([18, 12]);
});

test('explain gives TTL-split cache counters precedence over the legacy flat total', () => {
	const cases = [
		{ cache: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 100 } }, fiveMin: 0, oneHour: 100 },
		{ cache: { cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100 } }, fiveMin: 100, oneHour: 0 },
		{ cache: { cache_creation_input_tokens: 100 }, fiveMin: 100, oneHour: 0 },
	];
	for (const { cache, fiveMin, oneHour } of cases) {
		const analysis = analyzeTurns([{
			type: 'assistant', timestamp: '2026-08-02T12:00:00Z',
			sessionId: 'synthetic-cache-session', model: 'claude-sonnet-4-6',
			usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100, ...cache },
		}], 'synthetic-cache-session');
		expect(analysis.topTurns[0]?.cacheCreate5m).toBe(fiveMin);
		expect(analysis.topTurns[0]?.cacheCreate1h).toBe(oneHour);
		expect(analysis.cacheReuseRatio).toBe(1);
	}
});

const privateAnalysis = {
	sessionId: 'private-session-123',
	subagentType: 'Reality Checker',
	totalCost: 1.23,
	turnCount: 1,
	models: new Map([['claude-sonnet-4-6', 1.23]]),
	tools: new Map([['Read', 1]]),
	cacheReuseRatio: 10,
	topTurns: [
		{
			turnIndex: 1,
			timestamp: '2026-07-23T00:00:00Z',
			model: 'claude-sonnet-4-6',
			cost: 1.23,
			inputTokens: 100,
			outputTokens: 20,
			cacheCreate5m: 0,
			cacheCreate1h: 0,
			cacheRead: 1000,
			tools: ['Read'],
		},
	],
};

test('LLM explain redacts the session identifier before the API request', async () => {
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.ANTHROPIC_API_KEY;
	let requestBody: Record<string, unknown> | undefined;

	process.env.ANTHROPIC_API_KEY = 'test-key';
	globalThis.fetch = (async (_input, init) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(
			JSON.stringify({
				content: [{ type: 'text', text: '- Mock verdict' }],
				usage: { input_tokens: 100, output_tokens: 20 },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	}) as typeof fetch;

	try {
		const result = await llmExplain(privateAnalysis);

		const messages = requestBody?.messages as Array<{ content: string }>;
		expect(messages[0]?.content).toContain('Session [redacted]');
		expect(messages[0]?.content).not.toContain('private-session-123');
		expect(result).toContain('Mock verdict');
	} finally {
		globalThis.fetch = originalFetch;
		if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalKey;
	}
});

test('LLM explain does not echo transport errors or API keys', async () => {
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.ANTHROPIC_API_KEY;
	const originalConsoleError = console.error;
	const privateKey = 'private-api-key-value\ninvalid';
	const errors: string[] = [];

	process.env.ANTHROPIC_API_KEY = privateKey;
	globalThis.fetch = (async (
		_input: Parameters<typeof fetch>[0],
		_init?: Parameters<typeof fetch>[1],
	) => {
		throw new Error(`invalid x-api-key header: ${privateKey}`);
	}) as unknown as typeof fetch;
	console.error = (...values: unknown[]) => {
		errors.push(values.map(String).join(' '));
	};

	try {
		const result = await llmExplain(privateAnalysis);
		const stderr = errors.join('\n');
		expect(result).toBeUndefined();
		expect(stderr).toContain('LLM call failed');
		expect(stderr).toContain('falling back to heuristic');
		expect(stderr).not.toContain(privateKey);
		expect(stderr).not.toContain('private-api-key-value');
		expect(stderr).not.toContain('invalid x-api-key header');
	} finally {
		globalThis.fetch = originalFetch;
		console.error = originalConsoleError;
		if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalKey;
	}
});
