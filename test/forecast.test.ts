import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import {
	ForecastAccumulator,
	formatForecast,
	forecastWindow,
} from '../src/forecast.ts';
import type { SessionTurn, TokenUsage } from '../src/types.ts';

const forecastModulePath = fileURLToPath(new URL('../src/forecast.ts', import.meta.url));

function turn(
	timestamp: string,
	options: {
		model?: string | undefined;
		input?: number;
		output?: number;
		type?: SessionTurn['type'];
		usage?: TokenUsage | undefined;
	} = {},
): SessionTurn {
	return {
		type: options.type ?? 'assistant',
		timestamp,
		sessionId: 'forecast-session',
		model: 'model' in options ? options.model : 'claude-sonnet-4-6',
		usage:
			'usage' in options ? options.usage : {
				input_tokens: options.input ?? 1_000_000,
				output_tokens: options.output ?? 0,
			},
		raw: null,
	};
}

function windowProbe(timeZone: string, asOf: string) {
	const script = `
		const mod = await import(${JSON.stringify(forecastModulePath)});
		const asOf = new Date(${JSON.stringify(asOf)});
		const window = mod.forecastWindow(asOf);
		const report = new mod.ForecastAccumulator(asOf).finalize();
		console.log(JSON.stringify({
			historyFrom: window.historyFrom.toISOString(),
			historyToExclusive: window.historyToExclusive.toISOString(),
			projectionFrom: window.projectionFrom.toISOString(),
			projectionToExclusive: window.projectionToExclusive.toISOString(),
			timeZone: report.timeZone,
			basisDates: [report.basis.startLocalDate, report.basis.endLocalDate],
			forecastDates: [report.forecast.startLocalDate, report.forecast.endLocalDate]
		}));
	`;
	const result = Bun.spawnSync({
		cmd: [process.execPath, '-e', script],
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, TZ: timeZone },
	});
	expect(result.exitCode).toBe(0);
	expect(result.stderr.toString()).toBe('');
	return JSON.parse(result.stdout.toString()) as {
		historyFrom: string;
		historyToExclusive: string;
		projectionFrom: string;
		projectionToExclusive: string;
		timeZone: string;
		basisDates: string[];
		forecastDates: string[];
	};
}

