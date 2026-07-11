/** Package identity and rollout metadata for the initial repository baseline. */
export const packageName = "@plasius/gpu-model-runtime" as const;

export const packageBootstrap = Object.freeze({
  packageName,
  featureFlag: "gpu.model.conversion.enabled",
  status: "bootstrap",
} as const);
