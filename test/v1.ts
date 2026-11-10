/**
 * Most fixtures here predate the v2 layout. They go through the real migration on the way in, so
 * every one of them is also a migration case; config.test.ts and fields.test.ts write v2 directly.
 * ponytail: v1 fixtures kept as-is; convert a file to v2 when you are in it anyway.
 */
import { parseConfig, type HearthConfig } from "../src/config/config.js";
import { migrate } from "../src/config/migrate.js";

export const parseV1 = (raw: unknown): HearthConfig => parseConfig(migrate(raw));
