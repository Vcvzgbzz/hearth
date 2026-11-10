/**
 * Quote anything that is not a plain YAML-safe scalar (model ids carry colons, and a peer's
 * id may carry a newline). Shared by server and page, so it stays free of node imports.
 */
export const yamlScalar = (s: string): string =>
  /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(s) ? s : JSON.stringify(s);
