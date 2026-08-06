/**
 * One place that turns an instant into text.
 *
 * Two different zones are legitimately in play: a slot means nine in the
 * morning *where the channel's audience lives*, while a job retry means nine in
 * the morning *where the operator is sitting*. So the zone is never implicit
 * here — project-scoped times pass the project's timezone, operational ones use
 * the browser's.
 *
 * What the zone is is stated **once per screen**, not once per timestamp. A
 * `(GMT+3)` glued to every clock in a table was three quarters noise: the same
 * answer repeated forty times, crowding out the numbers it qualified.
 */

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface TimeOptions {
  /** IANA zone. Omitted means the browser's — the operator's own clock. */
  timezone?: string;
  /** Drops the date part for times that are obviously today. */
  timeOnly?: boolean;
}

export function formatDateTime(iso: string | Date, options: TimeOptions = {}): string {
  const zone = options.timezone ?? BROWSER_ZONE;
  const date = typeof iso === 'string' ? new Date(iso) : iso;

  return date.toLocaleString('uk-UA', {
    timeZone: zone,
    ...(options.timeOnly ? {} : { day: '2-digit', month: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Just the clock, in the operator's own zone — for queue and quota windows. */
export function formatLocalTime(iso: string | Date): string {
  return formatDateTime(iso, { timeOnly: true });
}

/**
 * `Europe/Kyiv · GMT+3` — the caption that makes every bare timestamp on a
 * screen readable. Shown once, in the header or beside a title.
 *
 * `GMT+3` rather than the long zone name: it is the part that actually
 * disambiguates, and it survives DST because it is computed from a real date.
 */
export function zoneLabel(timezone: string = BROWSER_ZONE, at: Date = new Date()): string {
  return `${timezone} · ${shortZone(timezone, at)}`;
}

export function browserZone(): string {
  return BROWSER_ZONE;
}

function shortZone(zone: string, date: Date): string {
  const part = new Intl.DateTimeFormat('uk-UA', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}

/**
 * True when the project's clock actually differs from the operator's.
 *
 * Compared by the time they show, not by name: `Europe/Kyiv` and `Europe/Kiev`
 * are the same zone under two spellings, and a browser reporting the alias made
 * every project look like it lived somewhere else — announcing a difference of
 * zero minutes on every page.
 */
export function zoneDiffers(timezone: string, at: Date = new Date()): boolean {
  if (timezone === BROWSER_ZONE) return false;
  try {
    return offsetMinutes(timezone, at) !== offsetMinutes(BROWSER_ZONE, at);
  } catch {
    return true;
  }
}

/** Minutes the zone is ahead of UTC at that instant, DST included. */
function offsetMinutes(zone: string, at: Date): number {
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  const asZone = new Date(at.toLocaleString('en-US', { timeZone: zone }));
  return Math.round((asZone.getTime() - asUtc.getTime()) / 60_000);
}
