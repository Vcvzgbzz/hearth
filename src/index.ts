/**
 * Library surface, for embedding a node instead of running the CLI: load or build a config, make
 * the node, start it, listen, close it. What is exported here is what a release keeps working;
 * anything reached by a deep import, or through `node.pool`, `node.peers` and `node.history`, is
 * the node's own machinery and changes without notice.
 */
export { parseConfig, loadConfig, ConfigError } from "./config.js";
export type { HearthConfig } from "./config.js";
export { createNode } from "./server.js";
export type { HearthNode } from "./server.js";
export { createLogger, silentLogger } from "./log.js";
export type { Logger, Level } from "./log.js";
