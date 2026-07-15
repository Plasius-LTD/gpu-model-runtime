import type { ModelCache } from "./types.js";

export class MemoryModelCache implements ModelCache {
  private readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }

  return value;
}

export function createModelCacheKey(
  contentHash: string,
  formatId: string,
  adapterOptions: unknown,
): string {
  return `${formatId}:${contentHash}:${JSON.stringify(stableValue(adapterOptions ?? null))}`;
}
