import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(
	new URL('../.github/workflows/ci.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf8');

function indentation(line: string): number {
	return line.length - line.trimStart().length;
}

function section(source: string, key: string, level: number): string {
	const lines = source.split('\n');
	const marker = `${' '.repeat(level)}${key}:`;
	const start = lines.findIndex(
		(line) => line === marker || line.startsWith(`${marker} `),
	);
	if (start === -1) throw new Error(`missing workflow section: ${key}`);

	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? '';
		if (line.trim() !== '' && indentation(line) <= level) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end).join('\n').trimEnd();
}

describe('CI workflow contract', () => {
	test('validates stacked pull requests and manually selected branches', () => {
		const triggers = section(workflow, 'on', 0);
		expect(triggers).toContain('  push:\n    branches: [main]');
		expect(triggers).toMatch(/^  pull_request: \{\}$/m);
		expect(triggers).toMatch(/^  workflow_dispatch: \{\}$/m);
		expect(triggers).not.toContain('pull_request_target');
	});

	test('keeps the validation job bounded and least privilege', () => {
		const permissions = section(workflow, 'permissions', 0);
		const testJob = section(section(workflow, 'jobs', 0), 'test', 2);
		const steps = section(testJob, 'steps', 4);

		expect(permissions).toBe('permissions:\n  contents: read');
		expect(testJob).toContain('    timeout-minutes: 10');
		expect(steps).toMatch(
			/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n        with:\n          persist-credentials: false/,
		);
	});

	test('runs the complete release gate', () => {
		const testJob = section(section(workflow, 'jobs', 0), 'test', 2);
		for (const command of [
			'bun run typecheck',
			'bun test',
			'bun run build',
		]) {
			expect(testJob).toContain(`run: ${command}`);
		}
	});
});
