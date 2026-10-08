/**
 * Operator login: a username and password from the config, checked with scrypt, and a
 * long-lived session in an HttpOnly cookie. A session is the third trust signal this node
 * recognises — the address, a key, or a login — and it grants the operator surface
 * (the console page, its data, /config, /control) without being on loopback.
 *
 * The session store and the throttles are in memory: a restart logs everyone out and
 * clears the counters, which is the safe direction to fail.
 */
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/** The cookie name; distinct from other apps on this box. */
export const COOKIE = "hearth_op";
/** Sessions last 30 days, refreshed on each authenticated use. */
export const SESSION_TTL_MS = 30 * 86_400_000;

/** scrypt with a per-password random salt, stored as `salt:hash` in hex. */
export function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return scrypt(password, salt, 64).then((derived) => `${salt.toString("hex")}:${derived.toString("hex")}`);
}

/** A fixed, well-formed decoy hash: 16-byte salt, 64-byte hash, both zeroed. */
const DECOY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;

/** Constant-time verify. Returns false on any malformed stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  // Lengths must match for timingSafeEqual, and equal length is part of "equal".
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

/**
 * Burn one scrypt's worth of time on a login for a username with no operator, so timing
 * does not reveal which usernames exist — a fast "no such user" path would defeat the
 * ambiguous error message.
 */
export function verifyDecoy(password: string): Promise<boolean> {
  return verifyPassword(password, DECOY_HASH);
}

/** The session token from a `Cookie:` header, or null; split on the first `=` only. */
export function cookieToken(header: string | undefined, name: string = COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * Live sessions, keyed by the SHA-256 of the token — the raw token lives only in the
 * cookie, so dumping the process memory never hands one out.
 */
export class OperatorSessions {
  private readonly live = new Map<string, { user: string; expiresAt: number }>();

  constructor(private readonly ttlMs: number = SESSION_TTL_MS) {}

  /** Mint a token for a verified operator. */
  mint(user: string, now: number = Date.now()): string {
    const token = randomBytes(32).toString("hex");
    this.live.set(hashToken(token), { user, expiresAt: now + this.ttlMs });
    return token;
  }

  /** A live token resolves to its operator and slides its expiry; an expired one is dropped. */
  check(token: string, now: number = Date.now()): string | null {
    const hit = this.live.get(hashToken(token));
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.live.delete(hashToken(token));
      return null;
    }
    hit.expiresAt = now + this.ttlMs;
    return hit.user;
  }

  drop(token: string): void {
    this.live.delete(hashToken(token));
  }

  /** Expired sessions, for the periodic sweep. */
  prune(now: number = Date.now()): number {
    let n = 0;
    for (const [k, s] of this.live) if (s.expiresAt <= now) { this.live.delete(k); n++; }
    return n;
  }

  get size(): number {
    return this.live.size;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Rolling-window login throttles, all in memory. Per username: ten failures in fifteen
 * minutes turns "spray a password list" into "give up", and a success clears the count.
 * Per address: sixty attempts in fifteen minutes, generous for a shared NAT.
 */
export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  private readonly ips = new Map<string, number[]>();

  constructor(
    private readonly userMax = 10,
    private readonly userWindowMs = 15 * 60_000,
    private readonly ipMax = 60,
    private readonly ipWindowMs = 15 * 60_000,
  ) {}

  private live = (list: number[], now: number, windowMs: number): number[] => {
    const kept = list.filter((t) => t > now - windowMs);
    return kept;
  };

  blocked(user: string, ip: string, now: number = Date.now()): boolean {
    return (
      this.live(this.fails.get(user) ?? [], now, this.userWindowMs).length >= this.userMax ||
      this.live(this.ips.get(ip) ?? [], now, this.ipWindowMs).length >= this.ipMax
    );
  }

  note(user: string, ip: string, now: number = Date.now()): void {
    const f = this.live(this.fails.get(user) ?? [], now, this.userWindowMs);
    f.push(now);
    this.fails.set(user, f);
    const i = this.live(this.ips.get(ip) ?? [], now, this.ipWindowMs);
    i.push(now);
    this.ips.set(ip, i);
  }

  /** A successful login clears the per-username count, not the per-address one. */
  clear(user: string): void {
    this.fails.delete(user);
  }
}
