import { parseRfc3339Timestamp } from './timestamp.ts';
import type { TokenUsage } from './types.ts';

export const LOG_CONTRACT_VERSION = 1;

export const LOG_SHAPE_IDS = {
	assistantUsage: 'claude-code.assistant-usage/v1',
	contextEvent: 'claude-code.context-event/v1',
	auxiliaryEvent: 'claude-code.auxiliary-event/v1',
	subagentMeta: 'claude-code.subagent-meta/v1',
} as const;

export type LogShapeId = (typeof LOG_SHAPE_IDS)[keyof typeof LOG_SHAPE_IDS];

export const CONTEXT_RECORD_TYPES = ['user', 'system', 'summary'] as const;
export const AUXILIARY_RECORD_TYPES = [
	'attachment',
	'queue-operation',
	'last-prompt',
	'mode',
	'file-history-snapshot',
	'permission-mode',
	'ai-title',
] as const;

export type ParseDiagnosticCode =
	| 'malformed-json'
	| 'unsupported-json-root'
	| 'unsupported-record-type'
	| 'unexpected-usage-on-nonbillable-record'
	| 'unexpected-assistant-usage-location'
	| 'invalid-assistant-timestamp'
	| 'invalid-assistant-message'
	| 'invalid-assistant-model'
	| 'invalid-assistant-usage'
	| 'invalid-subagent-meta';

export interface ParseDiagnostic {
	code: ParseDiagnosticCode;
	expectedShape: LogShapeId;
	source: string;
	line?: number;
	reason: string;
}

export interface ParseDiagnostics {
	malformedJsonLines: number;
	unsupportedRecordLines: number;
	invalidTimestampLines: number;
	invalidUsageLines: number;
	invalidSubagentMetaFiles: number;
	ignoredSourceRecordLines: number;
	forwardedInvalidTimestampLines: number;
	forwardedInvalidUsageLines: number;
	samples: ParseDiagnostic[];
}

export const MAX_PARSE_DIAGNOSTIC_SAMPLES = 5;
const SAFE_DIAGNOSTIC_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function createParseDiagnostics(): ParseDiagnostics {
	return {
		malformedJsonLines: 0,
		unsupportedRecordLines: 0,
		invalidTimestampLines: 0,
		invalidUsageLines: 0,
		invalidSubagentMetaFiles: 0,
		ignoredSourceRecordLines: 0,
		forwardedInvalidTimestampLines: 0,
		forwardedInvalidUsageLines: 0,
		samples: [],
	};
}

export type LogRecordClassification =
	| {
			status: 'accepted';
			shapeId: typeof LOG_SHAPE_IDS.assistantUsage;
			message: Record<string, unknown>;
			usage: TokenUsage;
			model?: string;
	  }
	| {
			status: 'ignored';
			shapeId:
				| typeof LOG_SHAPE_IDS.contextEvent
				| typeof LOG_SHAPE_IDS.auxiliaryEvent;
	  }
	| {
			status: 'invalid';
			code: Exclude<
				ParseDiagnosticCode,
				'malformed-json' | 'unsupported-json-root' | 'invalid-subagent-meta'
			>;
			expectedShape: LogShapeId;
			reason: string;
	  };

const contextTypes = new Set<string>(CONTEXT_RECORD_TYPES);
const auxiliaryTypes = new Set<string>(AUXILIARY_RECORD_TYPES);
const usageKeys = new Set([
	'input_tokens',
	'output_tokens',
	'cache_creation_input_tokens',
	'cache_read_input_tokens',
	'cache_creation',
	'server_tool_use',
	'service_tier',
	'inference_geo',
	'speed',
	'iterations',
]);
const cacheCreationKeys = new Set([
	'ephemeral_5m_input_tokens',
	'ephemeral_1h_input_tokens',
]);
const serverToolUseKeys = new Set(['web_search_requests', 'web_fetch_requests']);

function recordObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function optionalNonNegativeSafeInteger(value: unknown): boolean {
	return value === undefined || nonNegativeSafeInteger(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function optionalStringOrNull(value: unknown): boolean {
	return value === undefined || value === null || typeof value === 'string';
}

function optionalArrayOrNull(value: unknown): boolean {
	return value === undefined || value === null || Array.isArray(value);
}

function hasOwnUsage(value: Record<string, unknown>): boolean {
	return Object.hasOwn(value, 'usage');
}

function messageHasOwnUsage(record: Record<string, unknown>): boolean {
	const message = recordObject(record.message);
	return Boolean(message && hasOwnUsage(message));
}

export function isSupportedUsage(value: unknown, requireCacheAgreement = false): value is TokenUsage {
	const usage = recordObject(value);
	if (!usage) return false;
	if (!hasOnlyKeys(usage, usageKeys)) return false;
	if (!nonNegativeSafeInteger(usage.input_tokens)) return false;
	if (!nonNegativeSafeInteger(usage.output_tokens)) return false;
	if (!optionalNonNegativeSafeInteger(usage.cache_creation_input_tokens)) return false;
	if (!optionalNonNegativeSafeInteger(usage.cache_read_input_tokens)) return false;
	if (!optionalStringOrNull(usage.service_tier)) return false;
	if (!optionalStringOrNull(usage.inference_geo)) return false;
	if (!optionalStringOrNull(usage.speed)) return false;
	if (!optionalArrayOrNull(usage.iterations)) return false;

	if (usage.cache_creation !== undefined) {
		const cache = recordObject(usage.cache_creation);
		if (!cache) return false;
		if (!hasOnlyKeys(cache, cacheCreationKeys)) return false;
		if (
			cache.ephemeral_5m_input_tokens === undefined &&
			cache.ephemeral_1h_input_tokens === undefined
		) {
			return false;
		}
		if (!optionalNonNegativeSafeInteger(cache.ephemeral_5m_input_tokens)) return false;
		if (!optionalNonNegativeSafeInteger(cache.ephemeral_1h_input_tokens)) return false;
		const fiveMinute =
			typeof cache.ephemeral_5m_input_tokens === 'number'
				? cache.ephemeral_5m_input_tokens
				: 0;
		const oneHour =
			typeof cache.ephemeral_1h_input_tokens === 'number'
				? cache.ephemeral_1h_input_tokens
				: 0;
		if (!Number.isSafeInteger(fiveMinute + oneHour)) return false;
		if (requireCacheAgreement && usage.cache_creation_input_tokens !== undefined &&
			usage.cache_creation_input_tokens !== fiveMinute + oneHour) return false;
	}

	if (usage.server_tool_use !== undefined) {
		const tools = recordObject(usage.server_tool_use);
		if (!tools) return false;
		if (!hasOnlyKeys(tools, serverToolUseKeys)) return false;
		if (tools.web_search_requests === undefined && tools.web_fetch_requests === undefined) {
			return false;
		}
		if (!optionalNonNegativeSafeInteger(tools.web_search_requests)) return false;
		if (!optionalNonNegativeSafeInteger(tools.web_fetch_requests)) return false;
	}

	return true;
}

// Validation observes the whole shape; consumers retain only numeric cost counters.
export function projectUsage(usage: TokenUsage): TokenUsage {
	return {
		input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
		...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
		...(usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {}),
		...(usage.cache_creation ? { cache_creation: { ...usage.cache_creation } } : {}),
		...(usage.server_tool_use ? { server_tool_use: { ...usage.server_tool_use } } : {}),
	};
}

export function classifyLogRecord(
	record: Record<string, unknown>,
	options: { strictTimestamps?: boolean; allowPartialUsage?: boolean; requireCacheAgreement?: boolean } = {},
): LogRecordClassification {
	const envelopeMessage = recordObject(record.message);
	const recordType = record.type ?? envelopeMessage?.role;
	if (contextTypes.has(recordType as string)) {
		if (hasOwnUsage(record) || messageHasOwnUsage(record)) {
			return {
				status: 'invalid',
				code: 'unexpected-usage-on-nonbillable-record',
				expectedShape: LOG_SHAPE_IDS.contextEvent,
				reason: 'known non-billable context records must not carry usage',
			};
		}
		return { status: 'ignored', shapeId: LOG_SHAPE_IDS.contextEvent };
	}
	if (auxiliaryTypes.has(recordType as string)) {
		if (hasOwnUsage(record) || messageHasOwnUsage(record)) {
			return {
				status: 'invalid',
				code: 'unexpected-usage-on-nonbillable-record',
				expectedShape: LOG_SHAPE_IDS.auxiliaryEvent,
				reason: 'known non-billable auxiliary records must not carry usage',
			};
		}
		return { status: 'ignored', shapeId: LOG_SHAPE_IDS.auxiliaryEvent };
	}
	if (recordType !== 'assistant') {
		return {
			status: 'invalid',
				code: 'unsupported-record-type',
				expectedShape: LOG_SHAPE_IDS.assistantUsage,
				reason: 'record type is not in log contract v1',
			};
	}
	if (hasOwnUsage(record)) {
		return {
			status: 'invalid',
			code: 'unexpected-assistant-usage-location',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			reason: 'assistant usage must appear only at message.usage',
		};
	}
	if (options.strictTimestamps === false
		? typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))
		: !parseRfc3339Timestamp(record.timestamp)) {
		return {
			status: 'invalid',
			code: 'invalid-assistant-timestamp',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			reason: options.strictTimestamps === false ? 'assistant timestamp must be a valid date' : 'assistant timestamp must be RFC 3339',
		};
	}
	const message = recordObject(record.message);
	if (!message) {
		return {
			status: 'invalid',
			code: 'invalid-assistant-message',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			reason: 'assistant message must be an object',
		};
	}
	if (typeof message.model !== 'string' || message.model.length === 0) {
		return {
			status: 'invalid',
			code: 'invalid-assistant-model',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			reason: 'assistant model must be a non-empty string',
		};
	}
	const rawUsage = recordObject(message.usage);
	const usage = options.allowPartialUsage && rawUsage
		? { ...rawUsage, input_tokens: rawUsage.input_tokens === undefined ? 0 : rawUsage.input_tokens, output_tokens: rawUsage.output_tokens === undefined ? 0 : rawUsage.output_tokens }
		: message.usage;
	if (!isSupportedUsage(usage, options.requireCacheAgreement ?? false)) {
		return {
			status: 'invalid',
			code: 'invalid-assistant-usage',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			reason: 'usage must match the v1 field allowlist and counter types',
		};
	}
	return {
		status: 'accepted',
		shapeId: LOG_SHAPE_IDS.assistantUsage,
		message,
		usage: projectUsage(usage),
		model: message.model as string | undefined,
	};
}

