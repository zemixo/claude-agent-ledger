import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const BENCHMARK_SCHEMA_VERSION = 2;
export const CORPUS_VERSION = 'synthetic-log-contract-v1' as const;
export const GENERATOR_ALGORITHM = 'fixed-16-round-robin-index-modulo-10-v1';
export const GENERATOR_SEED = 'none-fixed-sequence-v1';
export const PROJECT_COUNT = 4;
export const FILES_PER_PROJECT = 4;
export const FILE_COUNT = PROJECT_COUNT * FILES_PER_PROJECT;
export const MEASURED_RUNS = 3;
export const CHILD_TIMEOUT_MS = 60_000;
export const MAX_MEDIUM_TO_LARGE_WALL_RATIO = 15;
export const MIN_RATIO_DENOMINATOR_MS = 100;
// Bun/JSC grows its allocation high-water mark while parsing without retaining
// turns. The 192 MiB envelope leaves headroom above the measured plateau while
// still catching a return to materializing eight large files at once.
export const MAX_RSS_ENVELOPE_GROWTH_BYTES = 192 * 1024 * 1024;
export const HISTORICAL_THROUGHPUT_REGRESSION_FRACTION = 0.25;
export const HISTORICAL_RSS_REGRESSION_FRACTION = 0.25;
export const HISTORICAL_RSS_REGRESSION_FLOOR_BYTES = 32 * 1024 * 1024;
export const PEAK_RSS_NORMALIZATION_ID =
	'bun-1.3.13-rumaxrss-linux-kib-darwin-bytes-v1' as const;

export type BenchmarkProfileName = 'smoke' | 'full';

export const BENCHMARK_PROFILES: Record<BenchmarkProfileName, readonly [number, number, number]> = {
	smoke: [1_000, 10_000, 100_000],
	full: [10_000, 100_000, 1_000_000],
};

type RecordKind = 'currentAssistant' | 'legacyAssistant' | 'knownContext';

const SYNTHETIC_LINES: Record<RecordKind, string> = {
	currentAssistant: JSON.stringify({
		type: 'assistant',
		version: 'synthetic-benchmark-v1',
		timestamp: '2026-01-01T00:00:00Z',
		message: {
			role: 'assistant',
			model: 'claude-sonnet-4-6',
			content: [],
			usage: {
				input_tokens: 11,
				output_tokens: 7,
				cache_creation_input_tokens: 9,
				cache_read_input_tokens: 13,
				cache_creation: {
					ephemeral_5m_input_tokens: 3,
					ephemeral_1h_input_tokens: 2,
				},
				server_tool_use: {
					web_search_requests: 1,
					web_fetch_requests: 2,
				},
				service_tier: 'standard',
				inference_geo: 'synthetic',
				speed: 'standard',
				iterations: [],
			},
		},
	}),
	legacyAssistant: JSON.stringify({
		type: 'assistant',
		version: 'synthetic-benchmark-legacy-v1',
		timestamp: '2026-01-01T00:00:01Z',
		message: {
			role: 'assistant',
			model: 'claude-haiku-4-5-20251001',
			content: [],
			usage: {
				input_tokens: 5,
				output_tokens: 3,
				cache_creation_input_tokens: 2,
				cache_read_input_tokens: 8,
			},
		},
	}),
	knownContext: JSON.stringify({
		type: 'user',
		version: 'synthetic-benchmark-v1',
		timestamp: '2026-01-01T00:00:02Z',
		message: { role: 'user', content: [] },
	}),
};

export interface CorpusMix {
	currentAssistant: number;
	legacyAssistant: number;
	knownContext: number;
}

export interface CorpusManifest {
	corpusVersion: typeof CORPUS_VERSION;
	generator: {
		algorithm: typeof GENERATOR_ALGORITHM;
		seed: typeof GENERATOR_SEED;
	};
	layout: {
		projects: typeof PROJECT_COUNT;
		filesPerProject: typeof FILES_PER_PROJECT;
		files: typeof FILE_COUNT;
	};
	records: number;
	bytes: number;
	sha256: string;
	maxLineBytes: number;
	mix: CorpusMix;
	expected: {
		acceptedRecords: number;
		ignoredRecords: number;
		diagnosticLines: 0;
	};
}

