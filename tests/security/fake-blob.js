// Atomic, in-memory Blob double. Used only by local tests; never uses a token.
function fakeBlob() {
  const data = new Map(); let version = 0;
  class BlobPreconditionFailedError extends Error {}
  class BlobNotFoundError extends Error {}
  return {
    data, BlobPreconditionFailedError, BlobNotFoundError,
    async get(key, options) {
      if (options.access !== 'private' || options.useCache !== false) throw new Error('private uncached reads required');
      const item = data.get(key);
      return item ? { blob: { etag: item.etag }, stream: new Response(item.body).body } : null;
    },
    async put(key, body, options) {
      const old = data.get(key);
      if ((old && !options.allowOverwrite) || (options.ifMatch && old?.etag !== options.ifMatch)) throw new BlobPreconditionFailedError();
      if (old && !options.ifMatch) throw new Error('missing CAS');
      if (options.access !== 'private' || options.addRandomSuffix !== false) throw new Error('private deterministic writes required');
      const item = { etag: `"${++version}"`, body }; data.set(key, item); return { etag: item.etag };
    },
  };
}
module.exports = { fakeBlob };
