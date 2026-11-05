import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	FILE_COUNT,
	MAX_RSS_ENVELOPE_GROWTH_BYTES,
	compareHistoricalBaseline,
	evaluateScale,
	expectedMix,
	generateSyntheticCorpus,
	historicalInputFromReceipt,
	measurementOrder,
	median,
	normalizePeakRssBytes,
	validateWorkerResult,
	type BenchmarkCaseSummary,
	type HistoricalComparisonInput,
} from '../bench/lib.ts';
import { createParseDiagnostics } from '../src/log-contract.ts';
import { parseAll } from '../src/parser.ts';

const MIB = 1024 * 1024;

function jsonlFiles(root: string): string[] {
	const files: string[] = [];
	for (const project of readdirSync(root, { withFileTypes: true })) {
		if (!project.isDirectory()) continue;
		for (const file of readdirSync(join(root, project.name), { withFileTypes: true })) {
			if (file.isFile() && file.name.endsWith('.jsonl')) {
				files.push(join(root, project.name, file.name));
			}
		}
	}
	return files.sort();
}

function summary(
	records: number,
	medianParseWallMs: number,
	maxPeakRssBytes: number,
): BenchmarkCaseSummary {
	return { records, medianParseWallMs, maxPeakRssBytes, recordsPerSecond: 1_000 };
}

function historical(
	overrides: Partial<HistoricalComparisonInput['identity']> = {},
): HistoricalComparisonInput {
	return {
		identity: {
			bunVersion: '1.3.13',
			platform: 'linux',
			arch: 'x64',
			osRelease: 'synthetic-kernel-v1',
			cpuModel: 'synthetic-cpu-v1',
			profile: 'full',
			corpusVersion: 'synthetic-log-contract-v1',
			generatorAlgorithm: 'fixed-16-round-robin-index-modulo-10-v1',
			generatorSeed: 'none-fixed-sequence-v1',
			peakRssNormalizationId: 'bun-1.3.13-rumaxrss-linux-kib-darwin-bytes-v1',
			...overrides,
		},
		cases: [
			summary(10_000, 100, 100 * MIB),
			summary(100_000, 500, 110 * MIB),
			summary(1_000_000, 4_000, 120 * MIB),
		],
	};
}

