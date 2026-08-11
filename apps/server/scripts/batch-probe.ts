/** One-off probe: does the batch tier accept our key and answer at all. */
import { eq } from 'drizzle-orm';
import { closeDatabase, db } from '../src/db/client.js';
import { apiKeys } from '../src/db/schema.js';
import { decryptSecret } from '../src/crypto/secrets.js';
import { providers } from '../src/ai/gemini.js';

const label = process.argv[2] ?? 'Paid';
const model = process.argv[3] ?? 'gemini-3.5-flash-lite';

const [key] = await db.select().from(apiKeys).where(eq(apiKeys.label, label)).limit(1);
if (!key) throw new Error(`ключ «${label}» не знайдено`);

const secret = decryptSecret(key.secretEnc);
const provider = providers.gemini!;

const handle = await provider.submitBatch!(secret, [
  { model, prompt: 'Одним реченням: навіщо черга в Postgres замість Redis?' },
  { model, prompt: 'Одним реченням: навіщо в черзі SKIP LOCKED?' },
]);
console.log('submitted', handle);

for (let i = 0; i < 20; i++) {
  const result = await provider.pollBatch!(secret, handle.name);
  console.log(
    i,
    result.state,
    result.items.map((item) => item.text?.slice(0, 80) ?? item.error ?? '').join(' | ') ||
      result.error ||
      '',
  );
  if (result.state !== 'pending') break;
  await new Promise((r) => setTimeout(r, 15_000));
}

await closeDatabase();