describe('forecast calendar windows', () => {
	test('uses seven complete Asia/Shanghai days and starts projection tomorrow', () => {
		const result = windowProbe('Asia/Shanghai', '2026-08-03T04:00:00.000Z');
		expect(result).toEqual({
			historyFrom: '2026-07-26T16:00:00.000Z',
			historyToExclusive: '2026-08-02T16:00:00.000Z',
			projectionFrom: '2026-08-03T16:00:00.000Z',
			projectionToExclusive: '2026-08-10T16:00:00.000Z',
			timeZone: 'Asia/Shanghai',
			basisDates: ['2026-07-27', '2026-08-02'],
			forecastDates: ['2026-08-04', '2026-08-10'],
		});
	});

	test('spring DST still spans exactly seven local dates', () => {
		const result = windowProbe('America/Los_Angeles', '2026-03-09T19:00:00.000Z');
		expect(result.historyFrom).toBe('2026-03-02T08:00:00.000Z');
		expect(result.historyToExclusive).toBe('2026-03-09T07:00:00.000Z');
		expect(
			(new Date(result.historyToExclusive).getTime() - new Date(result.historyFrom).getTime()) /
				3_600_000,
		).toBe(167);
		expect(result.basisDates).toEqual(['2026-03-02', '2026-03-08']);
	});

	test('fall DST still spans exactly seven local dates', () => {
		const result = windowProbe('America/Los_Angeles', '2026-11-02T20:00:00.000Z');
		expect(result.historyFrom).toBe('2026-10-26T07:00:00.000Z');
		expect(result.historyToExclusive).toBe('2026-11-02T08:00:00.000Z');
		expect(
			(new Date(result.historyToExclusive).getTime() - new Date(result.historyFrom).getTime()) /
				3_600_000,
		).toBe(169);
		expect(result.basisDates).toEqual(['2026-10-26', '2026-11-01']);
	});

	test('groups both repeated fall-DST hours into the same local day', () => {
		const script = `
			const mod = await import(${JSON.stringify(forecastModulePath)});
			const accumulator = new mod.ForecastAccumulator(new Date('2026-11-02T20:00:00.000Z'));
			const makeTurn = (timestamp) => ({
				type: 'assistant', timestamp, sessionId: 'dst', model: 'claude-sonnet-4-6',
				usage: { input_tokens: 1000000, output_tokens: 0 }, raw: null
			});
			accumulator.add(makeTurn('2026-11-01T08:30:00.000Z'));
			accumulator.add(makeTurn('2026-11-01T09:30:00.000Z'));
			const report = accumulator.finalize();
			console.log(JSON.stringify({
				daysWithActivity: report.basis.daysWithActivity,
				assistantTurns: report.basis.assistantTurns,
				shadowCostUsd: report.basis.shadowCostUsd,
				row: report.basis.daily.find((day) => day.date === '2026-11-01')
			}));
		`;
		const result = Bun.spawnSync({
			cmd: [process.execPath, '-e', script],
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, TZ: 'America/Los_Angeles' },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toEqual({
			daysWithActivity: 1,
			assistantTurns: 2,
			shadowCostUsd: 6,
			row: { date: '2026-11-01', assistantTurns: 2, shadowCostUsd: 6 },
		});
	});

	test('buckets by local date when two timestamps share one UTC date', () => {
		const script = `
			const mod = await import(${JSON.stringify(forecastModulePath)});
			const accumulator = new mod.ForecastAccumulator(new Date('2026-11-02T20:00:00.000Z'));
			const makeTurn = (timestamp) => ({
				type: 'assistant', timestamp, sessionId: 'dst', model: 'claude-sonnet-4-6',
				usage: { input_tokens: 1000000, output_tokens: 0 }, raw: null
			});
			accumulator.add(makeTurn('2026-11-01T06:30:00.000Z'));
			accumulator.add(makeTurn('2026-11-01T07:30:00.000Z'));
			const report = accumulator.finalize();
			console.log(JSON.stringify(report.basis.daily.filter((day) => day.assistantTurns > 0)));
		`;
		const result = Bun.spawnSync({
			cmd: [process.execPath, '-e', script],
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, TZ: 'America/Los_Angeles' },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe('');
		expect(JSON.parse(result.stdout.toString())).toEqual([
			{ date: '2026-10-31', assistantTurns: 1, shadowCostUsd: 3 },
			{ date: '2026-11-01', assistantTurns: 1, shadowCostUsd: 3 },
		]);
	});

	test('rejects an invalid asOf', () => {
		expect(() => forecastWindow(new Date('invalid'))).toThrow(TypeError);
	});
});

describe('ForecastAccumulator', () => {
	test('enforces the half-open history boundary', () => {
		const asOf = new Date('2026-08-03T12:00:00.000Z');
		const forecast = new ForecastAccumulator(asOf);
		const { historyFrom, historyToExclusive } = forecast.window;
		expect(forecast.add(turn(new Date(historyFrom.getTime() - 1).toISOString()))).toBe(false);
		expect(forecast.add(turn(historyFrom.toISOString()))).toBe(true);
		expect(forecast.add(turn(new Date(historyToExclusive.getTime() - 1).toISOString()))).toBe(
			true,
		);
		expect(forecast.add(turn(historyToExclusive.toISOString()))).toBe(false);

		const report = forecast.finalize();
		expect(report.basis.assistantTurns).toBe(2);
		expect(report.basis.daysWithActivity).toBe(2);
		expect(report.basis.shadowCostUsd).toBe(6);
	});

	test('includes zero-use days in a sparse seven-day rate', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'), 'max');
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000);
		forecast.add(turn(timestamp.toISOString(), { model: 'claude-haiku-4-5', input: 7_000_000 }));

		const report = forecast.finalize();
		expect(report.plan).toBe('max');
		expect(report.basis.daily).toHaveLength(7);
		expect(report.basis.daysWithActivity).toBe(1);
		expect(report.basis.shadowCostUsd).toBe(7);
		expect(report.basis.averageDailyShadowCostUsd).toBe(1);
		expect(report.forecast.projectedShadowCostUsd).toBe(7);
	});

	test('sums mixed known models using one frozen pricing date', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		forecast.add(turn(timestamp, { model: 'claude-sonnet-4-6', input: 1_000_000 }));
		forecast.add(turn(timestamp, { model: 'claude-opus-4-7', input: 1_000_000 }));
		forecast.add(turn(timestamp, { model: 'claude-haiku-4-5', input: 1_000_000 }));

		const report = forecast.finalize();
		expect(report.basis.shadowCostUsd).toBe(9);
		expect(report.basis.assistantTurns).toBe(3);
		expect(report.basis.daysWithActivity).toBe(1);
		expect(report.pricing.status).toBe('complete');
	});

	test('returns an explicit finite no-activity report', () => {
		const report = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z')).finalize();
		expect(report.basis.dataStatus).toBe('no-activity');
		expect(report.basis.daysWithActivity).toBe(0);
		expect(report.basis.assistantTurns).toBe(0);
		expect(report.basis.shadowCostUsd).toBe(0);
		expect(report.basis.averageDailyShadowCostUsd).toBe(0);
		expect(report.forecast.projectedShadowCostUsd).toBe(0);
		expect(report.amountsAreLowerBounds).toBe(false);
		expect(report.records.status).toBe('no-issues-detected');
		expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity/);
		expect(formatForecast(report)).toContain('$0 is not a claim of future inactivity');
	});

	test('keeps the versioned v1 JSON field contract explicit', () => {
		const report = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z')).finalize();
		expect(Object.keys(report).sort()).toEqual(
			[
				'amountsAreLowerBounds',
				'basis',
				'command',
				'disclaimer',
				'forecast',
				'generatedAt',
				'limitations',
				'method',
				'metric',
				'plan',
				'pricing',
				'records',
				'schemaVersion',
				'timeZone',
			].sort(),
		);
		expect(Object.keys(report.basis).sort()).toEqual(
			[
				'assistantTurns',
				'averageDailyShadowCostUsd',
				'calendarDays',
				'daily',
				'dataStatus',
				'daysWithActivity',
				'endExclusive',
				'endLocalDate',
				'shadowCostUsd',
				'startInclusive',
				'startLocalDate',
			].sort(),
		);
		expect(Object.keys(report.forecast).sort()).toEqual(
			[
				'calendarDays',
				'endExclusive',
				'endLocalDate',
				'projectedShadowCostUsd',
				'startInclusive',
				'startLocalDate',
			].sort(),
		);
		expect(Object.keys(report.pricing).sort()).toEqual(
			[
				'asOf',
				'missingModelTurns',
				'status',
				'unpricedAssistantTurns',
				'unpricedModels',
			].sort(),
		);
		expect(Object.keys(report.records).sort()).toEqual(
			[
				'invalidTimestampTurns',
				'invalidUsageTurns',
				'malformedJsonLines',
				'status',
			].sort(),
		);
		expect(Object.keys(report.basis.daily[0] ?? {}).sort()).toEqual(
			['assistantTurns', 'date', 'shadowCostUsd'].sort(),
		);
	});

	test('reports unknown, missing, and malformed pricing inputs as a lower bound', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		expect(forecast.add(turn(timestamp, { model: 'claude-future-99' }))).toBe(true);
		expect(forecast.add(turn(timestamp, { model: undefined }))).toBe(true);
		expect(
			forecast.add(
				turn(timestamp, {
					usage: { input_tokens: 1 } as TokenUsage,
				}),
			),
		).toBe(false);
		expect(forecast.add(turn('not-a-date'))).toBe(false);
		expect(forecast.add(turn('2026-02-30T12:00:00Z'))).toBe(false);
		expect(forecast.add(turn('0'))).toBe(false);

		const report = forecast.finalize({ malformedJsonLines: 1 });
		expect(report.basis.dataStatus).toBe('ok');
		expect(report.basis.assistantTurns).toBe(3);
		expect(report.basis.daysWithActivity).toBe(1);
		expect(report.basis.shadowCostUsd).toBe(0);
			expect(report.pricing).toMatchObject({
			status: 'partial',
			unpricedModels: ['claude-future-99'],
			unpricedAssistantTurns: 2,
			missingModelTurns: 1,
		});
		expect(report.records).toEqual({
			status: 'issues-detected',
			malformedJsonLines: 1,
			invalidTimestampTurns: 3,
			invalidUsageTurns: 1,
		});
		expect(report.amountsAreLowerBounds).toBe(true);
	});

	test('rejects unsafe counters before they can overflow JSON numbers', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		const accepted = forecast.add(
			turn(timestamp, {
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					server_tool_use: { web_search_requests: Number.MAX_VALUE },
				},
			}),
		);
		expect(accepted).toBe(false);
		const report = forecast.finalize();
		expect(report.records.invalidUsageTurns).toBe(1);
		expect(report.amountsAreLowerBounds).toBe(true);
		expect(report.basis.dataStatus).toBe('ok');
		expect(report.basis.assistantTurns).toBe(1);
		expect(report.basis.shadowCostUsd).toBe(0);
		expect(JSON.stringify(report)).not.toContain('null');
	});

	test('rejects negative, fractional, and malformed nested usage counters', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		const invalidUsages = [
			{
				input_tokens: 1,
				output_tokens: 1,
				cache_read_input_tokens: -1,
			},
			{
				input_tokens: 1,
				output_tokens: 1,
				cache_creation: null,
			},
			{
				input_tokens: 1,
				output_tokens: 1,
				cache_creation: [],
			},
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 1_000_000,
				cache_creation: {},
			},
			{
				input_tokens: 1,
				output_tokens: 1,
				server_tool_use: { web_search_requests: 0.5 },
			},
			{
				input_tokens: 1,
				output_tokens: 1,
				server_tool_use: [],
			},
		] as unknown as TokenUsage[];
		for (const usage of invalidUsages) {
			expect(forecast.add(turn(timestamp, { usage }))).toBe(false);
		}

		const report = forecast.finalize();
		expect(report.basis.dataStatus).toBe('ok');
		expect(report.basis.assistantTurns).toBe(6);
		expect(report.records.invalidUsageTurns).toBe(6);
		expect(report.amountsAreLowerBounds).toBe(true);
	});

	test('accepts matching legacy and TTL-split cache creation totals', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		expect(
			forecast.add(
				turn(timestamp, {
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						cache_creation_input_tokens: 1_000_000,
						cache_creation: {
							ephemeral_5m_input_tokens: 500_000,
							ephemeral_1h_input_tokens: 500_000,
						},
					},
				}),
			),
		).toBe(true);
		const report = forecast.finalize();
		expect(report.basis.shadowCostUsd).toBe(4.875);
		expect(report.records.status).toBe('no-issues-detected');
		expect(report.amountsAreLowerBounds).toBe(false);
	});

	test('treats synthetic turns as known free activity', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		forecast.add(turn(timestamp, { model: '<synthetic>' }));
		const report = forecast.finalize();
		expect(report.basis.dataStatus).toBe('ok');
		expect(report.basis.daysWithActivity).toBe(1);
		expect(report.basis.shadowCostUsd).toBe(0);
		expect(report.pricing.status).toBe('complete');
	});

	test('ignores user turns but records unpriceable assistant activity', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'));
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		expect(forecast.add(turn(timestamp, { type: 'user' }))).toBe(false);
		expect(forecast.add(turn(timestamp, { usage: undefined }))).toBe(false);
		const report = forecast.finalize();
		expect(report.basis.dataStatus).toBe('ok');
		expect(report.basis.assistantTurns).toBe(1);
		expect(report.records.invalidUsageTurns).toBe(1);
		expect(report.amountsAreLowerBounds).toBe(true);
	});

	test('plan context never changes the shadow-cost projection', () => {
		const asOf = new Date('2026-08-03T12:00:00.000Z');
		const costs = (['payg', 'pro', 'max'] as const).map((plan) => {
			const forecast = new ForecastAccumulator(asOf, plan);
			const timestamp = new Date(
				forecast.window.historyFrom.getTime() + 12 * 3_600_000,
			).toISOString();
			forecast.add(turn(timestamp));
			return forecast.finalize().forecast.projectedShadowCostUsd;
		});
		expect(costs).toEqual([3, 3, 3]);
	});

	test('freezes scheduled pricing and clones the supplied clock', () => {
		const introductoryAsOf = new Date('2026-08-31T23:59:59.999Z');
		const introductory = new ForecastAccumulator(introductoryAsOf);
		const introTimestamp = new Date(
			introductory.window.historyFrom.getTime() + 12 * 3_600_000,
		).toISOString();
		introductory.add(turn(introTimestamp, { model: 'claude-sonnet-5', input: 1_000_000 }));
		introductoryAsOf.setUTCFullYear(2000);
		expect(introductory.finalize().basis.shadowCostUsd).toBe(2);
		expect(introductory.finalize().generatedAt).toBe('2026-08-31T23:59:59.999Z');
		expect(introductory.finalize().limitations).toContain('scheduled_price_changes_ignored');

		const standard = new ForecastAccumulator(new Date('2026-09-01T00:00:00.000Z'));
		const standardTimestamp = new Date(
			standard.window.historyFrom.getTime() + 12 * 3_600_000,
		).toISOString();
		standard.add(turn(standardTimestamp, { model: 'claude-sonnet-5', input: 1_000_000 }));
		expect(standard.finalize().basis.shadowCostUsd).toBe(3);
	});

	test('formats the same dates, values, pricing coverage, and plan as JSON', () => {
		const forecast = new ForecastAccumulator(new Date('2026-08-03T12:00:00.000Z'), 'pro');
		const timestamp = new Date(forecast.window.historyFrom.getTime() + 12 * 3_600_000).toISOString();
		forecast.add(turn(timestamp, { model: 'claude-haiku-4-5', input: 7_000_000 }));
		forecast.add(turn(timestamp, { model: 'claude-future-99' }));
		const report = forecast.finalize();
		const text = formatForecast(report);
		expect(text).toContain(`${report.basis.startLocalDate} → ${report.basis.endLocalDate}`);
		expect(text).toContain(`${report.forecast.startLocalDate} → ${report.forecast.endLocalDate}`);
		expect(text.match(/≥\$7\.00/g)).toHaveLength(2);
		expect(text.match(/≥\$1\.00/g)).toHaveLength(1);
		expect(text).toContain('partial · unpriced: claude-future-99');
		expect(text).toContain('Records        no issues detected');
		expect(text).toContain('pro · shadow-cost equivalent only');
		expect(text).toContain('scheduled or future changes are not modeled');
		expect(text).toContain(report.disclaimer);
	});
});

