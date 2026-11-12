/**
 * A plugin's type, in one place: kept free of every other import so the engine and the console read
 * the same rule without either pulling the config parser (and Node) into the browser bundle.
 */

/**
 * The type a plugin serves: `MCP` for one that speaks MCP, `API` for one that serves a plain HTTP API,
 * null for one that serves nothing. This is the one place a plugin's type is decided; everything else
 * reads it from here, so no other code names a type a plugin might serve.
 */
export function pluginKind(decl: { serves?: unknown; mcp?: unknown; run?: unknown }): string | null {
  const serves = decl.serves !== null && decl.serves !== undefined && decl.serves !== false;
  const runs = decl.run !== null && decl.run !== undefined && decl.run !== false;
  if (!serves && !runs) return null;
  return decl.mcp !== null && decl.mcp !== undefined && decl.mcp !== false ? "MCP" : "API";
}

/** Every type the plugins in `plugins` serve, each once, in the order they are declared. */
export function pluginKinds(plugins: Record<string, { serves?: unknown; mcp?: unknown; run?: unknown }>): string[] {
  return [...new Set(Object.values(plugins).map(pluginKind).filter((k): k is string => k !== null))];
}
