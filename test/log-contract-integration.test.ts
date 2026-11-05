import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ForecastAccumulator } from '../src/forecast.ts';
import { createParseDiagnostics } from '../src/log-contract.ts';
import { parseAll, type ParseOptions } from '../src/parser.ts';
import { costFor } from '../src/pricing.ts';
import type { SessionTurn } from '../src/types.ts';

const timestamp = '2026-08-02T12:00:00Z';
const valid = { type: 'assistant', timestamp, message: {
	model: 'claude-sonnet-4-6', usage: { input_tokens: 1_000_000, output_tokens: 0 },
} };

async function parsed(records: unknown[], options: ParseOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ledger-contract-integration-'));
	try {
		const project = join(root, 'project');
		mkdirSync(project);
		writeFileSync(join(project, 'synthetic.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
		const turns: SessionTurn[] = [];
		for await (const turn of parseAll({ ...options, projectsDir: root })) turns.push(turn);
		return turns;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('unsupported usage remains observed forecast activity without becoming billable after projection', async () => {
	const records = [
		{ ...valid, message: { ...valid.message, usage: { ...valid.message.usage,
			server_tool_use: { web_search_requests: 'private-counter' },
		} } },
		{ ...valid, usage: { input_tokens: 5 } },
		{ ...valid, message: { ...valid.message, usage: { ...valid.message.usage,
			future_cost: 'private-future-field',
		} } },
		{ ...valid, message: { ...valid.message, usage: { ...valid.message.usage,
			iterations: { private_body: 'not-an-array' },
		} } },
	];
	const diagnostics = createParseDiagnostics();
	const turns = await parsed(records, { strictTimestamps: true, includeInvalidUsage: true, diagnostics });
	const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00Z'));
	for (const turn of turns) forecast.add(turn);
	const report = forecast.finalize(diagnostics);
	expect(report.basis.assistantTurns).toBe(4);
	expect(report.basis.dataStatus).toBe('ok');
	expect(report.basis.shadowCostUsd).toBe(0);
	expect(report.records.invalidUsageTurns).toBe(4);
	expect(report.amountsAreLowerBounds).toBe(true);
	expect(JSON.stringify(turns)).not.toContain('private-');
});

test('accepted cost fields retain server charges without retaining arbitrary allowed metadata', async () => {
	const usage = { input_tokens: 1_000_000, output_tokens: 0,
		server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 },
		iterations: [{ content: 'PRIVATE_ITERATION_BODY' }],
		service_tier: 'PRIVATE_SERVICE_TIER', inference_geo: 'PRIVATE_LOCATION', speed: 'PRIVATE_SPEED',
	};
	const turns = await parsed([{ ...valid, message: { ...valid.message, usage } }]);
	expect(turns).toHaveLength(1);
	expect(turns[0]!.usage!.server_tool_use).toEqual({ web_search_requests: 2, web_fetch_requests: 1 });
	expect(costFor(turns[0]!.usage!, turns[0]!.model).totalCost).toBe(costFor(usage, valid.message.model).totalCost);
	expect(JSON.stringify(turns)).not.toContain('PRIVATE_');
	expect(turns[0]!.usage).not.toHaveProperty('iterations');
	expect(turns[0]).not.toHaveProperty('raw');
});

test('legacy role-only aggregate envelopes and partial usage remain supported', async () => {
	const turns = await parsed([{ timestamp: '2026-08-02', message: {
		role: 'assistant', model: valid.message.model, usage: { cache_read_input_tokens: 100 },
	} }]);
	expect(turns).toHaveLength(1);
	expect(turns[0]!.usage).toEqual({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100 });
});

test('missing model preserves known activity and server counters but remains unpriced', async () => {
	const diagnostics = createParseDiagnostics();
	const turns = await parsed([{ ...valid, message: { usage: {
		...valid.message.usage, server_tool_use: { web_search_requests: 2 },
	} } }], { strictTimestamps: true, includeInvalidUsage: true, diagnostics });
	const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00Z'));
	for (const turn of turns) forecast.add(turn);
	const report = forecast.finalize(diagnostics);
	expect(turns[0]!.usage!.server_tool_use).toEqual({ web_search_requests: 2 });
	expect(report.basis.assistantTurns).toBe(1);
	expect(report.pricing.missingModelTurns).toBe(1);
	expect(report.pricing.status).toBe('partial');
	expect(report.amountsAreLowerBounds).toBe(true);
});

test('invalid timestamps and usage are not double-counted when both fields are malformed', async () => {
	const diagnostics = createParseDiagnostics();
	const turns = await parsed([{ ...valid, timestamp: 'not-a-date', message: {
		...valid.message, usage: { input_tokens: -1, output_tokens: 0 },
	} }], { strictTimestamps: true, includeInvalidTimestamps: true, includeInvalidUsage: true, diagnostics });
	const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00Z'));
	for (const turn of turns) forecast.add(turn);
	const report = forecast.finalize(diagnostics);
	expect(report.records.invalidTimestampTurns).toBe(1);
	expect(report.records.invalidUsageTurns).toBe(0);
	expect(report.basis.shadowCostUsd).toBe(0);
});


test('aggregate normalization fills omitted counters but rejects explicit nulls', async () => {
	const turns = await parsed([
		{ ...valid, message: { ...valid.message, usage: { input_tokens: null, output_tokens: 1 } } },
		{ ...valid, message: { ...valid.message, usage: { input_tokens: 1, output_tokens: null } } },
		{ ...valid, message: { ...valid.message, usage: { input_tokens: 1 } } },
	]);
	expect(turns).toHaveLength(1);
	expect(turns[0]!.usage).toEqual({ input_tokens: 1, output_tokens: 0 });
});