export interface GeneratedCorpus {
	projectsDir: string;
	manifest: CorpusManifest;
}

interface CorpusFile {
	relativePath: string;
	absolutePath: string;
	stream: ReturnType<typeof createWriteStream>;
	finished: Promise<void>;
}

function recordKind(index: number): RecordKind {
	const bucket = index % 10;
	if (bucket < 8) return 'currentAssistant';
	if (bucket === 8) return 'legacyAssistant';
	return 'knownContext';
}

export function expectedMix(records: number): CorpusMix {
	if (!Number.isSafeInteger(records) || records < 1) {
		throw new RangeError('record count must be a positive safe integer');
	}
	const cycles = Math.floor(records / 10);
	const remainder = records % 10;
	return {
		currentAssistant: cycles * 8 + Math.min(remainder, 8),
		legacyAssistant: cycles + (remainder > 8 ? 1 : 0),
		knownContext: cycles + (remainder > 9 ? 1 : 0),
	};
}

function fixedRelativePaths(): string[] {
	const paths: string[] = [];
	for (let project = 0; project < PROJECT_COUNT; project++) {
		for (let file = 0; file < FILES_PER_PROJECT; file++) {
			paths.push(
				`synthetic-project-${String(project).padStart(2, '0')}/synthetic-session-${String(file).padStart(2, '0')}.jsonl`,
			);
		}
	}
	return paths;
}

async function inspectCorpus(files: readonly CorpusFile[]): Promise<{ bytes: number; sha256: string }> {
	const hash = createHash('sha256');
	let bytes = 0;
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update('\0');
		for await (const chunk of Bun.file(file.absolutePath).stream()) {
			hash.update(chunk);
			bytes += chunk.byteLength;
		}
		hash.update('\0');
	}
	return { bytes, sha256: hash.digest('hex') };
}

export async function generateSyntheticCorpus(
	projectsDir: string,
	records: number,
): Promise<GeneratedCorpus> {
	const mix = expectedMix(records);
	const files: CorpusFile[] = [];
	let intendedBytes = 0;
	try {
		for (const relativePath of fixedRelativePaths()) {
			const absolutePath = join(projectsDir, ...relativePath.split('/'));
			await mkdir(dirname(absolutePath), { recursive: true });
			const stream = createWriteStream(absolutePath, { encoding: 'utf8' });
			const finished = new Promise<void>((resolve, reject) => {
				stream.once('finish', resolve);
				stream.once('error', reject);
			});
			files.push({ relativePath, absolutePath, stream, finished });
		}

		for (let index = 0; index < records; index++) {
			const file = files[index % FILE_COUNT];
			if (!file) throw new Error('synthetic corpus file layout is incomplete');
			const line = `${SYNTHETIC_LINES[recordKind(index)]}\n`;
			intendedBytes += Buffer.byteLength(line);
			if (!file.stream.write(line)) await once(file.stream, 'drain');
		}

		for (const file of files) file.stream.end();
		await Promise.all(files.map((file) => file.finished));

		const inspected = await inspectCorpus(files);
		if (inspected.bytes !== intendedBytes) {
			throw new Error('synthetic corpus byte verification failed');
		}
		const acceptedRecords = mix.currentAssistant + mix.legacyAssistant;
		return {
			projectsDir,
			manifest: {
				corpusVersion: CORPUS_VERSION,
				generator: { algorithm: GENERATOR_ALGORITHM, seed: GENERATOR_SEED },
				layout: {
					projects: PROJECT_COUNT,
					filesPerProject: FILES_PER_PROJECT,
					files: FILE_COUNT,
				},
				records,
				bytes: inspected.bytes,
				sha256: inspected.sha256,
				maxLineBytes: Math.max(
					...Object.values(SYNTHETIC_LINES).map((line) => Buffer.byteLength(line)),
				),
				mix,
				expected: {
					acceptedRecords,
					ignoredRecords: mix.knownContext,
					diagnosticLines: 0,
				},
			},
		};
	} catch (error) {
		for (const file of files) file.stream.destroy();
		await Promise.allSettled(files.map((file) => file.finished));
		throw error;
	}
}

