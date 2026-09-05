/**
 * Quote anything that is not a plain YAML-safe scalar.
 *
 * Model ids carry colons (`nomic-embed-text-v2-moe:latest`) and an unquoted one
 * as a KEY is a mapping inside a mapping, so a snippet built without this pastes
 * as something else entirely.
 *
 * Its own module because both sides need it and they cannot import each other:
 * the server applies it when rendering the config to paste, and the console
 * applies it to the same snippet on the read-only listener — where the ids come
 * from the PEER, who chooses them, and one containing a newline would otherwise
 * inject whatever structure it liked into a block the operator is being told to
 * paste into their config. It lived in overrides.ts and was copied into the page
 * by hand, which is exactly the arrangement where the two drift apart.
 *
 * Nothing else may go in here: this is bundled into the browser page, and
 * overrides.ts pulls in node:fs and the yaml parser.
 */
export const yamlScalar = (s: string): string =>
  /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(s) ? s : JSON.stringify(s);
