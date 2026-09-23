import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { OffloadStore } from "./offload.js";

export type S3OffloadStoreOptions = { client: S3Client; bucket: string; prefix?: string };

/** {@link OffloadStore} on Amazon S3. Requires `s3:PutObject` and `s3:GetObject` on `bucket/prefix*`. */
export function s3OffloadStore({ client, bucket, prefix = "" }: S3OffloadStoreOptions): OffloadStore {
  return {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix + key, Body: body, ContentType: "application/json" }));
    },
    async get(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: prefix + key }));
      if (!response.Body) throw new Error(`Empty offloaded checkpoint: s3://${bucket}/${prefix}${key}`);
      return await response.Body.transformToString();
    },
  };
}
