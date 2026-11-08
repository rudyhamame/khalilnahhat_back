// Narrow S3 adapter: private bucket inspection, streamed reads, and exact-object deletion.
const { S3Client, HeadBucketCommand, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
function createRecordingObjectStore(config) {
  const client = new S3Client({ endpoint: config.storageEndpoint, region: config.region, forcePathStyle: true,
    credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey }, maxAttempts: 2 });
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(30000) });
  return {
    async bucketExists(bucket) {
      try { await send(new HeadBucketCommand({ Bucket: bucket })); return true; }
      catch (error) { if (error.$metadata?.httpStatusCode === 404) return false; throw error; }
    },
    async *listObjectsV2(bucket, prefix = '') {
      let token;
      for (let page = 0; page < 1000; page++) {
        const result = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
        for (const item of result.Contents || []) yield { name: item.Key, size: item.Size || 0 };
        if (!result.IsTruncated) return;
        if (!result.NextContinuationToken || result.NextContinuationToken === token) throw new Error('Invalid staging pagination');
        token = result.NextContinuationToken;
      }
      throw new Error('Recording staging inventory exceeds its safety limit');
    },
    async getObject(bucket, key) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(600000) });
      if (!result.Body) throw new Error('Recording object has no body');
      return result.Body;
    },
    async removeObject(bucket, key) { await send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); },
  };
}
module.exports = { createRecordingObjectStore };
