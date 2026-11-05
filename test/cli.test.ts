import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json';

const cliPath = fileURLToPath(new URL('../bin/agent-ledger.ts', import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, cliPath, ...args],
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, NO_COLOR: '1', ...env },
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

const explainSessionId = 'private-session-8f3a';

function writeExplainSession(
	projectDir: string,
	sessionId: string,
	subagentType: string,
	timestamp = '2026-08-14T00:00:00.000Z',
): string {
	mkdirSync(projectDir, { recursive: true });
	const sessionPath = join(projectDir, `${sessionId}.jsonl`);
	writeFileSync(
		sessionPath,
		JSON.stringify({
			type: 'assistant',
			timestamp,
			subagentType,
			message: {
				model: 'claude-sonnet-4-6',
				usage: { input_tokens: 1_000, output_tokens: 100 },
				content: [{ type: 'tool_use', name: 'Bash', input: {} }],
			},
		}) + '\n',
		'utf8',
	);
	return sessionPath;
}

function withExplainFixture<T>(run: (home: string, sessionPath: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), 'agent-ledger-explain-'));
	const projectDir = join(home, '.claude', 'projects', '-synthetic');
	const sessionPath = writeExplainSession(projectDir, explainSessionId, 'secret-client-agent');
	try {
		return run(home, sessionPath);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function withRootSessions<T>(rootCount: number, run: (home: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), 'agent-ledger-tree-'));
	const projectDir = join(home, '.claude', 'projects', '-synthetic');
	mkdirSync(projectDir, { recursive: true });
	const timestamp = new Date(Date.now() - 1_000).toISOString();
	for (let i = 0; i < rootCount; i++) {
		writeFileSync(
			join(projectDir, `root-${String(i).padStart(2, '0')}.jsonl`),
			JSON.stringify({
				type: 'assistant',
				timestamp,
				subagentType: `root-${String(i).padStart(2, '0')}`,
				message: {
					model: 'claude-sonnet-4-6',
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
					content: [],
				},
			}) + '\n',
			'utf8',
		);
	}
	try {
		return run(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

async function runCliWithDeadline(args: string[], deadlineMs = 2000) {
	const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-ledger-cli-'));
	mkdirSync(join(isolatedHome, '.claude', 'projects'), { recursive: true });
	try {
		const child = Bun.spawn({
			cmd: [process.execPath, cliPath, ...args],
			stdout: 'pipe',
			stderr: 'pipe',
			env: {
				...process.env,
				HOME: isolatedHome,
				USERPROFILE: isolatedHome,
				NO_COLOR: '1',
			},
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		let timedOut = false;
		const deadline = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, deadlineMs);
		const exitCode = await child.exited;
		clearTimeout(deadline);
		return {
			exitCode,
			stdout: await stdout,
			stderr: await stderr,
			timedOut,
		};
	} finally {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
}

describe('CLI metadata flags', () => {
	for (const args of [['--help'], ['-h'], ['help'], ['week', '--help'], ['forecast', '--help'], ['watch', '--help'], ['watch', '-h']]) {
		test(`${args.join(' ')} prints help and exits successfully`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Usage:');
			expect(result.stderr).toBe('');
		});
	}

	for (const flag of ['--version', '-v']) {
		test(`${flag} prints the package version`, () => {
			const result = runCli([flag]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(packageJson.version);
			expect(result.stderr).toBe('');
		});
	}

	test('an invalid command remains a usage error', () => {
		const result = runCli(['tomorrow']);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Usage:');
	});
});

describe('explain privacy flags', () => {
	test('default output keeps the supplied session identifier', () => {
		withExplainFixture((home) => {
			const result = runCli(['explain', explainSessionId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`# Session ${explainSessionId}`);
			expect(result.stderr).toBe('');
		});
	});

	for (const args of [
		['explain', explainSessionId, '--anonymize'],
		['explain', '--anonymize', explainSessionId],
		['explain', '--anonymize', explainSessionId, '--anonymize'],
	]) {
		test(`${args.slice(1).join(' ')} anonymizes local output`, () => {
			withExplainFixture((home) => {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain('# Session sess-A');
				expect(result.stdout).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stdout).toContain('secret-client-agent');
				expect(result.stdout).toContain('Bash');
			});
		});
	}

	test('anonymized lookup failure does not echo the supplied identifier', () => {
		withExplainFixture((home) => {
			const missingId = 'missing-private-session';
			const result = runCli(['explain', '--anonymize', missingId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('no session found matching the supplied ID');
			expect(result.stderr).not.toContain(missingId);
		});
	});

	test('ambiguous prefixes are rejected instead of selecting the first session', () => {
		withExplainFixture((home) => {
			const secondSessionId = 'private-session-9b4c';
			const longerSessionId = `${explainSessionId}-longer`;
			writeExplainSession(
				join(home, '.claude', 'projects', '-second-synthetic'),
				secondSessionId,
				'second-secret-agent',
			);
			writeExplainSession(
				join(home, '.claude', 'projects', '-third-synthetic'),
				longerSessionId,
				'third-secret-agent',
			);

			for (const args of [
				['explain', 'private-session'],
				['explain', '--anonymize', 'private-session'],
			]) {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('multiple sessions match the supplied ID');
				expect(result.stderr).toContain('agent-ledger week --by session');
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(secondSessionId);
				expect(result.stderr).not.toContain(longerSessionId);
				expect(result.stderr).not.toContain(home);
			}

			const stillAmbiguous = runCli(
				['explain', '--anonymize', 'private-session-8'],
				{ HOME: home, ANTHROPIC_API_KEY: '' },
			);
			expect(stillAmbiguous.exitCode).toBe(1);
			expect(stillAmbiguous.stderr).not.toContain(explainSessionId);

			for (const uniqueId of ['private-session-9', secondSessionId]) {
				const result = runCli(['explain', '--anonymize', uniqueId], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain('# Session sess-A');
				expect(result.stdout).not.toContain(explainSessionId);
				expect(result.stdout).not.toContain(secondSessionId);
				expect(result.stdout).not.toContain(longerSessionId);
				expect(result.stderr).toBe('');
			}

			const exact = runCli(['explain', '--anonymize', explainSessionId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(exact.exitCode).toBe(0);
			expect(exact.stdout).toContain('secret-client-agent');
			expect(exact.stdout).not.toContain('third-secret-agent');
			expect(exact.stdout).not.toContain(explainSessionId);
			expect(exact.stdout).not.toContain(longerSessionId);
		});
	});

	test('--by session emits collision-safe prefixes that resolve through explain', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-session-labels-'));
		const projectsDir = join(home, '.claude', 'projects');
		const currentTimestamp = new Date(Date.now() - 60_000).toISOString();
		const sessions = [
			{
				id: 'agent-aa-current-one',
				project: '-current-one',
				subagent: 'first-session-agent',
			},
			{
				id: 'agent-aa-current-two',
				project: '-current-two',
				subagent: 'second-session-agent',
			},
		];
		const archivedId = 'agent-aa-current-old';
		try {
			for (const session of sessions) {
				writeExplainSession(
					join(projectsDir, session.project),
					session.id,
					session.subagent,
					currentTimestamp,
				);
			}
			writeExplainSession(
				join(projectsDir, '-archived'),
				archivedId,
				'archived-session-agent',
				'2000-01-01T00:00:00.000Z',
			);

			const result = runCli(['month', '--by', 'session', '--json'], { HOME: home });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe('');
			const report = JSON.parse(result.stdout) as {
				rows: Array<{ subagent: string; sessionCount: number; inputTokens: number }>;
				total: { sessionCount: number };
			};
			expect(report.rows).toHaveLength(2);
			expect(report.total.sessionCount).toBe(2);

			for (const row of report.rows) {
				expect(row.subagent.length).toBeGreaterThan(8);
				expect(row.sessionCount).toBe(1);
				expect(row.inputTokens).toBe(1_000);
				const session = sessions.find(({ id }) => id.startsWith(row.subagent));
				expect(session).toBeDefined();

				const explained = runCli(['explain', row.subagent, '--anonymize'], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(explained.exitCode).toBe(0);
				expect(explained.stdout).toContain('# Session sess-A');
				expect(explained.stdout).toContain(session!.subagent);
				expect(explained.stderr).toBe('');
			}

			for (const args of [
				['month', '--by', 'session', '--anonymize'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const anonymized = runCli(args, { HOME: home });
				expect(anonymized.exitCode).toBe(0);
				expect(anonymized.stderr).toBe('');
				expect(anonymized.stdout).toContain('sess-A');
				for (const session of sessions) {
					expect(anonymized.stdout).not.toContain(session.id);
				}
				for (const row of report.rows) {
					expect(anonymized.stdout).not.toContain(row.subagent);
				}
				expect(anonymized.stdout).not.toContain(archivedId);
				expect(anonymized.stdout).not.toContain(home);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('--by session rejects duplicated full ids without leaking either path', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-duplicate-session-'));
		const duplicateId = 'duplicate-private-session-id';
		const timestamp = new Date(Date.now() - 60_000).toISOString();
		try {
			for (const project of ['-first-private-project', '-second-private-project']) {
				writeExplainSession(
					join(home, '.claude', 'projects', project),
					duplicateId,
					'duplicate-session-agent',
					timestamp,
				);
			}

			for (const args of [
				['month', '--by', 'session'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('duplicate full session IDs');
				expect(result.stderr).not.toContain(duplicateId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('DuplicateSessionIdError');
			}

			for (const args of [
				['explain', duplicateId],
				['explain', duplicateId, '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('multiple local logs use this full session ID');
				expect(result.stderr).not.toContain(duplicateId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('DuplicateSessionFileError');
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('--by session rejects unsafe filename ids without echoing them', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-unsafe-session-'));
		const unsafeId = 'agent_bad-private-session';
		try {
			writeExplainSession(
				join(home, '.claude', 'projects', '-private-project'),
				unsafeId,
				'unsafe-session-agent',
				new Date(Date.now() - 60_000).toISOString(),
			);

			for (const args of [
				['month', '--by', 'session'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('cannot be labeled safely for explain');
				expect(result.stderr).not.toContain(unsafeId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('UnsupportedSessionIdError');
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('anonymized session reports hide local read failures in text and JSON modes', () => {
		withExplainFixture((home, sessionPath) => {
			chmodSync(sessionPath, 0o000);
			try {
				for (const args of [
					['month', '--by', 'session', '--anonymize'],
					['month', '--by', 'session', '--json', '--anonymize'],
				]) {
					const result = runCli(args, { HOME: home });
					expect(result.exitCode).toBe(1);
					expect(result.stdout).toBe('');
					expect(result.stderr).toContain('unable to inspect local session logs');
					expect(result.stderr).not.toContain(explainSessionId);
					expect(result.stderr).not.toContain(home);
					expect(result.stderr).not.toContain('EACCES');
					expect(result.stderr).not.toContain('error:');
				}
			} finally {
				chmodSync(sessionPath, 0o600);
			}
		});
	});

	test('anonymized read failure does not echo paths or session identifiers', () => {
		withExplainFixture((home, sessionPath) => {
			chmodSync(sessionPath, 0o000);
			try {
				const sessionPrefix = 'private-session';
				const result = runCli(['explain', '--anonymize', sessionPrefix], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('unable to inspect local sessions');
				expect(result.stderr).not.toContain(sessionPrefix);
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('EACCES');
			} finally {
				chmodSync(sessionPath, 0o600);
			}
		});
	});

	test('missing projects directory is a privacy-safe no-match', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-empty-home-'));
		try {
			const missingId = 'missing-private-session';
			const result = runCli(['explain', missingId, '--anonymize'], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('no session found matching the supplied ID');
			expect(result.stderr).not.toContain(missingId);
			expect(result.stderr).not.toContain(home);
			expect(result.stderr).not.toContain('ENOENT');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('missing session identifier is a usage error', () => {
		const result = runCli(['explain', '--anonymize']);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('missing sessionId argument');
	});

	test('unknown explain flags are rejected', () => {
		const unknownFlag = '--private-secret-flag';
		const result = runCli(['explain', explainSessionId, unknownFlag]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('unsupported flag');
		expect(result.stderr).not.toContain(unknownFlag);
	});

	test('extra explain positional arguments are rejected without echoing them', () => {
		const extra = 'second-private-session';
		const result = runCli(['explain', explainSessionId, extra]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('expected exactly one sessionId argument');
		expect(result.stderr).not.toContain(extra);
	});

	test('glob metacharacters are rejected without being echoed', () => {
		const unsafePrefix = 'private-*';
		const result = runCli(['explain', '--anonymize', unsafePrefix]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('letters, numbers, and hyphens');
		expect(result.stderr).not.toContain(unsafePrefix);
	});

	for (const flag of ['--help', '-h']) {
		test(`explain ${flag} exits successfully`, () => {
			const result = runCli(['explain', flag]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('explain <sessionId> [--anonymize]');
			expect(result.stderr).toBe('');
		});
	}

	for (const args of [
		['explain', '--help', '--private-secret-flag'],
		['explain', explainSessionId, 'extra-private-session', '--help'],
	]) {
		test(`${args.slice(1).join(' ')} does not bypass argument validation`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Usage:');
			expect(result.stderr).not.toContain('--private-secret-flag');
			expect(result.stderr).not.toContain('extra-private-session');
		});
	}
});

describe('tree accounting', () => {
	test('budget and grand total include roots omitted from the top-20 display', () => {
		withRootSessions(21, (home) => {
			const env = { HOME: home, USERPROFILE: home };
			const result = runCli(['week', '--tree', '--json', '--budget', '61'], env);
			const report = JSON.parse(result.stdout) as {
				roots: unknown[];
				totalCost: number;
			};

			expect(result.exitCode).toBe(2);
			expect(report.roots).toHaveLength(20);
			expect(report.totalCost).toBeCloseTo(63, 6);
			expect(result.stderr).toContain('total $63.00 > budget $61.00');

			const equalBudget = runCli(['week', '--tree', '--json', '--budget', '63'], env);
			expect(equalBudget.exitCode).toBe(0);
			expect(JSON.parse(equalBudget.stdout).totalCost).toBeCloseTo(63, 6);
		});
	});
});

describe('watch interval validation', () => {
	test('rejects invalid or overflowing explicit intervals before scanning', async () => {
		const invalidArgs = [
			['watch', ' '],
			['watch', ' 4'],
			['watch', '4 '],
			['watch', 'Infinity'],
			['watch', 'NaN'],
			['watch', '1e309'],
			['watch', '1e3'],
			['watch', '+4'],
			['watch', '0x10'],
			['watch', 'garbage'],
			['watch', '٤'],
			['watch', '0'],
			['watch', '1'],
			['watch', '-1'],
			['watch', '1.5'],
			['watch', '2147483.648'],
			['watch', '2147484'],
			['watch', '9007199254740992'],
			['watch', '--json'],
			['watch', '2', 'extra-private-value'],
		];
		const expectedError =
			'agent-ledger watch: interval must be a decimal integer from 2 to 2147483 seconds\n' +
			'Usage: agent-ledger watch [seconds]\n';

		for (const args of invalidArgs) {
			const result = await runCliWithDeadline(args);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toBe(expectedError);
		}
	});

	for (const [label, args, expectedInterval] of [
		['the default', ['watch'], 10],
		['the minimum', ['watch', '2'], 2],
		['the documented example', ['watch', '4'], 4],
		['a leading-zero decimal', ['watch', '0002'], 2],
		['the timer-safe maximum', ['watch', '2147483'], 2_147_483],
	] as const) {
		test(`accepts ${label} interval`, async () => {
			const result = await runCliWithDeadline([...args], 750);
			expect(result.timedOut).toBe(true);
			expect(result.stdout).toContain(`refreshing every ${expectedInterval}s`);
			expect(result.stdout).toContain('today $0.00');
			expect(result.stderr).toBe('');
		});
	}

	test('documents the watch subcommand in help output', () => {
		const result = runCli(['--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'agent-ledger watch [seconds]                — refresh today\'s cost (2..2147483 seconds; default: 10)',
		);
		expect(result.stderr).toBe('');
	});
});

describe('forecast CLI', () => {

	test('escapes unknown-model terminal controls while keeping the JSON value intact', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-control-label-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const model = 'unknown\u001b[2J\nlabel\t\u007f\u0085\u2028\u2029';
			const visibleModel = String.raw`unknown\u001b[2J\u000alabel\u0009\u007f\u0085\u2028\u2029`;
			writeFileSync(join(project, 'model.jsonl'), JSON.stringify({
				type: 'assistant',
				timestamp: new Date(Date.now() - 36 * 3_600_000).toISOString(),
				message: { model, usage: { input_tokens: 1, output_tokens: 0 } },
			}) + '\n');
			const text = runCli(['forecast'], { HOME: home, TZ: 'UTC' });
			expect(text.exitCode).toBe(0);
			for (const output of [text.stdout, text.stderr]) {
				expect(output).toContain(visibleModel);
				expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
				expect(output).not.toContain(model);
			}
			const json = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(json.exitCode).toBe(0);
			expect(JSON.parse(json.stdout).pricing.unpricedModels).toEqual([model]);
			expect(json.stderr).toContain(visibleModel);
			expect(json.stderr).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('does not echo private argument values in forecast errors', () => {
		const marker = 'synthetic-private-value-7ef9';
		for (const args of [['forecast', '--plan', marker], ['forecast', `--${marker}`]]) {
			const result = runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).not.toContain(marker);
		}
	});

	test('emits a pure JSON no-activity report from a readable empty source', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-empty-home-'));
		try {
			mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
			const result = runCli(['forecast', '--json', '--plan', 'max'], {
				HOME: home,
				TZ: 'UTC',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe('');
			const report = JSON.parse(result.stdout);
				expect(report).toMatchObject({
				schemaVersion: 1,
				command: 'forecast',
				metric: 'shadow_cost_usd',
				timeZone: 'UTC',
				plan: 'max',
				amountsAreLowerBounds: false,
				basis: {
					calendarDays: 7,
					daysWithActivity: 0,
					assistantTurns: 0,
					dataStatus: 'no-activity',
					shadowCostUsd: 0,
				},
				forecast: {
					calendarDays: 7,
					projectedShadowCostUsd: 0,
				},
				pricing: { status: 'complete' },
				records: { status: 'no-issues-detected' },
			});
			expect(report.basis.daily).toHaveLength(7);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('keeps JSON stdout clean and warns once for an unknown model', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-unknown-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			const unknownTurn = (model: string) =>
				JSON.stringify({
					type: 'assistant',
					timestamp,
					message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
				});
			writeFileSync(
				join(project, 'forecast-session.jsonl'),
				[
					unknownTurn('claude-future-z'),
					unknownTurn('claude-future-a'),
					unknownTurn('claude-future-z'),
				].join('\n') + '\n',
			);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.basis.dataStatus).toBe('ok');
			expect(report.basis.daysWithActivity).toBe(1);
			expect(report.pricing.unpricedModels).toEqual(['claude-future-a', 'claude-future-z']);
			expect(report.pricing.unpricedAssistantTurns).toBe(3);
			expect(report.amountsAreLowerBounds).toBe(true);
			expect(result.stderr.match(/incomplete cost coverage/g)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails instead of presenting a missing data source as a zero forecast', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-missing-home-'));
		try {
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Claude projects directory is not readable');
			expect(result.stderr).not.toContain(home);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails when the projects root is readable but not traversable', () => {
		if (process.getuid?.() === 0) return;
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-mode-home-'));
		const projects = join(home, '.claude', 'projects');
		try {
			mkdirSync(projects, { recursive: true });
			chmodSync(projects, 0o400);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Claude projects directory is not readable');
			expect(result.stderr).not.toContain(home);
		} finally {
			chmodSync(projects, 0o700);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails closed when a nested source directory cannot be traversed', () => {
		if (process.getuid?.() === 0) return;
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-nested-mode-home-'));
		const project = join(home, '.claude', 'projects', 'forecast-project');
		try {
			mkdirSync(project, { recursive: true });
			chmodSync(project, 0o400);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('failed to read Claude projects source');
		} finally {
			chmodSync(project, 0o700);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails closed on a nested symbolic link', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-symlink-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			symlinkSync(project, join(project, 'loop'));
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('symbolic link is not allowed');
			expect(result.stderr).not.toContain(home);
			expect(result.stderr).not.toContain(project);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('reports malformed, missing-timestamp, and invalid-usage records separately', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-damaged-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			writeFileSync(
				join(project, 'damaged.jsonl'),
				[
					JSON.stringify({
						type: 'assistant',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1_000_000, output_tokens: 0 },
						},
					}),
					JSON.stringify({
						type: 'assistant',
						timestamp: '2026-02-30T12:00:00Z',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}),
					JSON.stringify({
						type: 'assistant',
						timestamp: '0',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}),
					'{malformed-json',
					JSON.stringify({
						type: 'assistant',
						timestamp,
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1 },
						},
					}),
				].join('\n') + '\n',
			);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.amountsAreLowerBounds).toBe(true);
			expect(report.pricing.status).toBe('complete');
			expect(report.records).toEqual({
				status: 'issues-detected',
				malformedJsonLines: 1,
				invalidTimestampTurns: 3,
				invalidUsageTurns: 1,
			});
			expect(report.basis).toMatchObject({
				dataStatus: 'ok',
				assistantTurns: 1,
				daysWithActivity: 1,
				shadowCostUsd: 0,
			});
			expect(result.stderr.match(/incomplete cost coverage/g)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('renders default text and keeps verbose JSON machine-readable', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-text-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			writeFileSync(
				join(project, 'known.jsonl'),
				JSON.stringify({
					type: 'assistant',
					timestamp,
					message: {
						model: 'claude-sonnet-4-6',
						usage: { input_tokens: 1_000_000, output_tokens: 0 },
					},
				}) + '\n',
			);
			const textResult = runCli(['forecast', '--plan', 'pro'], { HOME: home, TZ: 'UTC' });
			expect(textResult.exitCode).toBe(0);
			expect(textResult.stderr).toBe('');
			expect(textResult.stdout).toContain('agent-ledger forecast');
			expect(textResult.stdout).toContain('pro · shadow-cost equivalent only');

			const jsonResult = runCli(['forecast', '--json', '--plan', 'pro', '--verbose'], {
				HOME: home,
				TZ: 'UTC',
			});
			expect(jsonResult.exitCode).toBe(0);
			expect(JSON.parse(jsonResult.stdout).plan).toBe('pro');
			expect(jsonResult.stderr).toMatch(/parsed 1 candidate turns in \d+ms/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	for (const args of [
		['forecast', '--md'],
		['forecast', '--summary'],
		['forecast', 'extra'],
		['forecast', '--plan'],
		['forecast', '--plan', 'payg'],
	]) {
		test(`${args.join(' ')} is rejected`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('agent-ledger forecast:');
		});
	}
});
