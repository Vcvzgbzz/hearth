/**
 * Who is calling: the one place a credential (an api key, a peer token, an operator session) or a
 * loopback address becomes a caller id. Keys are indexed by their sha256 digest, rebuilt whenever a
 * live config edit swaps the key lists, so a lookup costs one hash however many keys there are.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import type { HearthConfig } from "../config/config.js";
import type { KeyRule } from "../config/keys.js";
import { bearer, forwardable, keyId } from "../wire/http.js";
import { COOKIE, LoginThrottle, OperatorSessions, SESSION_TTL_MS, cookieToken } from "./login.js";
import { derived } from "../config/derived.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** On this machine, whatever the config says. The status page is gated on this alone, since a browser cannot send a bearer token. */
export const isLoopback = (req: IncomingMessage): boolean => LOOPBACK.has(req.socket.remoteAddress ?? "");

/** A local identity, and what it may run: null is everything. */
export interface Local { caller: string; models: string[] | null }

/** One configured api key, as everything outside this file sees it: never the key itself. */
export interface KeyEntry {
  /** `key:<label>`, or `key:<hash prefix>` for an unlabeled key. */
  caller: string;
  label: string;
  id: string;
  models: string[] | null;
  rule: KeyRule | null;
}

/** sha256, hex: what the indexes are keyed by, so no index holds a secret. */
const digest = (secret: string): string => createHash("sha256").update(secret).digest("hex");

interface KeyIndex {
  list: KeyEntry[];
  byDigest: Map<string, KeyEntry>;
  byCaller: Map<string, KeyEntry>;
  peerByDigest: Map<string, string>;
}

export class Callers {
  /** When each key last authenticated here: the one per-key fact the config file cannot hold. */
  private readonly seen = new Map<string, number>();
  /** The key and peer indexes, rebuilt when a live edit replaces a key list. */
  private readonly keys = derived(() => {
    const c = this.cfg;
    return [c.apiKeys, c.apiKeyLabels, c.apiKeyModels, c.apiKeyRules, c.peerTokens];
  }, () => this.indexKeys());
  /** Sessions belong to the login they were minted under: a changed login signs every one out, as a restart would. */
  private readonly loginSessions = derived(() => [this.cfg.operator], () => new OperatorSessions());
  readonly loginThrottle = new LoginThrottle();

  constructor(private readonly cfg: HearthConfig) {}

  get sessions(): OperatorSessions {
    return this.loginSessions();
  }

  /**
   * Keys and peer tokens by digest. A lookup by digest is as safe as comparing every key in constant
   * time: the timing can only tell an attacker about a hash of their own guess. Where two entries share
   * a key or a caller id, the first wins.
   */
  private indexKeys(): KeyIndex {
    const { apiKeys, apiKeyLabels, apiKeyModels, apiKeyRules, peerTokens } = this.cfg;
    const list = apiKeys.map((k, i): KeyEntry => {
      const label = apiKeyLabels[i] ?? "";
      return { caller: "key:" + (label || keyId(k)), label, id: keyId(k), models: apiKeyModels[i] ?? null, rule: apiKeyRules[i] ?? null };
    });
    const byDigest = new Map<string, KeyEntry>();
    const byCaller = new Map<string, KeyEntry>();
    apiKeys.forEach((k, i) => {
      const d = digest(k);
      if (!byDigest.has(d)) byDigest.set(d, list[i]!);
      if (!byCaller.has(list[i]!.caller)) byCaller.set(list[i]!.caller, list[i]!);
    });
    const peerByDigest = new Map<string, string>();
    for (const [name, token] of Object.entries(peerTokens)) {
      const d = digest(token);
      if (token !== "" && !peerByDigest.has(d)) peerByDigest.set(d, name);
    }
    return { list, byDigest, byCaller, peerByDigest };
  }

  /** Every configured key, in file order. */
  all(): readonly KeyEntry[] {
    return this.keys().list;
  }

  /** The rule of the key a caller is, or null for anyone else and for a key since revoked. */
  ruleOf(caller: string): KeyRule | null {
    return caller.startsWith("key:") ? this.keys().byCaller.get(caller)?.rule ?? null : null;
  }

  /** Is this one of our own api keys? */
  isOurKey(given: string): boolean {
    return given !== "" && this.keys().byDigest.has(digest(given));
  }

  /** Forwardable headers, minus an Authorization that is our own api key. */
  headersFor(req: IncomingMessage): Record<string, string | string[]> {
    const out = forwardable(req.headers);
    if (this.isOurKey(bearer(req))) delete out.authorization;
    return out;
  }

  /** Which peer is calling, by token. Null if we don't recognise it. */
  peer(req: IncomingMessage): string | null {
    const given = bearer(req);
    return given === "" ? null : this.keys().peerByDigest.get(digest(given)) ?? null;
  }

  /** A local caller by api key; with no keys configured, loopback and nothing else. */
  local(req: IncomingMessage): Local | null {
    const given = bearer(req);
    if (this.cfg.apiKeys.length === 0) {
      if (given !== "") return null; // presented a credential; it's not valid here
      return isLoopback(req) ? { caller: "local", models: null } : null;
    }
    if (given === "") return null;
    const key = this.keys().byDigest.get(digest(given));
    if (!key) return null;
    // Past its day, a key is no key.
    const expires = key.rule?.expires ?? null;
    if (expires !== null && Date.now() >= expires) return null;
    this.seen.set(key.caller, Date.now());
    return { caller: key.caller, models: key.models };
  }

  /** When this key last authenticated, or null. */
  lastSeen(caller: string): number | null {
    return this.seen.get(caller) ?? null;
  }

  forget(caller: string): void {
    this.seen.delete(caller);
  }

  /** The logged-in operator behind this request's session cookie, or null. */
  operator(req: IncomingMessage): string | null {
    const token = cookieToken(req.headers.cookie);
    return token ? this.sessions.check(token) : null;
  }

  /** Mint a session for `user` and set its cookie on `res`. */
  startSession(res: ServerResponse, user: string, now: number): void {
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    res.setHeader("Set-Cookie", `${COOKIE}=${this.sessions.mint(user, now)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
  }

  /** Drop this request's session, if any, and clear its cookie. */
  endSession(req: IncomingMessage, res: ServerResponse): void {
    const token = cookieToken(req.headers.cookie);
    if (token) this.sessions.drop(token);
    res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  /** Expired sessions and login strikes, swept like any other in-memory state. */
  prune(): void {
    this.sessions.prune();
    this.loginThrottle.prune();
  }
}
