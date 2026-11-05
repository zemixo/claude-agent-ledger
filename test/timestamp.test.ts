import { describe, expect, test } from 'bun:test';
import { parseRfc3339Timestamp } from '../src/timestamp.ts';

describe('parseRfc3339Timestamp()', () => {
	test('accepts UTC and explicit-offset timestamps without losing the instant', () => {
		expect(parseRfc3339Timestamp('2026-08-03T12:34:56Z')?.toISOString()).toBe(
			'2026-08-03T12:34:56.000Z',
		);
		expect(parseRfc3339Timestamp('2026-08-03t12:34:56z')?.toISOString()).toBe(
			'2026-08-03T12:34:56.000Z',
		);
		expect(parseRfc3339Timestamp('2026-08-03T20:34:56.123456+08:00')?.toISOString()).toBe(
			'2026-08-03T12:34:56.123Z',
		);
		expect(parseRfc3339Timestamp('2024-02-29T00:00:00-05:30')?.toISOString()).toBe(
			'2024-02-29T05:30:00.000Z',
		);
	});

	test('rejects normalized calendar dates and JavaScript date-parser shortcuts', () => {
		for (const timestamp of [
			'2026-02-30T12:00:00Z',
			'2025-02-29T12:00:00Z',
			'2026-01-01T24:00:00Z',
			'2026-01-01T00:00:00+24:00',
			'2026-01-01T00:00:00',
			'0',
			'',
		]) {
			expect(parseRfc3339Timestamp(timestamp)).toBeUndefined();
		}
	});
});
