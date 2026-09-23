import { createHash } from "node:crypto";
import type { Serdes } from "@aws/durable-execution-sdk-js";

/** Blob storage for checkpoint payloads that are too large to keep in the durable journal. */
export interface OffloadStore {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string>;
}

export type OffloadSerdesOptions = {
  store: OffloadStore;
  /** Payloads larger than this many UTF-8 bytes are stored in `store`. Default 64 KiB. */
  thresholdBytes?: number;
  /** Key prefix inside the store. */
  prefix?: string;
};

const POINTER = "$offload";

/**
 * JSON serdes that moves large checkpoint payloads to an {@link OffloadStore} and keeps only a pointer in the
 * journal. Keys are derived from the execution ARN and the operation ID, so a retry overwrites the same object.
 * Objects must outlive the execution's retention period; give the store a matching lifecycle rule.
 */
export function createOffloadSerdes({ store, thresholdBytes = 64 * 1024, prefix = "" }: OffloadSerdesOptions): Serdes<any> {
  return {
    async serialize(value, context) {
      if (value === undefined) return undefined;
      const body = JSON.stringify(value);
      if (Buffer.byteLength(body) <= thresholdBytes) return body;
      const execution = createHash("sha256").update(context.durableExecutionArn).digest("hex").slice(0, 32);
      const key = `${prefix}${execution}/${context.entityId}.json`;
      await store.put(key, body);
      return JSON.stringify({ [POINTER]: key });
    },
    async deserialize(data) {
      if (data === undefined) return undefined;
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === "object" && POINTER in parsed && typeof parsed[POINTER] === "string" && Object.keys(parsed).length === 1) {
        return JSON.parse(await store.get(parsed[POINTER]));
      }
      return parsed;
    },
  };
}
