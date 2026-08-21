/** Library surface, for embedding a node instead of running the CLI. Most people
 *  want the CLI; this is here so an app that already has its own config loader
 *  doesn't have to round-trip through a YAML file to use any of it. */
export { parseConfig, loadConfig, ConfigError } from "./config.js";
export type { HearthConfig, PeerConfig, BackendConfig, ModelRoute, RoutePolicy } from "./config.js";
export { createNode } from "./server.js";
export type { HearthNode } from "./server.js";
// Shows up in HearthNode's type, so without this an embedder can't name it
// without deep-importing.
export { BackendState } from "./backend.js";
export { BackendPool } from "./pool.js";
export type { BackendSlot, ModelCapacity } from "./pool.js";
export { Scheduler, QueueFullError, AbortedError } from "./scheduler.js";
export type { JobSpec, JobView, SchedulerOptions } from "./scheduler.js";
export { History } from "./history.js";
export type { Sample, BackendSample } from "./history.js";
export { PeerRegistry } from "./peers.js";
export type { PeerStatus, PeerCapacity, PeerModelLoad } from "./peers.js";
export { decide } from "./route.js";
export type { Decision, LocalLoad } from "./route.js";
export { createLogger, silentLogger } from "./log.js";
export type { Logger, Level } from "./log.js";