describe('synthetic parser benchmark corpus', () => {
	test('creates a deterministic private-data-free 16-file corpus', async () => {
		const firstRoot = mkdtempSync(join(tmpdir(), 'agent-ledger-bench-test-a-'));
		const secondRoot = mkdtempSync(join(tmpdir(), 'agent-ledger-bench-test-b-'));
		try {
			const first = await generateSyntheticCorpus(firstRoot, 100);
			const second = await generateSyntheticCorpus(secondRoot, 100);
			expect(first.manifest.layout.files).toBe(FILE_COUNT);
			expect(jsonlFiles(firstRoot)).toHaveLength(FILE_COUNT);
			expect(first.manifest.mix).toEqual({
				currentAssistant: 80,
				legacyAssistant: 10,
				knownContext: 10,
			});
			expect(first.manifest.expected).toEqual({
				acceptedRecords: 90,
				ignoredRecords: 10,
				diagnosticLines: 0,
			});
			expect(first.manifest.bytes).toBe(44_480);
			expect(first.manifest.maxLineBytes).toBe(504);
			expect(first.manifest.sha256).toBe(
				'6b5b1b066222aeb264d7c265aa6abd123e26e73ff4e1279dad685a76e00bd282',
			);
			expect(second.manifest.sha256).toBe(first.manifest.sha256);
			expect(JSON.stringify(first.manifest)).not.toContain(firstRoot);

			const text = jsonlFiles(firstRoot)
				.map((path) => readFileSync(path, 'utf8'))
				.join('');
			expect(text).not.toMatch(/sk-ant-|ghp_|Bearer\s|PRIVATE KEY|"cwd"|"thinking"/i);
			expect(text).not.toMatch(/Users\/|home\/|\.claude\/projects/);
		} finally {
			rmSync(firstRoot, { recursive: true, force: true });
			rmSync(secondRoot, { recursive: true, force: true });
		}
	});

	test('rejects pre-normalization receipt schemas', () => {
		const receipt = {
			schemaVersion: 1,
			benchmark: 'parseAll-fixed-file-streaming',
			profile: 'full',
			corpus: {
				version: 'synthetic-log-contract-v1',
				generator: {
					algorithm: 'fixed-16-round-robin-index-modulo-10-v1',
					seed: 'none-fixed-sequence-v1',
				},
			},
			environment: {
				bunVersion: '1.3.13',
				platform: 'linux',
				arch: 'x64',
				osRelease: 'synthetic-kernel-v1',
				cpuModel: 'synthetic-cpu-v1',
			},
			measurement: {
				peakRssNormalizationId: 'bun-1.3.13-rumaxrss-linux-kib-darwin-bytes-v1',
			},
			cases: historical().cases,
		};
		expect(() => historicalInputFromReceipt(receipt)).toThrow('missing comparison fields');
		expect(
			historicalInputFromReceipt({ ...receipt, schemaVersion: 2 }).identity
				.peakRssNormalizationId,
		).toBe('bun-1.3.13-rumaxrss-linux-kib-darwin-bytes-v1');
	});

	test('drains to 90 accepted, 10 ignored, and zero diagnostics', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-bench-parse-'));
		try {
			await generateSyntheticCorpus(root, 100);
			const diagnostics = createParseDiagnostics();
			let accepted = 0;
			for await (const _turn of parseAll({ projectsDir: root, strictSource: true, diagnostics })) {
				accepted++;
			}
			expect(accepted).toBe(90);
			expect(diagnostics).toMatchObject({
				malformedJsonLines: 0,
				unsupportedRecordLines: 0,
				invalidTimestampLines: 0,
				invalidUsageLines: 0,
				invalidSubagentMetaFiles: 0,
				ignoredSourceRecordLines: 10,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('uses an exact deterministic mix for partial cycles', () => {
		expect(expectedMix(9)).toEqual({
			currentAssistant: 8,
			legacyAssistant: 1,
			knownContext: 0,
		});
		expect(expectedMix(10)).toEqual({
			currentAssistant: 8,
			legacyAssistant: 1,
			knownContext: 1,
		});
		expect(() => expectedMix(0)).toThrow();
	});
});

describe('benchmark measurement contract', () => {
	test('requires one worker result and exact counts with no diagnostics', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-bench-result-'));
		try {
			const corpus = await generateSyntheticCorpus(root, 100);
			const result = validateWorkerResult(
				{
					schemaVersion: 1,
					acceptedRecords: 90,
					ignoredRecords: 10,
					diagnosticLines: 0,
					parseWallMs: 1,
					privatePath: '/DO_NOT_SERIALIZE',
				},
				corpus.manifest,
			);
			expect(result.acceptedRecords).toBe(90);
			expect(result).not.toHaveProperty('privatePath');
			expect(() =>
				validateWorkerResult({ ...result, diagnosticLines: 1 }, corpus.manifest),
			).toThrow();
			expect(() =>
				validateWorkerResult({ ...result, acceptedRecords: 89 }, corpus.manifest),
			).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('rejects missing, zero, and non-finite peak RSS', () => {
		expect(normalizePeakRssBytes(127_432, 'linux', '1.3.13')).toBe(130_490_368);
		expect(normalizePeakRssBytes(130_490_368, 'darwin', '1.3.13')).toBe(130_490_368);
		expect(() => normalizePeakRssBytes(undefined, 'linux', '1.3.13')).toThrow();
		expect(() => normalizePeakRssBytes(0, 'linux', '1.3.13')).toThrow();
		expect(() => normalizePeakRssBytes(Number.NaN, 'linux', '1.3.13')).toThrow();
		expect(() => normalizePeakRssBytes(1, 'win32', '1.3.13')).toThrow('unsupported');
		expect(() => normalizePeakRssBytes(1, 'linux', '1.3.14')).toThrow('unverified');
		expect(() =>
			normalizePeakRssBytes(Number.MAX_SAFE_INTEGER, 'linux', '1.3.13'),
		).toThrow('safe integer');
	});

	test('uses fresh-child Latin-square ordering and median aggregation', () => {
		expect(measurementOrder()).toEqual([0, 1, 2, 1, 2, 0, 2, 0, 1]);
		expect(median([9, 1, 5])).toBe(5);
		expect(median([4, 2])).toBe(3);
		expect(() => median([])).toThrow();
	});

	test('checks only stable wall ratios and the full fixed-file RSS envelope', () => {
		const small = summary(10_000, 10, 100 * MIB);
		const medium = summary(100_000, 100, 120 * MIB);
		const large = summary(1_000_000, 1_500, 100 * MIB + MAX_RSS_ENVELOPE_GROWTH_BYTES);
		const boundary = evaluateScale([large, small, medium]);
		expect(boundary.checks).toEqual([
			expect.objectContaining({ id: 'medium-to-large-wall-ratio', status: 'passed' }),
			expect.objectContaining({ id: 'fixed-file-rss-envelope', status: 'passed' }),
		]);

		const wallFailure = evaluateScale([
			small,
			medium,
			{ ...large, medianParseWallMs: 1_500.01 },
		]);
		expect(wallFailure.checks[0]?.status).toBe('failed');

		const rssFailure = evaluateScale([
			small,
			{ ...medium, maxPeakRssBytes: 100 * MIB + MAX_RSS_ENVELOPE_GROWTH_BYTES + 1 },
			large,
		]);
		expect(rssFailure.checks[1]?.status).toBe('failed');

		const noisy = evaluateScale([small, { ...medium, medianParseWallMs: 99 }, large]);
		expect(noisy.checks[0]?.status).toBe('skipped');
	});

	test('keeps historical comparisons advisory and refuses mismatched environments', () => {
		const baseline = historical();
		const mismatch = compareHistoricalBaseline(historical({ arch: 'arm64' }), baseline);
		expect(mismatch).toMatchObject({ status: 'skipped', regressions: [] });
		expect(
			compareHistoricalBaseline(historical({ osRelease: 'other-kernel' }), baseline),
		).toMatchObject({ status: 'skipped', regressions: [] });
		expect(
			compareHistoricalBaseline(historical({ cpuModel: 'other-cpu' }), baseline),
		).toMatchObject({ status: 'skipped', regressions: [] });
		expect(
			compareHistoricalBaseline(
				historical({ peakRssNormalizationId: 'other-normalization' }),
				baseline,
			),
		).toMatchObject({ status: 'skipped', regressions: [] });

		const current = historical();
		current.cases[0] = {
			...current.cases[0]!,
			recordsPerSecond: 700,
			maxPeakRssBytes: 140 * MIB,
		};
		const comparison = compareHistoricalBaseline(current, baseline);
		expect(comparison.status).toBe('advisory');
		expect(comparison.regressions.map((item) => item.metric).sort()).toEqual([
			'peak-rss',
			'throughput',
		]);
	});

	test('worker refuses an implicit default projects directory', async () => {
		const child = Bun.spawn({
			cmd: [process.execPath, join(import.meta.dir, '..', 'bench', 'parse-worker.ts')],
			env: { TZ: 'UTC' },
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		expect(await child.exited).toBe(2);
		expect(await stdout).toBe('');
		expect(await stderr).toBe(
			'benchmark worker requires exactly one synthetic projects directory\n',
		);
	});
});
