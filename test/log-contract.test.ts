import { describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { aggregate } from '../src/aggregator.ts';
import {
	LOG_CONTRACT_VERSION,
	LOG_SHAPE_IDS,
	MAX_PARSE_DIAGNOSTIC_SAMPLES,
	classifyLogRecord,
	createParseDiagnostics,
	formatParseDiagnosticSamples,
	isSupportedSubagentMeta,
	type LogShapeId,
	type ParseDiagnosticCode,
} from '../src/log-contract.ts';
import { parseAll, parseFile } from '../src/parser.ts';

const FIXTURE_ROOT = join(import.meta.dir, 'fixtures');
const CONTRACT_ROOT = join(FIXTURE_ROOT, 'log-contract', 'v1');

interface ContractManifest {
	contractVersion: number;
	cases: Array<{
		name: string;
		shapeId: string;
		file: string;
		disposition: 'accepted' | 'ignored';
		records: number;
	}>;
}

function jsonLines(path: string): Record<string, unknown>[] {
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function fixtureFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...fixtureFiles(path));
		else files.push(path);
	}
	return files.sort();
}

function parsedFixtureValues(path: string, text: string): unknown[] {
	if (!path.endsWith('.jsonl')) return [JSON.parse(text)];
	const values: unknown[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			values.push(JSON.parse(line));
		} catch {
			// Malformed JSON is itself an intentional contract fixture.
		}
	}
	return values;
}

function expectSyntheticPayload(value: unknown, key?: string): void {
	if (typeof value === 'string') {
		if (key === 'content' || key === 'text' || key === 'description') {
			expect(value).toBe('');
		}
		expect(value).not.toMatch(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\|~\/\.)/);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) expectSyntheticPayload(item, key);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const record = value as Record<string, unknown>;
	expect(record.type).not.toBe('thinking');
	expect(record.type).not.toBe('tool_result');
	for (const [childKey, child] of Object.entries(record)) {
		expect(['prompt', 'cwd', 'gitBranch', 'signature', 'query', 'command']).not.toContain(
			childKey,
		);
		if (childKey === 'input') {
			expect(child).toEqual({});
			continue;
		}
		expectSyntheticPayload(child, childKey);
	}
}

