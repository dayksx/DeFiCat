export type IsoZoneFormatter = (isoUtc: string) => string;

/**
 * Rewrites an ISO 8601 UTC instant as the same instant in `timeZone`, keeping
 * the offset (`2026-06-13T03:52:19+02:00`) so nothing downstream has to do
 * date arithmetic to know which wall clock the timestamp refers to.
 *
 * The formatter is built eagerly: an unknown time zone throws at startup
 * rather than in the middle of a conversation.
 */
export function createIsoZoneFormatter(timeZone: string): IsoZoneFormatter {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (isoUtc) => {
    const instant = new Date(isoUtc);
    if (Number.isNaN(instant.getTime())) return isoUtc;

    const wall = readWallClock(formatter, instant);
    const asIfUtc = Date.UTC(
      wall.year,
      wall.month - 1,
      wall.day,
      wall.hour,
      wall.minute,
      wall.second,
    );
    const offsetMinutes = Math.round((asIfUtc - instant.getTime()) / 60_000);

    return (
      `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` +
      `T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}` +
      formatOffset(offsetMinutes)
    );
  };
}

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function readWallClock(
  formatter: Intl.DateTimeFormat,
  instant: Date,
): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts as unknown as WallClock;
}

function formatOffset(minutes: number): string {
  if (minutes === 0) return "Z";
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}
