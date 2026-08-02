import argon2 from 'argon2';

/**
 * Prints an argon2id hash for ADMIN_PASSWORD_HASH.
 *   npm run -w @tcf/server hash-password -- 'your-password'
 */
const password = process.argv[2];

if (!password) {
  console.error('Використання: npm run -w @tcf/server hash-password -- "пароль"');
  process.exit(1);
}

const hash = await argon2.hash(password, { type: argon2.argon2id });
console.log(hash);
