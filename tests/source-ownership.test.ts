import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { AdapterRegistry, ModelRuntime, type ModelSource, type ResolvedModelSource } from "../src/index.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expectedBytes = [1, 2, 3];
const expectedHash = digest(new Uint8Array(expectedBytes));

describe("owned in-memory acquisition", () => {
  it.each(["array-buffer", "uint8-array", "blob", "buffer-slice", "foreign-buffer", "foreign-array", "shared-array"])("keeps %s identity stable while caller storage changes during hashing", async kind => {
    let owner = new Uint8Array(expectedBytes);
    let source: ModelSource;
    if (kind === "foreign-buffer" || kind === "foreign-array") {
      const foreign = runInNewContext("new Uint8Array([1,2,3])") as Uint8Array;
      owner = foreign;
      source = kind === "foreign-buffer" ? { kind: "array-buffer", bytes: foreign.buffer as ArrayBuffer } : { kind: "uint8-array", bytes: foreign };
    } else if (kind === "buffer-slice") {
      const backing = Buffer.from([99, 1, 2, 3, 88]); owner = backing.subarray(1, 4);
      source = { kind: "uint8-array", bytes: owner };
    } else if (kind === "shared-array") {
      owner = new Uint8Array(new SharedArrayBuffer(3)); owner.set(expectedBytes);
      source = { kind: "uint8-array", bytes: owner };
    } else {
      source = kind === "array-buffer" ? { kind, bytes: owner.buffer as ArrayBuffer } : kind === "blob" ? { kind, blob: new Blob([owner.buffer as ArrayBuffer]) } : { kind: "uint8-array", bytes: owner };
    }
    const registry = new AdapterRegistry().register({ formatId: "fixture", load: async () => ({ formatId: "fixture", sniff: () => true, load: async (input: ResolvedModelSource) => ({ canonicalModel: Array.from(input.bytes) }) }) });
    const runtime = new ModelRuntime({ registry, dependencies: { hashBytes: async bytes => {
      const stamp = digest(bytes);
      // A caller may change its own storage while an asynchronous hash is pending.
      await Promise.resolve(); owner[0] = 9; return stamp;
    } } });
    const result = await runtime.loadModel(source, { formatId: "fixture", useCache: false, fetchPolicy: { maxBytes: 3 } });
    expect(result.contentHash).toBe(expectedHash);
    expect(result.canonicalModel).toEqual(expectedBytes);
    expect(owner[0]).toBe(9);
  });

  it.each(["array-buffer", "uint8-array", "blob"])("keeps related %s resources identical to verified integrity evidence", async kind => {
    const owner = new Uint8Array(expectedBytes);
    const bytes = kind === "array-buffer" ? owner.buffer : kind === "blob" ? new Blob([owner.buffer]) : owner;
    const registry = new AdapterRegistry().register({ formatId: "fixture", load: async () => ({ formatId: "fixture", sniff: () => true, load: async (input: ResolvedModelSource) => {
      const resource = await input.resourceResolver.resolve("buffer.bin");
      return { canonicalModel: { bytes: Array.from(resource.bytes), hash: resource.contentHash } };
    } }) });
    const runtime = new ModelRuntime({ registry, dependencies: { hashBytes: async input => {
      const stamp = digest(input);
      await Promise.resolve(); if (input.byteLength === 3) owner[0] = 9; return stamp;
    } } });
    const result = await runtime.loadModel({ kind: "uint8-array", bytes: new Uint8Array([0]), package: { resources: { "buffer.bin": { bytes, integrity: expectedHash } } } }, { formatId: "fixture", useCache: false, fetchPolicy: { maxBytes: 3 } });
    expect(result.canonicalModel).toEqual({ bytes: expectedBytes, hash: expectedHash });
    expect(owner[0]).toBe(9);
  });
});
