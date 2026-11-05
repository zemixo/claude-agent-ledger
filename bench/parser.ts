import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
	BENCHMARK_PROFILES,
	BENCHMARK_SCHEMA_VERSION,
	CHILD_TIMEOUT_MS,
	CORPUS_VERSION,
	FILE_COUNT,
	FILES_PER_PROJECT,
	GENERATOR_ALGORITHM,
	GENERATOR_SEED,
	MAX_MEDIUM_TO_LARGE_WALL_RATIO,
	MAX_RSS_ENVELOPE_GROWTH_BYTES,
	MEASURED_RUNS,
	MIN_RATIO_DENOMINATOR_MS,
	PROJECT_COUNT,
	PEAK_RSS_NORMALIZATION_ID,
	compareHistoricalBaseline,
	evaluateScale,
	generateSyntheticCorpus,
	historicalInputFromReceipt,
	measurementOrder,
	median,
	normalizePeakRssBytes,
	validateWorkerResult,
	type BenchmarkCaseSummary,
	type BenchmarkCheck,
	type BenchmarkProfileName,
	type CorpusManifest,
	type GeneratedCorpus,
	type HistoricalComparison,
	type WorkerResult,
} from './lib.ts';

const REPO_ROOT = join(import.meta.dir, '..');
const WORKER_PATH = join(import.meta.dir, 'parse-worker.ts');
const MIB = 1024 * 1024;

interface CliOptions {
	profile: BenchmarkProfileName;
	check: boolean;
	requireClean: boolean;
	output?: string;
	baseline?: string;
}

interface BenchmarkSample extends WorkerResult {
	processWallMs: number;
	peakRssBytes: number;
}

interface BenchmarkCase extends CorpusManifest, BenchmarkCaseSummary {
	size: 'small' | 'medium' | 'large';
	samples: BenchmarkSample[];
	maxPeakRssBytes: number;
	medianParseWallMs: number;
	recordsPerSecond: number;
	mibPerSecond: number;
}

interface BenchmarkReceipt {
	schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
	benchmark: 'parseAll-fixed-file-streaming';
	generatedAt: string;
	source: {
		commit: string;
		dirty: boolean;
	};
	profile: BenchmarkProfileName;
	corpus: {
		version: typeof CORPUS_VERSION;
		generator: {
			algorithm: typeof GENERATOR_ALGORITHM;
			seed: typeof GENERATOR_SEED;
		};
		layout: {
			projects: typeof PROJECT_COUNT;
			filesPerProject: typeof FILES_PER_PROJECT;
			files: typeof FILE_COUNT;
		};
	};
	environment: {
		bunVersion: string;
		platform: string;
		arch: string;
		osRelease: string;
		cpuModel: string;
		timezone: 'UTC';
	};
	measurement: {
		warmupsPerSize: 1;
		samplesPerSize: typeof MEASURED_RUNS;
		warmupOrder: readonly ['small', 'medium', 'large'];
		sampleOrder: readonly string[];
		parseTimer: 'worker performance.now around parseAll discovery and drain';
		processTimer: 'parent performance.now from spawn through exit';
		peakRss: 'fresh child lifetime high-water bytes from Bun.Subprocess.resourceUsage';
		peakRssNormalizationId: typeof PEAK_RSS_NORMALIZATION_ID;
		peakRssNormalization: 'Bun 1.3.13 native ru_maxrss: Linux KiB x 1024; Darwin bytes';
		wallAggregation: 'median of three samples';
		rssAggregation: 'maximum of three samples';
		throughputDenominator: 'all input records';
		filesystemCache: 'best-effort warm after corpus verification and one warm-up';
		childTimeoutMs: typeof CHILD_TIMEOUT_MS;
	};
	thresholds: {
		mediumToLargeWallRatio: typeof MAX_MEDIUM_TO_LARGE_WALL_RATIO;
		minimumRatioDenominatorMs: typeof MIN_RATIO_DENOMINATOR_MS;
		fixedFileRssEnvelopeGrowthBytes: typeof MAX_RSS_ENVELOPE_GROWTH_BYTES;
		historicalComparison: 'advisory-only';
	};
	cases: BenchmarkCase[];
	observations: ReturnType<typeof evaluateScale>['observations'];
	checks: BenchmarkCheck[];
	historicalComparison?: HistoricalComparison;
}

function usage(): string {
	return `Usage: bun run benchmark -- [options]

Options:
  --profile <smoke|full>  Corpus sizes (default: full)
  --check                 Exit non-zero when deterministic scale checks fail
  --require-clean         Refuse to publish a receipt from a dirty checkout
  --output <path>         Write JSON receipt and print a Markdown summary
  --baseline <path>       Add an advisory comparison with an older receipt
  --help                   Show this help`;
}

