export * from "./cache.js";
export * from "./fetch.js";
export * from "./runtime.js";
export * from "./types.js";

/** Package identity and rollout metadata for the runtime boundary. */
export const packageName = "@plasius/gpu-model-runtime" as const;

export const packageBootstrap = Object.freeze({
  packageName,
  featureFlag: "gpu.model.conversion.enabled",
  status: "runtime",
} as const);

export * from "./model-residency.js";
