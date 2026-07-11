import { describe, expect, it } from "vitest";
import { packageBootstrap, packageName } from "../src/index.js";

describe("package bootstrap", () => {
  it("exposes stable package identity and rollout metadata", () => {
    expect(packageName).toBe("@plasius/gpu-model-runtime");
    expect(packageBootstrap).toEqual({
      packageName: "@plasius/gpu-model-runtime",
      featureFlag: "gpu.model.conversion.enabled",
      status: "bootstrap",
    });
  });
});