export function isSupportedSubagentMeta(value: unknown): value is { agentType: string } {
	const meta = recordObject(value);
	return Boolean(meta && typeof meta.agentType === 'string' && meta.agentType.length > 0);
}

export function addParseDiagnostic(
	diagnostics: ParseDiagnostics | undefined,
	diagnostic: ParseDiagnostic,
): void {
	if (!diagnostics) return;
	if (diagnostic.code === 'malformed-json') diagnostics.malformedJsonLines++;
	else if (diagnostic.code === 'invalid-assistant-timestamp') diagnostics.invalidTimestampLines++;
	else if (
			diagnostic.code === 'invalid-assistant-message' ||
			diagnostic.code === 'invalid-assistant-model' ||
			diagnostic.code === 'invalid-assistant-usage' ||
			diagnostic.code === 'unexpected-assistant-usage-location'
	) {
		diagnostics.invalidUsageLines++;
	} else if (diagnostic.code === 'invalid-subagent-meta') {
		diagnostics.invalidSubagentMetaFiles++;
	} else {
		diagnostics.unsupportedRecordLines++;
	}
	if (diagnostics.samples.length < MAX_PARSE_DIAGNOSTIC_SAMPLES) {
		diagnostics.samples.push({
			...diagnostic,
			source: SAFE_DIAGNOSTIC_SOURCE.test(diagnostic.source)
				? diagnostic.source
				: 'session-log',
		});
	}
}

export function hasParseCoverageGaps(diagnostics: ParseDiagnostics): boolean {
	return (
		diagnostics.malformedJsonLines > 0 ||
		diagnostics.unsupportedRecordLines > 0 ||
		diagnostics.invalidTimestampLines > 0 ||
		diagnostics.invalidUsageLines > 0
	);
}

export function parseDiagnosticCounts(diagnostics: ParseDiagnostics): string[] {
	const parts: string[] = [];
	if (diagnostics.malformedJsonLines > 0) {
		parts.push(`${diagnostics.malformedJsonLines} malformed JSON line(s)`);
	}
	if (diagnostics.unsupportedRecordLines > 0) {
		parts.push(`${diagnostics.unsupportedRecordLines} unsupported record line(s)`);
	}
	if (diagnostics.invalidTimestampLines > 0) {
		parts.push(`${diagnostics.invalidTimestampLines} invalid-timestamp assistant line(s)`);
	}
	if (diagnostics.invalidUsageLines > 0) {
		parts.push(`${diagnostics.invalidUsageLines} invalid-usage assistant line(s)`);
	}
	if (diagnostics.invalidSubagentMetaFiles > 0) {
		parts.push(`${diagnostics.invalidSubagentMetaFiles} invalid subagent metadata file(s)`);
	}
	return parts;
}

export function formatParseDiagnosticSamples(
	diagnostics: ParseDiagnostics,
	anonymize = false,
): string[] {
	return diagnostics.samples.map((sample) => {
		const source = anonymize ? 'session-log' : sample.source;
		const location = sample.line === undefined ? source : `${source}:${sample.line}`;
		return `${sample.code} at ${location}; expected ${sample.expectedShape} (${sample.reason})`;
	});
}
