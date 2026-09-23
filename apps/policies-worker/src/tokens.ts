/**
 * Acknowledgment link tokens.
 *
 * 128 random bits, base64url (22 characters). The token exists only in the
 * email; the database keeps its SHA-256, so a copy of the database cannot be
 * replayed as links.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

export function mintToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

/** A link stays valid until 30 days past the round's due date (or 60 days from now with none). */
export function linkExpiry(now: Date, dueAt: Date | null): Date {
  const DAY = 24 * 60 * 60 * 1000;
  const base = dueAt && dueAt.getTime() > now.getTime() ? dueAt.getTime() + 30 * DAY : now.getTime() + 60 * DAY;
  return new Date(base);
}
