import type { CostBreakdown, ModelId, TokenUsage } from './types.ts';

// Prices are per 1M tokens, USD. Keep in sync with
// https://platform.claude.com/docs/en/about-claude/pricing as of 2026-07-23.
//
// Prompt caching (Anthropic):
//   cache_creation 5-min TTL: 1.25× base input rate
//   cache_creation 1-hour TTL: 2×    base input rate
//   cache_read (any TTL):      0.10× base input rate (90% discount)
//
// We include both current and prior-generation model IDs because real logs span
// version bumps (Claude Code does not auto-rewrite historical logs when you upgrade).
const SONNET_5_STANDARD_PRICE_START = new Date('2026-09-01T00:00:00Z');
const SONNET_5_INTRO_RATE = { input: 2, output: 10 };
const SONNET_5_STANDARD_RATE = { input: 3, output: 15 };

const PRICING: Record<string, { input: number; output: number }> = {
	// Current generation (2026-07)
	'claude-fable-5': { input: 10, output: 50 },
	'claude-mythos-5': { input: 10, output: 50 },
	'claude-opus-4-8': { input: 5, output: 25 },
	'claude-opus-4-7': { input: 5, output: 25 },
	'claude-opus-4-6': { input: 5, output: 25 },
	'claude-opus-4-5': { input: 5, output: 25 },
	// resolveModel applies the introductory rate through 2026-08-31.
	'claude-sonnet-5': SONNET_5_STANDARD_RATE,
	'claude-sonnet-4-6': { input: 3, output: 15 },
	'claude-sonnet-4-5': { input: 3, output: 15 },
	'claude-haiku-4-5-20251001': { input: 1, output: 5 },
	'claude-haiku-4-5': { input: 1, output: 5 },
	// Prior generation (still appears in logs written before model upgrades)
	'claude-opus-4-1-20250805': { input: 15, output: 75 },
	'claude-opus-4-20250514': { input: 15, output: 75 },
	'claude-sonnet-4-20250514': { input: 3, output: 15 },
	'claude-haiku-3-5-20241022': { input: 0.8, output: 4 },
	'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
	// Kept for the aliases observed in older Claude Code logs.
	'claude-haiku-4-0': { input: 0.8, output: 4 },
};

// Internal Claude Code markers that we should treat as free.
// `<synthetic>` turns are context summaries / compaction events with no real API call.
const FREE_MODELS = new Set<string>(['<synthetic>']);

const CACHE_5M_MULTIPLIER = 1.25;
const CACHE_1H_MULTIPLIER = 2.0;
const CACHE_READ_MULTIPLIER = 0.1;

// Anthropic server-tool pricing (official pricing docs as of 2026-07-23):
//   Web search: $10 per 1,000 requests = $0.01 / request
//   Web fetch:  no per-request charge; fetched content still incurs token costs
const WEB_SEARCH_PRICE_PER_REQUEST = 0.01;
const WEB_FETCH_PRICE_PER_REQUEST = 0;

function resolveModel(model: ModelId | undefined, asOf: Date): { input: number; output: number } {
	if (!model) return { input: 0, output: 0 };
	if (FREE_MODELS.has(model)) return { input: 0, output: 0 };
	if (model === 'claude-sonnet-5' || model.startsWith('claude-sonnet-5-')) {
		return asOf < SONNET_5_STANDARD_PRICE_START
			? SONNET_5_INTRO_RATE
			: SONNET_5_STANDARD_RATE;
	}
	const exact = PRICING[model];
	if (exact) return exact;
	// A provider/date-suffixed ID can inherit a verified base model's rate.
	// Unknown future model families deliberately return zero instead of silently
	// inventing a price; the CLI warns when it sees one.
	for (const key of Object.keys(PRICING)) {
		if (model.startsWith(`${key}-`)) {
			return PRICING[key] as { input: number; output: number };
		}
	}
	return { input: 0, output: 0 };
}

interface CacheBreakdown {
	fiveMin: number;
	oneHour: number;
}

function splitCacheCreation(usage: TokenUsage): CacheBreakdown {
	if (usage.cache_creation) {
		return {
			fiveMin: usage.cache_creation.ephemeral_5m_input_tokens ?? 0,
			oneHour: usage.cache_creation.ephemeral_1h_input_tokens ?? 0,
		};
	}
	return {
		fiveMin: usage.cache_creation_input_tokens ?? 0,
		oneHour: 0,
	};
}

export function costFor(
	usage: TokenUsage,
	model: ModelId | undefined,
	asOf: Date = new Date(),
): CostBreakdown {
	const rate = resolveModel(model, asOf);
	const cacheRead = usage.cache_read_input_tokens ?? 0;
	const { fiveMin, oneHour } = splitCacheCreation(usage);

	const perMillion = (tokens: number, price: number) => (tokens / 1_000_000) * price;

	const inputCost = perMillion(usage.input_tokens, rate.input);
	const outputCost = perMillion(usage.output_tokens, rate.output);
	const cacheCreation5mCost = perMillion(fiveMin, rate.input * CACHE_5M_MULTIPLIER);
	const cacheCreation1hCost = perMillion(oneHour, rate.input * CACHE_1H_MULTIPLIER);
	const cacheReadCost = perMillion(cacheRead, rate.input * CACHE_READ_MULTIPLIER);

	const webSearchReqs = usage.server_tool_use?.web_search_requests ?? 0;
	const webFetchReqs = usage.server_tool_use?.web_fetch_requests ?? 0;
	const serverToolUseCost =
		webSearchReqs * WEB_SEARCH_PRICE_PER_REQUEST +
		webFetchReqs * WEB_FETCH_PRICE_PER_REQUEST;

	return {
		inputCost,
		outputCost,
		cacheCreation5mCost,
		cacheCreation1hCost,
		cacheReadCost,
		serverToolUseCost,
		totalCost:
			inputCost +
			outputCost +
			cacheCreation5mCost +
			cacheCreation1hCost +
			cacheReadCost +
			serverToolUseCost,
	};
}

export function costForTimestamp(
	usage: TokenUsage,
	model: ModelId | undefined,
	timestamp: string,
	fallbackAsOf: Date = new Date(),
): CostBreakdown {
	const parsedTimestamp = new Date(timestamp);
	const asOf = Number.isNaN(parsedTimestamp.getTime()) ? fallbackAsOf : parsedTimestamp;
	return costFor(usage, model, asOf);
}

export function isKnownModel(model: ModelId | undefined): boolean {
	if (!model) return false;
	if (FREE_MODELS.has(model)) return true;
	if (PRICING[model]) return true;
	return Object.keys(PRICING).some((key) => model.startsWith(`${key}-`));
}
