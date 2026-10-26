/**
 * Parse schedule times with an optional timezone.
 * Default timezone: Asia/Calcutta (IST, UTC+5:30).
 * Accepts: "2026-10-27 20:00 IST", "2026-10-27T20:00:00+05:30", ISO strings.
 */

const ZONE_OFFSETS: Record<string, number> = {
  IST: 330,
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  JST: 540,
  CET: 60,
  CEST: 120,
};

export function resolveTimezoneOffsetMinutes(
  zone: string,
  defaultTimezone: string
): { offsetMinutes: number; timezone: string } {
  const upper = zone.trim().toUpperCase();
  if (upper in ZONE_OFFSETS) {
    return { offsetMinutes: ZONE_OFFSETS[upper], timezone: upper };
  }
  if (zone === "Asia/Calcutta" || zone === "Asia/Kolkata" || defaultTimezone === zone) {
    return { offsetMinutes: 330, timezone: zone };
  }
  // IANA names we special-case for offline use without Intl dependency surprises
  const iana: Record<string, number> = {
    "Asia/Calcutta": 330,
    "Asia/Kolkata": 330,
    "America/New_York": -300,
    "America/Los_Angeles": -480,
    "Europe/London": 0,
    "Etc/UTC": 0,
  };
  if (zone in iana) {
    return { offsetMinutes: iana[zone], timezone: zone };
  }
  if (defaultTimezone in iana) {
    return { offsetMinutes: iana[defaultTimezone], timezone: defaultTimezone };
  }
  return { offsetMinutes: 330, timezone: "Asia/Calcutta" };
}

export function parseScheduleAt(
  input: string,
  defaultTimezone: string
): { atIso: string; timezone: string; atMs: number } {
  const trimmed = input.trim();

  // Explicit ISO with offset or Z
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && /([zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid schedule time: ${input}`);
    }
    return { atIso: new Date(ms).toISOString(), timezone: "explicit-offset", atMs: ms };
  }

  // "YYYY-MM-DD HH:mm ZONE" or "YYYY-MM-DD HH:mm"
  const match = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s+([A-Za-z/_+0-9:-]+))?$/
  );
  if (!match) {
    throw new Error(
      `Could not parse schedule time "${input}". Try: "2026-10-27 20:00 IST" or an ISO-8601 timestamp.`
    );
  }

  const [, y, mo, d, h, mi, s, zoneRaw] = match;
  const zone = zoneRaw ?? defaultTimezone;
  const { offsetMinutes, timezone } = resolveTimezoneOffsetMinutes(zone, defaultTimezone);

  const utcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? "0")
  );
  // Local wall time in zone = UTC + offset, so UTC = wall - offset
  const atMs = utcMs - offsetMinutes * 60_000;
  return { atIso: new Date(atMs).toISOString(), timezone, atMs };
}

export function formatInTimezone(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  const { offsetMinutes } = resolveTimezoneOffsetMinutes(timezone, timezone);
  const local = new Date(ms + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} ${timezone}`;
}
