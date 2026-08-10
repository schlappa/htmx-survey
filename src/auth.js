// Password hashing and cookie sessions.
//
// Workers have no bcrypt, but they do have WebCrypto, so passwords are stored
// as PBKDF2-SHA256 with a per-user random salt. Sessions are opaque random
// tokens held in a cookie; the cookie never carries user data, so nothing a
// client sends is trusted beyond "this token exists in the sessions table".

const ITERATIONS = 100_000;
const SESSION_DAYS = 30;
const COOKIE = 'session';

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iterations, salt, expected] = String(stored).split('$');
  if (scheme !== 'pbkdf2') {
    console.warn(`[auth] unknown password hash scheme: ${scheme}`);
    return false;
  }
  const actual = await pbkdf2(password, unb64(salt), Number(iterations));
  return timingSafeEqual(new Uint8Array(actual), unb64(expected));
}

// Comparison that does not leak how much of the value matched through timing.
export function timingSafeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- sessions ---------------------------------------------------------------

export async function createSession(env, userId) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(token, userId, now.toISOString(), expires.toISOString()).run();
  return { token, expires };
}

export function sessionCookie(token, expires) {
  // HttpOnly keeps it away from JS (so XSS cannot steal it); SameSite=Lax stops
  // it riding along on cross-site POSTs, which is our CSRF defence.
  return `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; ` +
    `Path=/; Expires=${expires.toUTCString()}`;
}

export const clearCookie = () =>
  `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Resolves the signed-in user, or null. Expired sessions are deleted on sight.
export async function currentUser(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    console.warn(`[auth] expired session for user ${row.id}, deleting`);
    await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, isAdmin: !!row.is_admin };
}

export async function destroySession(request, env) {
  const token = readCookie(request, COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`)
    .bind(token).run();
}
