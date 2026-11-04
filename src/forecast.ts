import { isSupportedUsage, type ParseDiagnostics } from './log-contract.ts';
import { costFor, isKnownModel } from './pricing.ts';
import { parseRfc3339Timestamp } from './timestamp.ts';
import type { SessionTurn } from './types.ts';

export const FORECAST_DAYS = 7;
export const FORECAST_DISCLAIMER =
	'Shadow-cost estimate only; not a bill or statistical forecast.';

export type ForecastPlan = 'payg' | 'pro' | 'max';

export interface ForecastWindow {
	historyFrom: Date;
	historyToExclusive: Date;
	projectionFrom: Date;
	projectionToExclusive: Date;
}

export interface ForecastDailyRow {
	date: string;
	assistantTurns: number;
	shadowCostUsd: number;
}

export interface ForecastReport {
	schemaVersion: 2;
	command: 'forecast';
	metric: 'shadow_cost_usd';
	method: 'trailing-7-complete-local-days-constant-rate-v1';
	generatedAt: string;
	timeZone: string;
	plan: ForecastPlan;
	/** Applies to every monetary amount in the report. */
	amountsAreLowerBounds: boolean;
	basis: {
		startInclusive: string;
		endExclusive: string;
		startLocalDate: string;
		endLocalDate: string;
		calendarDays: number;
		daysWithActivity: number;
		assistantTurns: number;
		dataStatus: 'ok' | 'no-activity';
		shadowCostUsd: number;
		averageDailyShadowCostUsd: number;
		daily: ForecastDailyRow[];
	};
	forecast: {
		startInclusive: string;
		endExclusive: string;
		startLocalDate: string;
		endLocalDate: string;
		calendarDays: number;
		projectedShadowCostUsd: number;
	};
	pricing: {
		asOf: string;
		status: 'complete' | 'partial';
		unpricedModels: string[];
		unpricedAssistantTurns: number;
		missingModelTurns: number;
	};
	records: {
		status: 'no-issues-detected' | 'issues-detected';
		malformedJsonLines: number;
		unsupportedRecordLines: number;
		invalidTimestampTurns: number;
		invalidUsageTurns: number;
		invalidSubagentMetaFiles: number;
		ignoredKnownSourceRecords: number;
	};
	limitations: string[];
	disclaimer: string;
}

function validDate(date: Date): boolean {
	return Number.isFinite(date.getTime());
}

function startOfLocalDay(date: Date): Date {
	const start = new Date(date.getTime());
	start.setHours(0, 0, 0, 0);
	return start;
}

function addLocalDays(date: Date, days: number): Date {
	const next = new Date(date.getTime());
	next.setDate(next.getDate() + days);
	return next;
}

function localDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function localTimeZone(): string {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function forecastWindow(asOf: Date): ForecastWindow {
	if (!validDate(asOf)) throw new TypeError('forecast asOf must be a valid date');
	const historyToExclusive = startOfLocalDay(asOf);
	const historyFrom = addLocalDays(historyToExclusive, -FORECAST_DAYS);
	// Today is partial, so the next seven complete local days begin tomorrow.
	const projectionFrom = addLocalDays(historyToExclusive, 1);
	const projectionToExclusive = addLocalDays(projectionFrom, FORECAST_DAYS);
	return { historyFrom, historyToExclusive, projectionFrom, projectionToExclusive };
}

// Streaming reducer. It retains seven daily counters and pricing diagnostics,
// never the underlying turns. Rates are frozen at asOf so scheduled price
// changes cannot make one run internally inconsistent.
export class ForecastAccumulator {
	readonly window: ForecastWindow;
	private readonly asOf: Date;
	private readonly timeZone: string;
	private readonly dailyByDate = new Map<string, ForecastDailyRow>();
	private readonly unpricedModels = new Set<string>();
	private assistantTurns = 0;
	private shadowCostUsd = 0;
	private missingModelTurns = 0;
	private unpricedAssistantTurns = 0;
	private invalidTimestampTurns = 0;
	private invalidUsageTurns = 0;

	constructor(
		asOf: Date,
		private readonly plan: ForecastPlan = 'payg',
	) {
		if (!validDate(asOf)) throw new TypeError('forecast asOf must be a valid date');
		this.asOf = new Date(asOf.getTime());
		this.window = forecastWindow(this.asOf);
		this.timeZone = localTimeZone();
		for (let day = 0; day < FORECAST_DAYS; day++) {
			const date = localDateKey(addLocalDays(this.window.historyFrom, day));
			this.dailyByDate.set(date, { date, assistantTurns: 0, shadowCostUsd: 0 });
		}
	}

	add(turn: SessionTurn): boolean {
		if (turn.type !== 'assistant') return false;
		const timestamp = parseRfc3339Timestamp(turn.timestamp);
		if (!timestamp) {
			this.invalidTimestampTurns++;
			return false;
		}
		if (timestamp < this.window.historyFrom || timestamp >= this.window.historyToExclusive) {
			return false;
		}
		const row = this.dailyByDate.get(localDateKey(timestamp));
		if (!row) return false;
		// A turn is still activity when its usage cannot be priced. Count it
		// before validation so a coverage gap is never presented as inactivity.
		row.assistantTurns++;
		this.assistantTurns++;
		if (!turn.usage || !isSupportedUsage(turn.usage, true)) {
			this.invalidUsageTurns++;
			return false;
		}

		const model = typeof turn.model === 'string' && turn.model.length > 0 ? turn.model : undefined;
		const cost = costFor(turn.usage, model, this.asOf).totalCost;
		if (!Number.isFinite(cost) || cost < 0) {
			this.invalidUsageTurns++;
			return false;
		}

		const nextRowCost = row.shadowCostUsd + cost;
		const nextTotalCost = this.shadowCostUsd + cost;
		if (!Number.isFinite(nextRowCost) || !Number.isFinite(nextTotalCost)) {
			this.invalidUsageTurns++;
			return false;
		}
		row.shadowCostUsd = nextRowCost;
		this.shadowCostUsd = nextTotalCost;

		if (!model) {
			this.missingModelTurns++;
			this.unpricedAssistantTurns++;
		} else if (!isKnownModel(model)) {
			this.unpricedModels.add(model);
			this.unpricedAssistantTurns++;
		}
		return true;
	}

	finalize(sourceDiagnostics: Partial<ParseDiagnostics> = {}): ForecastReport {
		const daily = [...this.dailyByDate.values()].map((row) => ({ ...row }));
		const shadowCostUsd = this.shadowCostUsd;
		const daysWithActivity = daily.filter((row) => row.assistantTurns > 0).length;
		const unpricedModels = [...this.unpricedModels].sort();
		const malformedJsonLines = nonNegativeSafeInteger(sourceDiagnostics.malformedJsonLines)
			? sourceDiagnostics.malformedJsonLines
			: 0;
		const unsupportedRecordLines = nonNegativeSafeInteger(
			sourceDiagnostics.unsupportedRecordLines,
		)
			? sourceDiagnostics.unsupportedRecordLines
			: 0;
		const invalidTimestampTurns =
			this.invalidTimestampTurns - (sourceDiagnostics.forwardedInvalidTimestampLines ?? 0) +
			(nonNegativeSafeInteger(sourceDiagnostics.invalidTimestampLines)
				? sourceDiagnostics.invalidTimestampLines
				: 0);
		const invalidUsageTurns =
			this.invalidUsageTurns - (sourceDiagnostics.forwardedInvalidUsageLines ?? 0) +
			(nonNegativeSafeInteger(sourceDiagnostics.invalidUsageLines)
				? sourceDiagnostics.invalidUsageLines
				: 0);
		const invalidSubagentMetaFiles = nonNegativeSafeInteger(
			sourceDiagnostics.invalidSubagentMetaFiles,
		)
			? sourceDiagnostics.invalidSubagentMetaFiles
			: 0;
		const ignoredKnownSourceRecords = nonNegativeSafeInteger(
			sourceDiagnostics.ignoredSourceRecordLines,
		)
			? sourceDiagnostics.ignoredSourceRecordLines
			: 0;
		const pricingPartial = this.unpricedAssistantTurns > 0;
		const coverageGaps =
			malformedJsonLines > 0 ||
			unsupportedRecordLines > 0 ||
			invalidTimestampTurns > 0 ||
			invalidUsageTurns > 0;
		const recordIssues = coverageGaps || invalidSubagentMetaFiles > 0;
		const amountsAreLowerBounds = pricingPartial || coverageGaps;
		return {
			schemaVersion: 2,
			command: 'forecast',
			metric: 'shadow_cost_usd',
			method: 'trailing-7-complete-local-days-constant-rate-v1',
			generatedAt: this.asOf.toISOString(),
			timeZone: this.timeZone,
			plan: this.plan,
			amountsAreLowerBounds,
			basis: {
				startInclusive: this.window.historyFrom.toISOString(),
				endExclusive: this.window.historyToExclusive.toISOString(),
				startLocalDate: localDateKey(this.window.historyFrom),
				endLocalDate: localDateKey(addLocalDays(this.window.historyToExclusive, -1)),
				calendarDays: FORECAST_DAYS,
				daysWithActivity,
				assistantTurns: this.assistantTurns,
				dataStatus: this.assistantTurns > 0 ? 'ok' : 'no-activity',
				shadowCostUsd,
				averageDailyShadowCostUsd: shadowCostUsd / FORECAST_DAYS,
				daily,
			},
			forecast: {
				startInclusive: this.window.projectionFrom.toISOString(),
				endExclusive: this.window.projectionToExclusive.toISOString(),
				startLocalDate: localDateKey(this.window.projectionFrom),
				endLocalDate: localDateKey(addLocalDays(this.window.projectionToExclusive, -1)),
				calendarDays: FORECAST_DAYS,
				projectedShadowCostUsd: shadowCostUsd,
			},
			pricing: {
				asOf: this.asOf.toISOString(),
				status: pricingPartial ? 'partial' : 'complete',
				unpricedModels,
				unpricedAssistantTurns: this.unpricedAssistantTurns,
				missingModelTurns: this.missingModelTurns,
			},
			records: {
				status: recordIssues ? 'issues-detected' : 'no-issues-detected',
				malformedJsonLines,
				unsupportedRecordLines,
				invalidTimestampTurns,
				invalidUsageTurns,
				invalidSubagentMetaFiles,
				ignoredKnownSourceRecords,
			},
			limitations: [
				'constant_rate',
				'current_verified_prices',
				'scheduled_price_changes_ignored',
				'zero_usage_days_included',
				'current_partial_day_excluded',
				'not_an_invoice_forecast',
			],
			disclaimer: FORECAST_DISCLAIMER,
		};
	}
}

function formatUsd(value: number, lowerBound = false): string {
	const amount = '$' + value.toFixed(value > 0 && value < 0.01 ? 4 : 2);
	return lowerBound ? `≥${amount}` : amount;
}

function planDescription(plan: ForecastPlan): string {
	if (plan === 'payg') return 'payg · directional estimate; not an invoice';
	return `${plan} · shadow-cost equivalent only; no subscription bill forecast`;
}

/** Render log-supplied labels without terminal controls; JSON retains the original value. */
export function escapeForecastLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) =>
		`\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
	);
}

function pricingDescription(report: ForecastReport): string {
	if (report.pricing.status === 'complete') {
		return `complete · rates as of ${report.pricing.asOf.slice(0, 10)}`;
	}
	const gaps = report.pricing.unpricedModels.map(escapeForecastLabel);
	if (report.pricing.missingModelTurns > 0) {
		gaps.push(`${report.pricing.missingModelTurns} missing-model turn(s)`);
	}
	return `partial · unpriced: ${gaps.join(', ')}`;
}

function recordDescription(report: ForecastReport): string {
	if (report.records.status === 'no-issues-detected') return 'no issues detected';
	const issues: string[] = [];
	if (report.records.malformedJsonLines > 0) {
		issues.push(`${report.records.malformedJsonLines} malformed JSON line(s)`);
	}
	if (report.records.unsupportedRecordLines > 0) {
		issues.push(`${report.records.unsupportedRecordLines} unsupported record line(s)`);
	}
	if (report.records.invalidTimestampTurns > 0) {
		issues.push(`${report.records.invalidTimestampTurns} invalid-timestamp turn(s)`);
	}
	if (report.records.invalidUsageTurns > 0) {
		issues.push(`${report.records.invalidUsageTurns} invalid-usage turn(s)`);
	}
	if (report.records.invalidSubagentMetaFiles > 0) {
		issues.push(`${report.records.invalidSubagentMetaFiles} invalid subagent metadata file(s)`);
	}
	return `issues detected · excluded: ${issues.join(', ')}`;
}

export function formatForecast(report: ForecastReport): string {
	const activityNote =
		report.basis.dataStatus === 'no-activity'
			? report.amountsAreLowerBounds
				? 'No attributable recent activity was observed; detected coverage gaps make $0 a lower bound.'
				: 'No recent activity was observed; $0 is not a claim of future inactivity.'
			: undefined;
	return [
		'agent-ledger forecast',
		`  Basis          ${report.basis.startLocalDate} → ${report.basis.endLocalDate} · 7 complete days · ${report.timeZone}`,
		`  Observed       ${formatUsd(report.basis.shadowCostUsd, report.amountsAreLowerBounds)} shadow · ${report.basis.daysWithActivity}/7 days with activity`,
		`  Daily average  ${formatUsd(report.basis.averageDailyShadowCostUsd, report.amountsAreLowerBounds)} shadow`,
		`  Next 7 days    ${formatUsd(report.forecast.projectedShadowCostUsd, report.amountsAreLowerBounds)} shadow · ${report.forecast.startLocalDate} → ${report.forecast.endLocalDate}`,
		'  Method         trailing 7 complete days × constant daily rate',
		`  Pricing        ${pricingDescription(report)}`,
		`  Records        ${recordDescription(report)}`,
		`  Plan           ${planDescription(report.plan)}`,
		'',
		'Includes zero-use days. Excludes today because it is incomplete.',
		'Rates are frozen at pricing.asOf; scheduled or future changes are not modeled.',
		'No trend, seasonality, or confidence claim.',
		activityNote,
		report.disclaimer,
	]
		.filter((line): line is string => line !== undefined)
		.join('\n');
}