function parseArgs(args: readonly string[]): CliOptions {
	const options: CliOptions = { profile: 'full', check: false, requireClean: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === '--help') {
			console.log(usage());
			process.exit(0);
		}
		if (arg === '--check') {
			options.check = true;
			continue;
		}
		if (arg === '--require-clean') {
			options.requireClean = true;
			continue;
		}
		if (arg === '--profile') {
			const profile = args[++index];
			if (profile !== 'smoke' && profile !== 'full') {
				throw new Error('benchmark profile must be smoke or full');
			}
			options.profile = profile;
			continue;
		}
		if (arg === '--output' || arg === '--baseline') {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a path`);
			if (arg === '--output') options.output = value;
			else options.baseline = value;
			continue;
		}
		throw new Error('unknown benchmark argument');
	}
	return options;
}

function gitText(args: readonly string[]): string {
	const result = Bun.spawnSync({
		cmd: ['git', ...args],
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'ignore',
	});
	if (result.exitCode !== 0) throw new Error('benchmark source metadata is unavailable');
	return new TextDecoder().decode(result.stdout).trim();
}

function sourceMetadata(): BenchmarkReceipt['source'] {
	return {
		commit: gitText(['rev-parse', 'HEAD']),
		dirty: gitText(['status', '--porcelain']).length > 0,
	};
}

async function runWorker(corpus: GeneratedCorpus): Promise<BenchmarkSample> {
	const processStartedAt = performance.now();
	const child = Bun.spawn({
		cmd: [process.execPath, WORKER_PATH, '--projects-dir', corpus.projectsDir],
		cwd: REPO_ROOT,
		env: { TZ: 'UTC' },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: CHILD_TIMEOUT_MS,
		killSignal: 'SIGKILL',
		maxBuffer: 1024 * 1024,
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();
	const exitCode = await child.exited;
	const processWallMs = performance.now() - processStartedAt;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
	if (exitCode !== 0) {
		const reason = stderr.trim() || 'no diagnostic output';
		throw new Error(`benchmark worker failed (${reason})`);
	}
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length !== 1) throw new Error('benchmark worker returned multiple or missing results');
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines[0] as string);
	} catch {
		throw new Error('benchmark worker returned malformed JSON');
	}
	const result = validateWorkerResult(parsed, corpus.manifest);
	const peakRssBytes = normalizePeakRssBytes(
		child.resourceUsage()?.maxRSS,
		platform(),
		Bun.version,
	);
	if (!Number.isFinite(processWallMs) || processWallMs <= 0) {
		throw new Error('benchmark parent timer returned an invalid duration');
	}
	return { ...result, processWallMs, peakRssBytes };
}

function summarizeCase(
	corpus: GeneratedCorpus,
	size: BenchmarkCase['size'],
	samples: BenchmarkSample[],
): BenchmarkCase {
	if (samples.length !== MEASURED_RUNS) throw new Error('benchmark sample set is incomplete');
	const medianParseWallMs = median(samples.map((sample) => sample.parseWallMs));
	const maxPeakRssBytes = Math.max(...samples.map((sample) => sample.peakRssBytes));
	const seconds = medianParseWallMs / 1000;
	return {
		...corpus.manifest,
		size,
		samples,
		medianParseWallMs,
		maxPeakRssBytes,
		recordsPerSecond: corpus.manifest.records / seconds,
		mibPerSecond: corpus.manifest.bytes / MIB / seconds,
	};
}

function formatNumber(value: number, digits = 1): string {
	return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function renderMarkdown(receipt: BenchmarkReceipt): string {
	const lines = [
		'# Parser benchmark',
		'',
		`- Profile: \`${receipt.profile}\``,
		`- Source: \`${receipt.source.commit.slice(0, 12)}\` (${receipt.source.dirty ? 'dirty' : 'clean'})`,
		`- Runtime: Bun ${receipt.environment.bunVersion}, ${receipt.environment.platform}/${receipt.environment.arch}`,
		'',
		'| Records | Corpus MiB | Median parse ms | Peak RSS MiB | records/s | MiB/s |',
		'|---:|---:|---:|---:|---:|---:|',
	];
	for (const item of receipt.cases) {
		lines.push(
			`| ${formatNumber(item.records, 0)} | ${formatNumber(item.bytes / MIB)} | ${formatNumber(item.medianParseWallMs)} | ${formatNumber(item.maxPeakRssBytes / MIB)} | ${formatNumber(item.recordsPerSecond, 0)} | ${formatNumber(item.mibPerSecond)} |`,
		);
	}
	lines.push('', '| Check | Status | Actual | Limit |', '|---|---|---:|---:|');
	for (const check of receipt.checks) {
		const divisor = check.unit === 'bytes' ? MIB : 1;
		const suffix = check.unit === 'bytes' ? ' MiB' : '×';
		lines.push(
			`| ${check.id} | ${check.status} | ${formatNumber(check.actual / divisor, 2)}${suffix} | ${formatNumber(check.limit / divisor, 2)}${suffix} |`,
		);
	}
	if (receipt.historicalComparison) {
		lines.push(
			'',
			`Historical comparison: ${receipt.historicalComparison.status}; ${receipt.historicalComparison.regressions.length} advisory regression(s).`,
		);
	}
	return `${lines.join('\n')}\n`;
}

