/**
 * Node ≥26 运行时已有、但 @types/node / lib 尚未收录的 API。
 * 供 `pnpm typecheck`；勿在此堆业务类型。
 */
declare global {
  interface ErrorConstructor {
    isError(value: unknown): value is Error;
  }

  interface MapConstructor {
    // present at runtime on Node 26 Map instances via prototype
  }

  interface Map<K, V> {
    getOrInsert?(key: K, value: V): V;
    getOrInsertComputed?(key: K, callbackfn: (key: K) => V): V;
  }

  interface Uint8ArrayConstructor {
    fromBase64(data: string): Uint8Array;
  }

  interface Buffer {
    toBase64(): string;
    toHex(): string;
  }
}

export {};
