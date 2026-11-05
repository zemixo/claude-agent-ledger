const RFC3339_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

/** Parse an RFC3339 timestamp without JavaScript Date's normalization quirks. */
export function parseRfc3339Timestamp(value: unknown): Date | undefined {
	if (typeof value !== 'string') return undefined;
	const match = RFC3339_TIMESTAMP.exec(value);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const fraction = match[7] ?? '';
	const zone = match[8];
	const offsetSign = match[9];
	const offsetHour = Number(match[10] ?? 0);
	const offsetMinute = Number(match[11] ?? 0);
	const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3));

	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		offsetHour > 23 ||
		offsetMinute > 59
	) {
		return undefined;
	}

	// Date.UTC treats years 0-99 as 1900-1999, so set the full year explicitly.
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month - 1, day);
	calendar.setUTCHours(hour, minute, second, millisecond);
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day ||
		calendar.getUTCHours() !== hour ||
		calendar.getUTCMinutes() !== minute ||
		calendar.getUTCSeconds() !== second
	) {
		return undefined;
	}

	const signedOffsetMinutes =
		zone?.toUpperCase() === 'Z'
			? 0
			: (offsetSign === '+' ? 1 : -1) * (offsetHour * 60 + offsetMinute);
	const instant = new Date(calendar.getTime() - signedOffsetMinutes * 60_000);
	return Number.isFinite(instant.getTime()) ? instant : undefined;
}