export interface WorkerResult {
	schemaVersion: 1;
	acceptedRecords: number;
	ignoredRecords: number;
	diagnosticLines: number;
	parseWallMs: number;
}

function finitePositive(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

export function validateWorkerResult(value: unknown, manifest: CorpusManifest): WorkerResult {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('benchmark worker returned an invalid result object');
	}
	const result = value as Partial<WorkerResult>;
	if (
		result.schemaVersion !== 1 ||
		!nonNegativeSafeInteger(result.acceptedRecords) ||
		!nonNegativeSafeInteger(result.ignoredRecords) ||
		!nonNegativeSafeInteger(result.diagnosticLines) ||
		!finitePositive(result.parseWallMs)
	) {
		throw new Error('benchmark worker returned invalid result fields');
	}
	if (
		result.acceptedRecords !== manifest.expected.acceptedRecords ||
		result.ignoredRecords !== manifest.expected.ignoredRecords ||
		result.diagnosticLines !== 0 ||
		result.acceptedRecords + result.ignoredRecords !== manifest.records
	) {
		throw new Error('benchmark worker record counts or diagnostics did not match the corpus');
	}
	return {
		schemaVersion: 1,
		acceptedRecords: result.acceptedRecords,
		ignoredRecords: result.ignoredRecords,
		diagnosticLines: result.diagnosticLines,
		parseWallMs: result.parseWallMs,
	};
}

export function normalizePeakRssBytes(
	value: unknown,
	hostPlatform: string,
	bunVersion: string,
): number {
	if (!finitePositive(value)) throw new Error('benchmark worker did not report a valid peak RSS');
	// Bun 1.3.13 exposes the native getrusage(2) high-water value here:
	// Linux ru_maxrss is KiB, while Darwin ru_maxrss is bytes. Keep this
	// explicit and fail closed on platforms whose native unit we have not
	// verified instead of publishing a mislabeled receipt.
	if (bunVersion !== '1.3.13') {
		throw new Error('benchmark peak RSS normalization is unverified for this Bun version');
	}
	let bytes: number;
	if (hostPlatform === 'linux') bytes = value * 1024;
	else if (hostPlatform === 'darwin') bytes = value;
	else throw new Error('benchmark peak RSS units are unsupported on this platform');
	if (!Number.isSafeInteger(bytes) || bytes <= 0) {
		throw new Error('benchmark normalized peak RSS is not a positive safe integer');
	}
	return bytes;
}

export function median(values: readonly number[]): number {
	if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
		throw new RangeError('median requires finite samples');
	}
	const sorted = [...values].sort((a, b) => a - b);
	const midpoint = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[midpoint] as number;
	return ((sorted[midpoint - 1] as number) + (sorted[midpoint] as number)) / 2;
}

export function measurementOrder(): number[] {
	return [0, 1, 2, 1, 2, 0, 2, 0, 1];
}

export interface BenchmarkCaseSummary {
	records: number;
	medianParseWallMs: number;
	maxPeakRssBytes: number;
	recordsPerSecond: number;
}

export interface BenchmarkCheck {
	id: 'medium-to-large-wall-ratio' | 'fixed-file-rss-envelope';
	status: 'passed' | 'failed' | 'skipped';
	actual: number;
	limit: number;
	unit: 'ratio' | 'bytes';
	reason?: string;
}

export interface ScaleEvaluation {
	observations: {
		smallToMediumWallRatio: number;
		mediumToLargeWallRatio: number;
		rssEnvelopeGrowthBytes: number;
	};
	checks: BenchmarkCheck[];
}