describe('Claude log contract v1', () => {
	test('names every supported synthetic fixture with a tool-owned version', () => {
		const manifest = JSON.parse(
			readFileSync(join(CONTRACT_ROOT, 'manifest.json'), 'utf8'),
		) as ContractManifest;
		expect(manifest.contractVersion).toBe(LOG_CONTRACT_VERSION);
		expect(new Set(manifest.cases.map((item) => item.name)).size).toBe(manifest.cases.length);

		for (const item of manifest.cases) {
			expect(Object.values(LOG_SHAPE_IDS) as readonly string[]).toContain(item.shapeId);
			const path = join(CONTRACT_ROOT, item.file);
			if (item.file.endsWith('.meta.json')) {
				expect(isSupportedSubagentMeta(JSON.parse(readFileSync(path, 'utf8')))).toBe(true);
				continue;
			}
			const records = jsonLines(path);
			expect(records).toHaveLength(item.records);
			for (const record of records) {
				const classification = classifyLogRecord(record);
				expect(classification.status).toBe(item.disposition);
				if (classification.status !== 'invalid') {
					expect(String(classification.shapeId)).toBe(item.shapeId);
				}
			}
		}
	});

	test('accepts current and legacy usage without retaining the raw record', async () => {
		for (const file of ['assistant-current.jsonl', 'assistant-legacy.jsonl']) {
			const diagnostics = createParseDiagnostics();
			const turns = [];
			for await (const turn of parseFile(join(CONTRACT_ROOT, file), undefined, undefined, undefined, undefined, { diagnostics })) {
				turns.push(turn);
			}
			expect(turns).toHaveLength(1);
			expect(turns[0]?.type).toBe('assistant');
			expect(Object.keys(turns[0] ?? {})).not.toContain('raw');
			expect(diagnostics.samples).toEqual([]);
		}
		const from = new Date('2026-08-03T00:00:00Z');
		const to = new Date('2026-08-04T00:00:00Z');
		const report = await aggregate(
			parseFile(join(CONTRACT_ROOT, 'assistant-current.jsonl')),
			from,
			to,
		);
		expect(report.total.cacheCreation5mTokens).toBe(3);
		expect(report.total.cacheCreation1hTokens).toBe(2);
	});

	test('ignores known non-billable records without inventing timestamps', async () => {
		const diagnostics = createParseDiagnostics();
		const turns = [];
		for (const file of ['context-known.jsonl', 'metadata-known.jsonl']) {
			for await (const turn of parseFile(join(CONTRACT_ROOT, file), undefined, undefined, undefined, undefined, { diagnostics })) {
				turns.push(turn);
			}
		}
		expect(turns).toEqual([]);
		expect(diagnostics.ignoredSourceRecordLines).toBe(10);
		expect(diagnostics.samples).toEqual([]);
	});

	test('rejects direct usage envelopes outside assistant message.usage', () => {
		const cases: Array<{
			record: Record<string, unknown>;
			code: Exclude<
				ParseDiagnosticCode,
				'malformed-json' | 'unsupported-json-root' | 'invalid-subagent-meta'
			>;
			shapeId: LogShapeId;
		}> = [
			{
				record: { type: 'user', message: { usage: null } },
				code: 'unexpected-usage-on-nonbillable-record',
				shapeId: LOG_SHAPE_IDS.contextEvent,
			},
			{
				record: { type: 'system', usage: {} },
				code: 'unexpected-usage-on-nonbillable-record',
				shapeId: LOG_SHAPE_IDS.contextEvent,
			},
			{
				record: { type: 'attachment', message: { usage: {} } },
				code: 'unexpected-usage-on-nonbillable-record',
				shapeId: LOG_SHAPE_IDS.auxiliaryEvent,
			},
			{
				record: {
					type: 'assistant',
					timestamp: '2026-08-03T01:02:03Z',
					usage: {},
					message: {
						model: 'claude-sonnet-4-6',
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
				code: 'unexpected-assistant-usage-location',
				shapeId: LOG_SHAPE_IDS.assistantUsage,
			},
		];

		for (const item of cases) {
			const classification = classifyLogRecord(item.record);
			expect(classification.status).toBe('invalid');
			if (classification.status === 'invalid') {
				expect(classification.code).toBe(item.code);
				expect(classification.expectedShape).toBe(item.shapeId);
			}
		}
	});

	test('bounds actionable diagnostics without echoing unsupported record data', async () => {
		const diagnostics = createParseDiagnostics();
		const turns = [];
		for await (const turn of parseFile(
			join(CONTRACT_ROOT, 'invalid-records.jsonl'),
			undefined,
			undefined,
			undefined,
			undefined, { diagnostics, strictTimestamps: true },
		)) {
			turns.push(turn);
		}
		expect(turns).toEqual([]);
		expect(diagnostics).toMatchObject({
			malformedJsonLines: 1,
			unsupportedRecordLines: 2,
			invalidTimestampLines: 1,
			invalidUsageLines: 9,
			invalidSubagentMetaFiles: 0,
			ignoredSourceRecordLines: 0,
		});
		expect(diagnostics.samples).toHaveLength(MAX_PARSE_DIAGNOSTIC_SAMPLES);
		for (const sample of diagnostics.samples) {
			expect(Object.keys(sample).sort()).toEqual(
				['code', 'expectedShape', 'line', 'reason', 'source'].sort(),
			);
		}
		const serialized = JSON.stringify(diagnostics);
		expect(serialized).not.toContain('DO_NOT_ECHO_SYNTHETIC_MARKER');
		expect(formatParseDiagnosticSamples(diagnostics, true).join('\n')).not.toContain(
			basename(join(CONTRACT_ROOT, 'invalid-records.jsonl')),
		);
	});

	test('diagnoses incompatible subagent metadata without retaining its fields', async () => {
		const root = mkdtempSync(join(tmpdir(), 'agent-ledger-meta-contract-'));
		try {
			const subagents = join(root, 'synthetic-project', 'synthetic-session', 'subagents');
			mkdirSync(subagents, { recursive: true });
			writeFileSync(
				join(subagents, 'synthetic-agent.jsonl'),
				readFileSync(join(CONTRACT_ROOT, 'assistant-legacy.jsonl')),
			);
			writeFileSync(
				join(subagents, 'synthetic-agent.meta.json'),
				'{"agentType":42,"private_marker":"DO_NOT_ECHO_SYNTHETIC_MARKER"}',
			);
			const diagnostics = createParseDiagnostics();
			const turns = [];
			for await (const turn of parseAll({ projectsDir: root, diagnostics })) turns.push(turn);
			expect(turns).toHaveLength(1);
			expect(turns[0]?.subagentType).toBeUndefined();
			expect(diagnostics.invalidSubagentMetaFiles).toBe(1);
			expect(JSON.stringify(diagnostics)).not.toContain('DO_NOT_ECHO_SYNTHETIC_MARKER');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('public fixture privacy', () => {
	test('contains no prompt text, project paths, or common credential markers', () => {
		for (const path of fixtureFiles(FIXTURE_ROOT)) {
			const text = readFileSync(path, 'utf8');
			expect(text).not.toMatch(/"content"\s*:\s*"/);
			expect(text).not.toMatch(/Fix the release script|Review this PR|\bhello\b/i);
			expect(text).not.toMatch(/sk-ant-|ghp_|Bearer\s|-----BEGIN [A-Z ]+ PRIVATE KEY-----/i);
			expect(text).not.toMatch(/"(?:cwd|gitBranch|signature|thinking)"\s*:/);
			for (const value of parsedFixtureValues(path, text)) expectSyntheticPayload(value);
		}
	});
});
