/**
 * Refuses to run against anything but a test database.
 *
 * The suites truncate tables between cases. If a worker ever resolved the
 * development URL — a missed env var, a stale export — the first test would
 * erase real projects, keys and topics. A name check is crude, but it turns
 * "should not happen" into "cannot".
 */
export function assertTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? '';
  const database = url.split('/').pop()?.split('?')[0] ?? '';

  if (!database.endsWith('_test')) {
    throw new Error(
      `Тести відмовляються працювати з базою «${database || '(не задано)'}»: ` +
        'ім\'я має закінчуватись на _test. Інакше перший же прогін зітре робочі дані.',
    );
  }
}
