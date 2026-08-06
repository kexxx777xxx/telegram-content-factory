/**
 * One place that turns an instant into text.
 *
 * Two different zones are legitimately in play: a slot means nine in the
 * morning *where the channel's audience lives*, while a job retry means nine in
 * the morning *where the operator is sitting*. Rendering both without saying
 * which was which is what made the clock look broken — the same moment appeared
 * as two different times on one screen.
 *
 * So the zone is never implicit here. Project-scoped times pass the project's
 * timezone; operational ones use the browser's, and both can be labelled.
 */

const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface TimeOptions {
  /** IANA zone. Omitted means the browser's — the operator's own clock. */
  timezone?: string;
  /** Appends the zone when it is not obvious from context. */
  withZone?: boolean;
  /** Drops the date part for times that are obviously today. */
  timeOnly?: boolean;
}

export function formatDateTime(iso: string | Date, options: TimeOptions = {}): string {
  const zone = options.timezone ?? BROWSER_ZONE;
  const date = typeof iso === 'string' ? new Date(iso) : iso;

  const text = date.toLocaleString('uk-UA', {
    timeZone: zone,
    ...(options.timeOnly ? {} : { day: '2-digit', month: '2-digit' }),
    hour: '2-digit',
    minute: '2-digit',
  });

  return options.withZone ? `${text} (${shortZone(zone, date)})` : text;
}

/** Just the clock, in the operator's own zone — for queue and quota windows. */
export function formatLocalTime(iso: string | Date): string {
  return formatDateTime(iso, { timeOnly: true, withZone: true });
}

/**
 * `EET`/`GMT+3` rather than `Europe/Kyiv`: the point is to disambiguate two
 * numbers on one screen, and the long name crowds out the number itself.
 */
function shortZone(zone: string, date: Date): string {
  const part = new Intl.DateTimeFormat('uk-UA', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(date)
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}

/** True when the project's clock differs from the operator's right now. */
export function zoneDiffers(timezone: string): boolean {
  return timezone !== BROWSER_ZONE;
}
