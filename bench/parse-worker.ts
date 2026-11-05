import { createParseDiagnostics } from '../src/log-contract.ts';
import { parseAll } from '../src/parser.ts';
import type { WorkerResult } from './lib.ts';

function diagnosticLineCount(diagnostics: ReturnType<typeof createParseDiagnostics>): number {
	return (
		diagnostics.malformedJsonLines +
		diagnostics.unsupportedRecordLines +
		diagnostics.invalidTimestampLines +
		diagnostics.invalidUsageLines +
		diagnostics.invalidSubagentMetaFiles
	);
}

async function main(): Promise<void> {
	const args = Bun.argv.slice(2);
	if (args.length !== 2 || args[0] !== '--projects-dir' || !args[1]) {
		console.error('benchmark worker requires exactly one synthetic projects directory');
		process.exitCode = 2;
		return;
	}

	try {
		const diagnostics = createParseDiagnostics();
		let acceptedRecords = 0;
		const startedAt = performance.now();
		for await (const _turn of parseAll({
			projectsDir: args[1],
			strictSource: true,
			diagnostics,
		})) {
			acceptedRecords++;
		}
		const parseWallMs = performance.now() - startedAt;
		const result: WorkerResult = {
			schemaVersion: 1,
			acceptedRecords,
			ignoredRecords: diagnostics.ignoredSourceRecordLines,
			diagnosticLines: diagnosticLineCount(diagnostics),
			parseWallMs,
		};
		console.log(JSON.stringify(result));
	} catch {
		console.error('benchmark worker could not parse the synthetic corpus');
		process.exitCode = 1;
	}
}

await main();
