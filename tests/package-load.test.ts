import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAssetManifest } from "@plasius/asset-contracts";
import { AdapterRegistry, ModelRuntime, loadModelPackage, MODEL_PACKAGE_LOAD_LIMITS } from "../src/index.js";
import type { ModelAdapter, ResolvedModelSource } from "../src/index.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(texture = 9) {
  const files = [
    { path: "model.fixture", bytes: new Uint8Array([1, 2]), contentType: "model/gltf+json" },
    { path: "textures/map.png", bytes: new Uint8Array([texture, 8, 7]), contentType: "image/png" },
  ];
  const manifest = createAssetManifest({
    assetId: "package-fixture", version: "1.0.0", entrypoint: "model.fixture",
    createdAt: "2026-10-26T00:00:00.000Z", sourceAdapter: "local-import",
    files: files.map((file, index) => ({ path: file.path, byteLength: file.bytes.length, sha256: digest(file.bytes),
      contentType: file.contentType, role: index ? "texture" as const : "model" as const })),
  });
  const packageManifest = { format: "directory-manifest" as const, entries: files.map((file, index) => ({
    id: `file-${index}`, path: file.path, role: index ? "texture" as const : "mesh" as const, contentType: file.contentType,
  })) };
  return { manifest, packageManifest, files };
}
function setup(load?: ModelAdapter<number[]>["load"]) {
  const fetch = vi.fn(async () => new Response(new Uint8Array([99])));
  const parse = vi.fn(load ?? (async (input: ResolvedModelSource) => {
    const first = await input.resourceResolver.resolve("textures/map.png");
    first.bytes.fill(0);
    const reloaded = await input.resourceResolver.resolve("textures/map.png");
    return { canonicalModel: [...input.bytes, ...reloaded.bytes] };
  }));
  const runtime = new ModelRuntime({ dependencies: { fetch }, registry: new AdapterRegistry().register({
    formatId: "fixture", extensions: ["fixture"], load: async () => ({ formatId: "fixture", sniff: () => true, load: parse }),
  }) });
  return { runtime, parse, fetch };
}