export function evaluateScale(cases: readonly BenchmarkCaseSummary[]): ScaleEvaluation {
	if (cases.length !== 3) throw new RangeError('scale evaluation requires exactly three cases');
	const [small, medium, large] = [...cases].sort((a, b) => a.records - b.records);
	if (!small || !medium || !large) throw new RangeError('scale cases are incomplete');
	for (const item of [small, medium, large]) {
		if (
			!finitePositive(item.records) ||
			!finitePositive(item.medianParseWallMs) ||
			!finitePositive(item.maxPeakRssBytes)
		) {
			throw new RangeError('scale cases require positive finite measurements');
		}
	}
	const smallToMediumWallRatio = medium.medianParseWallMs / small.medianParseWallMs;
	const mediumToLargeWallRatio = large.medianParseWallMs / medium.medianParseWallMs;
	const rssEnvelopeGrowthBytes = Math.max(
		0,
		Math.max(medium.maxPeakRssBytes, large.maxPeakRssBytes) - small.maxPeakRssBytes,
	);
	const wallCheck: BenchmarkCheck =
		medium.medianParseWallMs < MIN_RATIO_DENOMINATOR_MS
			? {
					id: 'medium-to-large-wall-ratio',
					status: 'skipped',
					actual: mediumToLargeWallRatio,
					limit: MAX_MEDIUM_TO_LARGE_WALL_RATIO,
					unit: 'ratio',
					reason: `medium median is below ${MIN_RATIO_DENOMINATOR_MS} ms`,
				}
			: {
					id: 'medium-to-large-wall-ratio',
					status:
						mediumToLargeWallRatio <= MAX_MEDIUM_TO_LARGE_WALL_RATIO ? 'passed' : 'failed',
					actual: mediumToLargeWallRatio,
					limit: MAX_MEDIUM_TO_LARGE_WALL_RATIO,
					unit: 'ratio',
				};
	const rssCheck: BenchmarkCheck = {
		id: 'fixed-file-rss-envelope',
		status: rssEnvelopeGrowthBytes <= MAX_RSS_ENVELOPE_GROWTH_BYTES ? 'passed' : 'failed',
		actual: rssEnvelopeGrowthBytes,
		limit: MAX_RSS_ENVELOPE_GROWTH_BYTES,
		unit: 'bytes',
	};
	return {
		observations: {
			smallToMediumWallRatio,
			mediumToLargeWallRatio,
			rssEnvelopeGrowthBytes,
		},
		checks: [wallCheck, rssCheck],
	};
}

export interface HistoricalComparisonInput {
	identity: {
		bunVersion: string;
		platform: string;
		arch: string;
		osRelease: string;
		cpuModel: string;
		profile: BenchmarkProfileName;
		corpusVersion: string;
		generatorAlgorithm: string;
		generatorSeed: string;
		peakRssNormalizationId: string;
	};
	cases: BenchmarkCaseSummary[];
}

export interface HistoricalComparison {
	status: 'skipped' | 'advisory';
	reason?: string;
	regressions: Array<{
		records: number;
		metric: 'throughput' | 'peak-rss';
		baseline: number;
		current: number;
		threshold: number;
	}>;
}