describe('forecast properties', () => {
	test('is order-independent, finite, non-negative, and bounded to seven active days', () => {
		const records = fc.array(
			fc.record({
				day: fc.integer({ min: 0, max: 6 }),
				model: fc.constantFrom(
					'claude-sonnet-4-6',
					'claude-opus-4-7',
					'claude-haiku-4-5',
				),
				input: fc.integer({ min: 0, max: 2_000_000 }),
				output: fc.integer({ min: 0, max: 2_000_000 }),
			}),
			{ maxLength: 60 },
		);
		fc.assert(
			fc.property(records, (items) => {
				const asOf = new Date('2026-08-03T12:00:00.000Z');
				const first = new ForecastAccumulator(asOf);
				const second = new ForecastAccumulator(asOf);
				const toTurn = (item: (typeof items)[number]) => {
					const date = new Date(first.window.historyFrom.getTime());
					date.setDate(date.getDate() + item.day);
					date.setHours(12, 0, 0, 0);
					return turn(date.toISOString(), {
						model: item.model,
						input: item.input,
						output: item.output,
					});
				};
				for (const item of items) first.add(toTurn(item));
				for (const item of [...items].reverse()) second.add(toTurn(item));
				const a = first.finalize();
				const b = second.finalize();
				expect(a.basis.shadowCostUsd).toBeCloseTo(b.basis.shadowCostUsd, 12);
				for (let day = 0; day < a.basis.daily.length; day++) {
					const left = a.basis.daily[day];
					const right = b.basis.daily[day];
					expect(left?.date).toBe(right?.date);
					expect(left?.assistantTurns).toBe(right?.assistantTurns);
					expect(left?.shadowCostUsd).toBeCloseTo(right?.shadowCostUsd ?? Number.NaN, 12);
				}
				expect(a.basis.daysWithActivity).toBeGreaterThanOrEqual(0);
				expect(a.basis.daysWithActivity).toBeLessThanOrEqual(7);
				expect(Number.isFinite(a.basis.shadowCostUsd)).toBe(true);
				expect(a.basis.shadowCostUsd).toBeGreaterThanOrEqual(0);
				expect(a.basis.averageDailyShadowCostUsd * 7).toBeCloseTo(
					a.basis.shadowCostUsd,
					12,
				);
				expect(a.forecast.projectedShadowCostUsd).toBeCloseTo(
					a.basis.shadowCostUsd,
					12,
				);
				expect(a.basis.daily.map((row) => row.date)).toEqual(
					[...a.basis.daily.map((row) => row.date)].sort(),
				);
				expect(
					a.basis.daily.reduce((sum, row) => sum + row.assistantTurns, 0),
				).toBe(a.basis.assistantTurns);
				expect(
					a.basis.daily.reduce((sum, row) => sum + row.shadowCostUsd, 0),
				).toBeCloseTo(a.basis.shadowCostUsd, 12);
			}),
			{ numRuns: 100, seed: 20260803 },
		);
	});
});
