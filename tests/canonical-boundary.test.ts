import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  CANONICAL_GPU_MODEL_COORDINATE_SYSTEM, GPU_MODEL_DOCUMENT_SCHEMA_VERSION,
  createAndVerifyGpuModelDocument, evaluateGpuModelDiagnostics, isGpuModelDocument,
  type ModelSource as CoreModelSource,
} from "@plasius/gpu-model-core";
import {
  AdapterRegistry, ModelRuntime,
  type GpuModelDocument, type GpuModelDiagnosticMode, type ModelSource,
  type ModelAdapter, type AdapterLoadResult, type ModelLoadResult,
} from "../src/index.js";

async function document(): Promise<GpuModelDocument> {
  const bytes = new Uint8Array(12);
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  return createAndVerifyGpuModelDocument({
    schemaVersion: GPU_MODEL_DOCUMENT_SCHEMA_VERSION,
    coordinateSystem: CANONICAL_GPU_MODEL_COORDINATE_SYSTEM,
    roots: ["root"], nodes: [{ id: "root", children: [], meshId: "mesh", localMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    resources: [{ id: "buffer", kind: "buffer", contentHash, byteLength: 12, mimeType: "application/octet-stream", payload: new Blob([bytes]) }],
    accessors: [{ id: "positions", resourceId: "buffer", byteOffset: 0, count: 1, componentType: "f32", elementType: "vec3", min: [0, 0, 0], max: [0, 0, 0] }],
    meshes: [{ id: "mesh", primitives: [{ id: "point", topology: "points", attributes: [{ semantic: "POSITION", accessorId: "positions" }] }] }],
    materials: [], textures: [], skeletons: [], joints: [], skins: [],
    blendShapes: [], animations: [], analyticGeometry: [], bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    provenance: { sourceFormat: "fixture", sourceContentHash: contentHash, converterId: "fixture", converterVersion: "1" },
    diagnostics: [], metadata: {},
  }, {
    async digestSha256(chunks) {
      const hash = createHash("sha256");
      for await (const chunk of chunks) hash.update(chunk);
      return hash.digest("hex");
    },
    async inspectResource(chunks) {
      for await (const chunk of chunks) expect(chunk).toBeInstanceOf(Uint8Array);
      return { valid: true, detectedMimeType: "application/octet-stream" };
    },
  });
}

describe("published canonical boundary", () => {
  it("uses core IO and default canonical port types without changing generic consumers", () => {
    expectTypeOf<CoreModelSource>().toExtend<ModelSource>();
    expectTypeOf<ModelSource>().toExtend<CoreModelSource>();
    expectTypeOf<AdapterLoadResult["canonicalModel"]>().toEqualTypeOf<GpuModelDocument>();
    expectTypeOf<ModelLoadResult["canonicalModel"]>().toEqualTypeOf<GpuModelDocument>();
    expectTypeOf<AdapterLoadResult<string>["canonicalModel"]>().toEqualTypeOf<string>();
    const source: ModelSource = { kind: "url", url: "https://example.test/model.fixture", fileNameHint: "model.fixture", package: { resources: {} } };
    expect(source.package?.resources).toEqual({});
  });

  it("retains genuine core documents and core policy diagnostics through lazy loading and cache", async () => {
    const canonicalModel = await document();
    const adapter: ModelAdapter = {
      formatId: "fixture", sniff: () => true,
      async load(_input, { mode }) {
        const report = evaluateGpuModelDiagnostics({
          standard: "gltf-glb", mode,
          issues: [{ kind: "violation", ruleId: "missing-normals", code: "fixture", path: "/mesh", message: "Synthetic repair", originalValue: null, repairApplied: true }],
          ...(mode === "forensic" ? { rawSource: { synthetic: true } } : {}),
        });
        if (!report.accepted) throw new Error("Canonical policy rejected fixture");
        return { canonicalModel, diagnostics: report.diagnostics };
      },
    };
    const load = vi.fn(async () => adapter);
    const runtime = new ModelRuntime({ registry: new AdapterRegistry().register({ formatId: "fixture", sniff: () => true, load }) });
    expect(load).not.toHaveBeenCalled();
    const source: CoreModelSource = { kind: "uint8-array", bytes: new Uint8Array([1]), provenance: { sourceId: "synthetic-fixture" } };
    for (const mode of ["tolerant", "forensic"] satisfies GpuModelDiagnosticMode[]) {
      const result = await runtime.loadModel<GpuModelDocument>(source, { mode });
      expect(result.canonicalModel).toBe(canonicalModel);
      expect(isGpuModelDocument(result.canonicalModel)).toBe(true);
      expect(result.diagnostics?.[0]).toMatchObject({ kind: "repair", ruleId: "missing-normals" });
      const cached = await runtime.loadModel<GpuModelDocument>(source, { mode });
      expect(cached.fromCache).toBe(true);
      expect(cached.diagnostics).toBe(result.diagnostics);
    }
    await expect(runtime.loadModel(source)).rejects.toThrow("Canonical policy rejected fixture");
  });
});