export function historicalInputFromReceipt(value: unknown): HistoricalComparisonInput {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('historical benchmark receipt must be an object');
	}
	const receipt = value as {
		schemaVersion?: unknown;
		benchmark?: unknown;
		profile?: unknown;
		corpus?: {
			version?: unknown;
			generator?: { algorithm?: unknown; seed?: unknown };
		};
		environment?: {
			bunVersion?: unknown;
			platform?: unknown;
			arch?: unknown;
			osRelease?: unknown;
			cpuModel?: unknown;
		};
		measurement?: { peakRssNormalizationId?: unknown };
		cases?: unknown;
	};
	if (
		receipt.schemaVersion !== BENCHMARK_SCHEMA_VERSION ||
		receipt.benchmark !== 'parseAll-fixed-file-streaming' ||
		(receipt.profile !== 'smoke' && receipt.profile !== 'full') ||
		!receipt.corpus ||
		!receipt.environment ||
		!receipt.measurement ||
		!Array.isArray(receipt.cases) ||
		receipt.cases.length !== 3 ||
		![
			receipt.corpus.version,
			receipt.corpus.generator?.algorithm,
			receipt.corpus.generator?.seed,
			receipt.environment.bunVersion,
			receipt.environment.platform,
			receipt.environment.arch,
			receipt.environment.osRelease,
			receipt.environment.cpuModel,
			receipt.measurement.peakRssNormalizationId,
		].every((item) => typeof item === 'string' && item.length > 0)
	) {
		throw new Error('historical benchmark receipt is missing comparison fields');
	}
	const cases = receipt.cases.map((item: unknown) => {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			throw new Error('historical benchmark receipt has invalid comparison measurements');
		}
		const candidate = item as Partial<BenchmarkCaseSummary>;
		return {
			records: candidate.records,
			medianParseWallMs: candidate.medianParseWallMs,
			maxPeakRssBytes: candidate.maxPeakRssBytes,
			recordsPerSecond: candidate.recordsPerSecond,
		};
	});
	if (
		cases.some((item) =>
			[item.records, item.medianParseWallMs, item.maxPeakRssBytes, item.recordsPerSecond].some(
				(candidate) =>
					typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0,
			),
		) ||
		new Set(cases.map((item) => item.records)).size !== cases.length
	) {
		throw new Error('historical benchmark receipt has invalid comparison measurements');
	}
	return {
		identity: {
			bunVersion: receipt.environment.bunVersion as string,
			platform: receipt.environment.platform as string,
			arch: receipt.environment.arch as string,
			osRelease: receipt.environment.osRelease as string,
			cpuModel: receipt.environment.cpuModel as string,
			profile: receipt.profile,
			corpusVersion: receipt.corpus.version as string,
			generatorAlgorithm: receipt.corpus.generator?.algorithm as string,
			generatorSeed: receipt.corpus.generator?.seed as string,
			peakRssNormalizationId: receipt.measurement.peakRssNormalizationId as string,
		},
		cases: cases as BenchmarkCaseSummary[],
	};
}

export function compareHistoricalBaseline(
	current: HistoricalComparisonInput,
	baseline: HistoricalComparisonInput,
): HistoricalComparison {
	const identityKeys = [
		'bunVersion',
		'platform',
		'arch',
		'osRelease',
		'cpuModel',
		'profile',
		'corpusVersion',
		'generatorAlgorithm',
		'generatorSeed',
		'peakRssNormalizationId',
	] as const;
	for (const key of identityKeys) {
		if (current.identity[key] !== baseline.identity[key]) {
			return { status: 'skipped', reason: `baseline ${key} does not match`, regressions: [] };
		}
	}
	const baselineByRecords = new Map(baseline.cases.map((item) => [item.records, item]));
	if (
		current.cases.length !== baseline.cases.length ||
		current.cases.some((item) => !baselineByRecords.has(item.records))
	) {
		return { status: 'skipped', reason: 'baseline record sizes do not match', regressions: [] };
	}
	const regressions: HistoricalComparison['regressions'] = [];
	for (const item of current.cases) {
		const previous = baselineByRecords.get(item.records);
		if (!previous) continue;
		const throughputThreshold = previous.recordsPerSecond *
			(1 - HISTORICAL_THROUGHPUT_REGRESSION_FRACTION);
		if (item.recordsPerSecond < throughputThreshold) {
			regressions.push({
				records: item.records,
				metric: 'throughput',
				baseline: previous.recordsPerSecond,
				current: item.recordsPerSecond,
				threshold: throughputThreshold,
			});
		}
		const rssAllowance = Math.max(
			previous.maxPeakRssBytes * HISTORICAL_RSS_REGRESSION_FRACTION,
			HISTORICAL_RSS_REGRESSION_FLOOR_BYTES,
		);
		const rssThreshold = previous.maxPeakRssBytes + rssAllowance;
		if (item.maxPeakRssBytes > rssThreshold) {
			regressions.push({
				records: item.records,
				metric: 'peak-rss',
				baseline: previous.maxPeakRssBytes,
				current: item.maxPeakRssBytes,
				threshold: rssThreshold,
			});
		}
	}
	return { status: 'advisory', regressions };
}
