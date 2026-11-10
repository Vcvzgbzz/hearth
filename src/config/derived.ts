/**
 * Values derived from the live config, rebuilt only when what they read has changed. A live edit
 * replaces a changed key whole and never edits one in place (`ConfigFile.apply`; the credential keys
 * are frozen), so a key that is the same object as last time is unchanged. That makes identity the
 * check, and it holds however the key was replaced, by a live edit or by a test.
 */

/**
 * `build()`, kept until one of `inputs()` is no longer the same object (or their number changes).
 * `inputs` reads the config parts the value depends on, in a fixed order.
 */
export function derived<T>(inputs: () => readonly unknown[], build: () => T): () => T {
  let from: readonly unknown[] | null = null;
  let value!: T;
  return () => {
    const now = inputs();
    if (from === null || from.length !== now.length || from.some((x, i) => x !== now[i])) {
      value = build();
      from = now;
    }
    return value;
  };
}
