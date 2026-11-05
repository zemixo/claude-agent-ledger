import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { parseAll, parseFile } from '../src/parser.ts';
import { costFor } from '../src/pricing.ts';
import type { SessionTurn } from '../src/types.ts';

const valid = {
	type: 'assistant', timestamp: '2026-04-21T12:00:00Z',
	message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 100 } },
};

async function readRecords(records: unknown[], skipped: string[] = []) {
	const root = mkdtempSync(join(tmpdir(), 'ledger-records-'));
	try {
		const path = join(root, 'synthetic.jsonl');
		writeFileSync(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
		const turns: SessionTurn[] = [];
		for await (const turn of parseFile(path, undefined, undefined, undefined, (reason) => skipped.push(reason))) turns.push(turn);
		return turns;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('bad record shapes, dates and token counts do not crash or fabricate costs', async () => {
	const skipped: string[] = [];
	const turns = await readRecords([
		null, [], 7,
		{ ...valid, timestamp: undefined },
		{ ...valid, timestamp: 'not-a-date' },
		{ ...valid, message: { usage: { input_tokens: -100, output_tokens: 0 } } },
		{ ...valid, message: { model: 7, usage: { input_tokens: 100, output_tokens: 0 } } },
		{ ...valid, message: { usage: { input_tokens: '100', output_tokens: 0 } } },
		{ ...valid, message: { usage: { input_tokens: 0.5, output_tokens: 0 } } },
		{ ...valid, type: { toString: null } },
		valid,
	], skipped);
	expect(turns).toHaveLength(1);
	expect(turns[0]?.timestamp).toBe(valid.timestamp);
	expect(costFor(turns[0]!.usage!, turns[0]!.model).totalCost).toBeCloseTo(0.0018, 8);
	expect(skipped).toContain('invalid_timestamp');
	expect(skipped).toContain('invalid_usage');
});

test('partial legacy counters normalize missing input and output to zero', async () => {
	const turns = await readRecords([{ ...valid, message: {
		model: 'claude-sonnet-4-6', usage: { cache_read_input_tokens: 100 },
	} }]);
	expect(turns[0]?.usage?.input_tokens).toBe(0);
	expect(turns[0]?.usage?.output_tokens).toBe(0);
	expect(costFor(turns[0]!.usage!, turns[0]!.model).totalCost).toBeCloseTo(0.00003, 8);
});

test('arbitrary JSON records cannot throw or produce non-finite costs', async () => {
	await fc.assert(fc.asyncProperty(fc.array(fc.jsonValue(), { maxLength: 12 }), async (records) => {
		const turns = await readRecords([...records, valid]);
		for (const turn of turns) {
			expect(Number.isFinite(Date.parse(turn.timestamp))).toBe(true);
			if (turn.usage) {
				const cost = costFor(turn.usage, turn.model).totalCost;
				expect(Number.isFinite(cost)).toBe(true);
				expect(cost).toBeGreaterThanOrEqual(0);
			}
		}
	}), { numRuns: 50 });
});

test('a symlink directory cycle terminates without duplicating session logs', async () => {
	const root = mkdtempSync(join(tmpdir(), 'ledger-cycle-'));
	try {
		const project = join(root, 'project');
		mkdirSync(project);
		writeFileSync(join(project, 'session.jsonl'), JSON.stringify(valid) + '\n');
		symlinkSync(project, join(project, 'cycle'), 'dir');
		const turns: SessionTurn[] = [];
		for await (const turn of parseAll({ projectsDir: root })) turns.push(turn);
		expect(turns).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
