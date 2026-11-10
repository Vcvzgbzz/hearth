/**
 * The backend kinds hearth knows, and the two facts about each that validating a config needs.
 * What each kind does is `queue/kinds.ts`, which has one entry per name here and agrees on both facts.
 */
export const KIND_SPECS = {
  "llama-swap": { knowsWarm: true, unloads: true },
  ollama: { knowsWarm: true, unloads: false },
  single: { knowsWarm: true, unloads: false },
  none: { knowsWarm: false, unloads: false },
} as const satisfies Record<string, { knowsWarm: boolean; unloads: boolean }>;

export type KindName = keyof typeof KIND_SPECS;