async function run(options: CliOptions): Promise<BenchmarkReceipt> {
	const source = sourceMetadata();
	if (options.requireClean && source.dirty) {
		throw new Error('benchmark receipt requires a clean checkout');
	}
	const root = await mkdtemp(join(tmpdir(), 'agent-ledger-parser-benchmark-'));
	try {
		const corpora: GeneratedCorpus[] = [];
		for (const [index, records] of BENCHMARK_PROFILES[options.profile].entries()) {
			corpora.push(await generateSyntheticCorpus(join(root, `size-${index}`), records));
		}

		for (const corpus of corpora) await runWorker(corpus);
		const samplesBySize: BenchmarkSample[][] = corpora.map(() => []);
		for (const index of measurementOrder()) {
			const corpus = corpora[index];
			const samples = samplesBySize[index];
			if (!corpus || !samples) throw new Error('benchmark measurement order is invalid');
			samples.push(await runWorker(corpus));
		}

		const names = ['small', 'medium', 'large'] as const;
		const cases = corpora.map((corpus, index) =>
			summarizeCase(corpus, names[index] as BenchmarkCase['size'], samplesBySize[index] ?? []),
		);
		const scale = evaluateScale(cases);
		const receipt: BenchmarkReceipt = {
			schemaVersion: BENCHMARK_SCHEMA_VERSION,
			benchmark: 'parseAll-fixed-file-streaming',
			generatedAt: new Date().toISOString(),
			source,
			profile: options.profile,
			corpus: {
				version: CORPUS_VERSION,
				generator: { algorithm: GENERATOR_ALGORITHM, seed: GENERATOR_SEED },
				layout: {
					projects: PROJECT_COUNT,
					filesPerProject: FILES_PER_PROJECT,
					files: FILE_COUNT,
				},
			},
			environment: {
				bunVersion: Bun.version,
				platform: platform(),
				arch: arch(),
				osRelease: release(),
				cpuModel: cpus()[0]?.model.trim() || 'unknown',
				timezone: 'UTC',
			},
			measurement: {
				warmupsPerSize: 1,
				samplesPerSize: MEASURED_RUNS,
				warmupOrder: ['small', 'medium', 'large'],
				sampleOrder: measurementOrder().map((index) => names[index] as string),
				parseTimer: 'worker performance.now around parseAll discovery and drain',
				processTimer: 'parent performance.now from spawn through exit',
				peakRss: 'fresh child lifetime high-water bytes from Bun.Subprocess.resourceUsage',
				peakRssNormalizationId: PEAK_RSS_NORMALIZATION_ID,
				peakRssNormalization: 'Bun 1.3.13 native ru_maxrss: Linux KiB x 1024; Darwin bytes',
				wallAggregation: 'median of three samples',
				rssAggregation: 'maximum of three samples',
				throughputDenominator: 'all input records',
				filesystemCache: 'best-effort warm after corpus verification and one warm-up',
				childTimeoutMs: CHILD_TIMEOUT_MS,
			},
			thresholds: {
				mediumToLargeWallRatio: MAX_MEDIUM_TO_LARGE_WALL_RATIO,
				minimumRatioDenominatorMs: MIN_RATIO_DENOMINATOR_MS,
				fixedFileRssEnvelopeGrowthBytes: MAX_RSS_ENVELOPE_GROWTH_BYTES,
				historicalComparison: 'advisory-only',
			},
			cases,
			observations: scale.observations,
			checks: scale.checks,
		};

		if (options.baseline) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await Bun.file(resolve(options.baseline)).text());
			} catch {
				throw new Error('historical benchmark receipt could not be read');
			}
			receipt.historicalComparison = compareHistoricalBaseline(
				historicalInputFromReceipt(receipt),
				historicalInputFromReceipt(parsed),
			);
		}
		return receipt;
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	const receipt = await run(options);
	const json = `${JSON.stringify(receipt, null, 2)}\n`;
	if (options.output) {
		const output = resolve(options.output);
		await mkdir(dirname(output), { recursive: true });
		await Bun.write(output, json);
		console.log(renderMarkdown(receipt));
	} else {
		console.log(json);
	}
	if (options.check && receipt.checks.some((check) => check.status === 'failed')) {
		process.exitCode = 1;
	}
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : 'parser benchmark failed');
	process.exitCode = 1;
});