describe("integrity-qualified package loading", () => {
  it("loads the declared entrypoint and reloads isolated texture bytes", async () => {
    const { runtime, parse, fetch } = setup();
    const result = await loadModelPackage<number[]>(runtime, fixture());
    expect(result.canonicalModel).toEqual([1, 2, 9, 8, 7]);
    expect(result.fromCache).toBe(false);
    expect(result.cacheKey).toMatch(/^model-package-v1:[a-f0-9]{64}:/u);
    expect(parse).toHaveBeenCalledTimes(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("resolves references relative to a nested declared entrypoint", async () => {
    const input = fixture();
    input.files = input.files.map((file) => ({ ...file, path: `models/${file.path}` }));
    input.manifest = { ...input.manifest, entrypoint: "models/model.fixture", files: input.manifest.files.map((file) => ({ ...file, path: `models/${file.path}` })) };
    input.packageManifest.entries = input.packageManifest.entries.map((entry) => ({ ...entry, path: `models/${entry.path}` }));
    const { runtime } = setup();
    expect((await loadModelPackage(runtime, input)).canonicalModel).toEqual([1, 2, 9, 8, 7]);
  });
  it("gives reordered equivalent inventories the same closure identity", async () => {
    const input = fixture(); const { runtime } = setup();
    const first = await loadModelPackage(runtime, input);
    input.files.reverse(); input.packageManifest.entries.reverse();
    input.manifest = { ...input.manifest, files: [...input.manifest.files].reverse() };
    expect((await loadModelPackage(runtime, input)).cacheKey).toBe(first.cacheKey);
  });
  it("snapshots metadata and file ranges before asynchronous qualification", async () => {
    const input = fixture(); const { runtime } = setup();
    const wrapped = new Uint8Array([99, 9, 8, 7, 99]);
    input.files[1]!.bytes = wrapped.subarray(1, 4);
    const pending = loadModelPackage<number[]>(runtime, input);
    input.files[0]!.bytes.fill(0); wrapped.fill(0);
    input.manifest = { ...input.manifest, entrypoint: "absent.fixture" };
    input.packageManifest.entries.length = 0; input.files.length = 0;
    expect((await pending).canonicalModel).toEqual([1, 2, 9, 8, 7]);
  });
  it("qualifies all resources before parsing and never uses entrypoint-only cache", async () => {
    const { runtime, parse } = setup();
    const first = await loadModelPackage<number[]>(runtime, fixture(9));
    const second = await loadModelPackage<number[]>(runtime, fixture(6));
    expect(first.canonicalModel).not.toEqual(second.canonicalModel);
    expect(first.cacheKey).not.toBe(second.cacheKey);
    await loadModelPackage(runtime, fixture(9));
    expect(parse).toHaveBeenCalledTimes(3);
    const tampered = fixture(); tampered.files[1]!.bytes[0] = 0;
    await expect(loadModelPackage(runtime, tampered)).rejects.toMatchObject({ code: "package-invalid" });
    expect(parse).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "duplicate", "path", "content-type", "size", "hash", "entrypoint"])("rejects %s inventories before adapter use", async (kind) => {
    const input = fixture(); const { runtime, parse } = setup();
    if (kind === "missing") input.files.pop();
    if (kind === "duplicate") input.files.push(input.files[0]!);
    if (kind === "path") input.packageManifest.entries[0]!.path = "../private";
    if (kind === "content-type") input.files[1]!.contentType = "image/jpeg";
    if (kind === "size") input.files[1]!.bytes = new Uint8Array(0);
    if (kind === "hash") input.manifest = { ...input.manifest, files: input.manifest.files.map((file) => ({ ...file, sha256: "f".repeat(64) })) };
    if (kind === "entrypoint") input.manifest = { ...input.manifest, entrypoint: "missing.fixture" };
    await expect(loadModelPackage(runtime, input)).rejects.toMatchObject({ code: "package-invalid" });
    expect(parse).not.toHaveBeenCalled();
  });
  it.each(["https://private.invalid/secret?token=synthetic", "missing.png", "../textures/map.png", "textures/../textures/map.png"])("refuses undeclared resource %s without fetch", async (path) => {
    const { runtime, fetch } = setup(async (input) => { await input.resourceResolver.resolve(path); return { canonicalModel: [] }; });
    await expect(loadModelPackage(runtime, fixture())).rejects.toMatchObject({ code: "load-failed", message: "Model package load failed: load-failed" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cannot override a manifest digest or mutate private package bytes to bypass integrity", async () => {
    const { runtime } = setup(async (input) => {
      const resources = input.source.package!.resources!;
      (resources["textures/map.png"]!.bytes as Uint8Array).fill(0);
      await input.resourceResolver.resolve({ path: "textures/map.png", integrity: digest(new Uint8Array(3)) });
      return { canonicalModel: [] };
    });
    await expect(loadModelPackage(runtime, fixture())).rejects.toMatchObject({ code: "load-failed" });
  });
  it("does not permit requested content-type or digest overrides", async () => {
    for (const reference of [{ path: "textures/map.png", contentType: "image/jpeg" }, { path: "textures/map.png", integrity: "f".repeat(64) }]) {
      const { runtime } = setup(async (input) => { await input.resourceResolver.resolve(reference); return { canonicalModel: [] }; });
      await expect(loadModelPackage(runtime, fixture())).rejects.toMatchObject({ code: "load-failed" });
    }
  });
  it("uses native integrity even with a custom legacy hash provider", async () => {
    const input = fixture();
    const runtime = new ModelRuntime({ dependencies: { hashBytes: async () => input.manifest.files[1]!.sha256 },
      registry: new AdapterRegistry().register({ formatId: "fixture", sniff: () => true, load: async () => ({
        formatId: "fixture", sniff: () => true, async load(source) {
          (source.source.package!.resources!["textures/map.png"]!.bytes as Uint8Array).fill(0);
          await source.resourceResolver.resolve("textures/map.png"); return { canonicalModel: [] };
        },
      }) }) });
    await expect(loadModelPackage(runtime, input)).rejects.toMatchObject({ code: "load-failed" });
  });
  it("contains hostile input getters, prototypes and parser exceptions without inspecting them", async () => {
    let reads = 0; const hostile = new Proxy({}, { getPrototypeOf() { throw "synthetic-secret"; } });
    const { runtime, parse } = setup(async () => { throw hostile; });
    const withGetter = Object.defineProperty({}, "manifest", { enumerable: true, get() { reads++; throw "secret"; } });
    for (const input of [withGetter, hostile, { ...fixture(), files: new Array(2) }, { ...fixture(), files: [{ ...fixture().files[0]!, bytes: new Uint8Array(new SharedArrayBuffer(2)) }] }]) {
      await expect(loadModelPackage(runtime, input as ReturnType<typeof fixture>)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(reads).toBe(0); expect(parse).not.toHaveBeenCalled();
    const caught = await loadModelPackage(runtime, fixture()).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: "load-failed", message: "Model package load failed: load-failed" });
    expect(caught).not.toBe(hostile);
  });
  it("enforces file and metadata budgets before unbounded allocation", async () => {
    const { runtime, parse } = setup();
    const large = fixture(); large.files[0]!.bytes = new Uint8Array(MODEL_PACKAGE_LOAD_LIMITS.fileBytes + 1);
    await expect(loadModelPackage(runtime, large)).rejects.toMatchObject({ code: "limit-exceeded" });
    const many = fixture(); many.files = Array.from({ length: MODEL_PACKAGE_LOAD_LIMITS.files + 1 }, () => many.files[0]!);
    await expect(loadModelPackage(runtime, many)).rejects.toMatchObject({ code: "limit-exceeded" });
    const aggregate = fixture();
    const block = new Uint8Array(MODEL_PACKAGE_LOAD_LIMITS.fileBytes);
    aggregate.files = Array.from({ length: 5 }, () => ({ ...aggregate.files[0]!, bytes: block }));
    await expect(loadModelPackage(runtime, aggregate)).rejects.toMatchObject({ code: "limit-exceeded" });
    let nested: unknown = {};
    for (let i = 0; i < 20; i++) nested = { child: nested };
    await expect(loadModelPackage(runtime, { ...fixture(), manifest: nested } as ReturnType<typeof fixture>)).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(parse).not.toHaveBeenCalled();
  });
  it("cancels before parsing and bounds an uncooperative parser by the total deadline", async () => {
    const controller = new AbortController(); controller.abort(new Error("secret"));
    const { runtime, parse } = setup(async () => new Promise(() => {}));
    await expect(loadModelPackage(runtime, fixture(), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(parse).not.toHaveBeenCalled();
    await expect(loadModelPackage(runtime, fixture(), { timeoutMs: 25 })).rejects.toMatchObject({ code: "deadline-exceeded" });
    const active = new AbortController();
    const pending = loadModelPackage(runtime, fixture(), { signal: active.signal });
    active.abort("secret");
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
  it("rejects invalid options and forged signal brands with bounded errors", async () => {
    const { runtime, parse } = setup();
    for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 60_001 }, { mode: "unknown" }, { formatId: "" }, { worker: { mode: "unknown" } }, { signal: Object.create(AbortSignal.prototype) }]) {
      await expect(loadModelPackage(runtime, fixture(), options as never)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(parse).not.toHaveBeenCalled();
  });
  it("does not invoke caller signal getters/method overrides", async () => {
    const parent = new AbortController(); let calls = 0;
    Object.defineProperty(parent.signal, "aborted", { get() { calls++; throw "secret"; } });
    Object.defineProperty(parent.signal, "addEventListener", { get() { calls++; throw "secret"; } });
    Object.defineProperty(parent.signal, "removeEventListener", { get() { calls++; throw "secret"; } });
    const { runtime } = setup();
    expect((await loadModelPackage(runtime, fixture(), { signal: parent.signal })).canonicalModel).toEqual([1, 2, 9, 8, 7]);
    expect(calls).toBe(0);
  });
  it("keeps host rollout/rollback and legacy caching compatible", async () => {
    const { runtime, parse } = setup(); const input = fixture();
    const legacy = () => runtime.loadModel<number[]>({ kind: "uint8-array", bytes: input.files[0]!.bytes, fileNameHint: "model.fixture",
      package: { resources: { "textures/map.png": { bytes: input.files[1]!.bytes } } } });
    const host = (enabled: boolean) => enabled ? loadModelPackage<number[]>(runtime, input) : legacy();
    for (const enabled of [false, true, false]) expect((await host(enabled)).canonicalModel).toEqual([1, 2, 9, 8, 7]);
    expect((await legacy()).fromCache).toBe(true); expect(parse).toHaveBeenCalledTimes(2);
  });
});
