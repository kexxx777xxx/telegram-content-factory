/**
 * Builds the link that survives publication.
 *
 * After a post goes out, this string plus a handful of metrics is all that
 * remains of it here (ADR 0002) — so getting the form right matters more than
 * it looks.
 */
export function buildPermalink(
  channelId: string,
  channelUsername: string | null,
  messageId: number,
): string | null {
  // Public channels get the readable form. `getChat` caches the username at
  // connection time precisely so this branch is available later.
  const username = channelUsername ?? (channelId.startsWith('@') ? channelId.slice(1) : null);
  if (username) return `https://t.me/${username}/${messageId}`;

  // Private supergroups and channels are addressed as -100<internal>; the web
  // client wants the internal part without that prefix.
  const numeric = /^-100(\d+)$/.exec(channelId);
  if (numeric?.[1]) return `https://t.me/c/${numeric[1]}/${messageId}`;

  return null;
}
