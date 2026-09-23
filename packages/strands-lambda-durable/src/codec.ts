/**
 * Checkpoint codec. Version 2 keeps binary content (images, documents, redacted reasoning) intact by
 * storing `Uint8Array` values as base64. Version 1 records contain no binary markers, so both decode.
 */

const BYTES = "$bytes";

export const SCHEMA_VERSION = 2;

/** JSON-safe deep copy; `Uint8Array` values become `{ "$bytes": base64 }`. */
export function encode<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
    const original = this[key];
    return original instanceof Uint8Array ? { [BYTES]: Buffer.from(original).toString("base64") } : current;
  })) as T;
}

/** Inverse of {@link encode}. */
export function decode<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const keys = Object.keys(current);
      if (keys.length === 1 && keys[0] === BYTES && typeof current[BYTES] === "string") {
        return new Uint8Array(Buffer.from(current[BYTES], "base64"));
      }
    }
    return current;
  }) as T;
}

export function checked<T extends { schemaVersion: number }>(value: T): T {
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new Error(`Unsupported checkpoint schema: ${value.schemaVersion}`);
  }
  return value;
}
