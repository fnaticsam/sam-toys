// The only Playa module allowed to access Blob. All callers must authorize first.
const ID = /^[0-9a-f]{64}$/;
const RID = /^[0-9a-f]{32}$/;
const EXPORT_ERRORS = new Set(['invalid-request', 'not-published', 'integrity', 'too-large', 'busy', 'internal']);
const EMPTY_ETAG = '"empty"';
const failure = (status, code) => Object.assign(new Error('export'), { status, code });
const validId = (id) => typeof id === 'string' && id.length === 64 && ID.test(id);
const validRid = (rid) => typeof rid === 'string' && rid.length === 32 && RID.test(rid);
// Requests are bounded and canonical before either publication or reuse.
function exportInput(value) {
  if (!value || !['photo', 'zip'].includes(value.kind) || !['2048', '4096', 'original'].includes(value.size) ||
      !Array.isArray(value.ids) || !value.ids.length || value.ids.length > 2000 ||
      value.ids.some((id) => !validId(id)) || new Set(value.ids).size !== value.ids.length ||
      (value.kind === 'photo' && (value.ids.length !== 1 || value.size === '2048')))
    throw failure(400, 'invalid-request');
  return { kind: value.kind, size: value.size, ids: value.ids.slice() };
}
// Creates the same optimistic-concurrency failure for all stale writes.
const conflict = () => Object.assign(new Error('conflict'), { status: 412 });

// Builds an injectable private-store client without making a network request.
function createStore(client = require('@vercel/blob'), token = () => process.env.PLAYA_READ_WRITE_TOKEN) {
  // Serializes admissions sharing this instance. See the documented cross-instance
  // limitation: the frozen request layout has no atomic global reservation key.
  let admissions = Promise.resolve();
  // Requires the dedicated linked-store token for every Blob operation.
  function options() {
    const value = token();
    if (!value) throw new Error('store-unavailable');
    return { access: 'private', token: value };
  }
  // Uses uncached private reads and treats only Blob-not-found as absence.
  async function read(pathname, extra = {}) {
    try {
      return await client.get(pathname, { ...options(), useCache: false, ...extra });
    } catch (error) {
      if (client.BlobNotFoundError && error instanceof client.BlobNotFoundError) return null;
      throw error;
    }
  }
  async function json(pathname) {
    const result = await read(pathname);
    return result ? new Response(result.stream).json() : null;
  }
  async function published(ids) {
    const data = await json('catalog/catalog.json');
    if (!data || !Array.isArray(data.photos)) throw new Error('invalid-catalog');
    const photos = new Map(data.photos.filter((p) => p && validId(p.id) && String(p.y).length === 4 &&
      /^\d{4}$/.test(String(p.y))).map((p) => [p.id, p]));
    if (ids.some((id) => !photos.has(id))) throw failure(400, 'not-published');
    return photos;
  }
  // Never accept a pathname from a request or a worker as signing authority.
  async function sign(pathname, download = false) {
    const validUntil = Date.now() + 5 * 60 * 1000;
    const signed = await client.issueSignedToken({ ...options(), pathname, operations: ['get'], validUntil });
    const { presignedUrl } = await client.presignUrl(signed, { access: 'private', operation: 'get', pathname, validUntil });
    // SDK 2.6.1's getDownloadUrl adds this same unsigned disposition switch.
    // GET presigning has no custom filename override; the basename is retained.
    return download ? `${presignedUrl}${presignedUrl.includes('?') ? '&' : '?'}download=1` : presignedUrl;
  }
  function requestRecord(value, rid) {
    if (!value || value.v !== 1 || value.rid !== rid || !validRid(rid) ||
        typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) throw new Error('invalid-export');
    try { return { ...exportInput(value), created_at: value.created_at }; }
    catch { throw new Error('invalid-export'); }
  }
  function progress(value, rid, total) {
    if (!value || value.v !== 1 || value.rid !== rid || !['queued', 'building', 'ready', 'failed'].includes(value.state) ||
        !Number.isSafeInteger(value.done) || value.done < 0 || value.done > total || value.total !== total ||
        typeof value.updated_at !== 'string' || !Number.isFinite(Date.parse(value.updated_at)) ||
        typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))) throw new Error('invalid-export');
    return { state: value.state, done: value.done, total: value.total };
  }
  // Count every request without a terminal status, across all list pages. No
  // catalog, media or arbitrary prefixes are ever listed.
  async function unfinished() {
    let cursor, count = 0;
    const cursors = new Set();
    do {
      const page = await client.list({ ...options(), prefix: 'exports/req/', limit: 1000, ...(cursor ? { cursor } : {}) });
      const ids = page.blobs.map((blob) => /^exports\/req\/([0-9a-f]{32})\.json$/.exec(blob.pathname)?.[1]).filter(Boolean);
      // Terminal records remain for 24 h; bounded parallel reads avoid a serial
      // network round trip for every retained request without an unbounded fanout.
      for (let offset = 0; offset < ids.length; offset += 16) {
        const batch = ids.slice(offset, offset + 16);
        const statuses = await Promise.all(batch.map((rid) => json(`exports/status/${rid}.json`)));
        count += statuses.filter((status, i) => !status || status.v !== 1 || status.rid !== batch[i] ||
          !['ready', 'failed'].includes(status.state)).length;
        if (count >= 8) return count;
      }
      if (!page.hasMore) break;
      if (!page.cursor || cursors.has(page.cursor)) throw new Error('invalid-list');
      cursor = page.cursor;
      cursors.add(cursor);
    } while (true);
    return count;
  }
  // Returns validated stored IDs and the Blob ETag, or an empty initial state.
  async function shortlist() {
    const result = await read('state/shortlist.json');
    if (!result) return { ids: [], updated_at: null, etag: EMPTY_ETAG };
    const data = await new Response(result.stream).json();
    if (
      !Array.isArray(data.ids) ||
      data.ids.length > 5000 ||
      data.ids.some((id) => typeof id !== 'string' || id.length !== 64 || !ID.test(id))
    ) {
      throw new Error('invalid-state');
    }
    return { ids: [...new Set(data.ids)], updated_at: data.updated_at, etag: result.blob.etag };
  }
  return {
    // Forwards conditional reads only to the fixed catalog pathname.
    catalog: (etag) => read('catalog/catalog.json', etag ? { ifNoneMatch: etag } : {}),
    // Signs only the constructed derivative pathname with a five-minute GET grant.
    async media(size, id) {
      // Validate again at the signing boundary; no caller can sign an arbitrary path.
      if (!['thumb', 'preview'].includes(size) || typeof id !== 'string' || id.length !== 64 || !ID.test(id))
        throw new Error('invalid-media');
      const pathname = `${size}/${id.slice(0, 2)}/${id}.webp`;
      return sign(pathname);
    },
    async download(id) {
      if (!validId(id)) throw failure(400, 'invalid-request');
      const photos = await published([id]);
      // Same save-as label rule as the box uploader: four-digit year, otherwise "unknown".
      const y = photos.get(id).y;
      const year = Number.isInteger(y) && y >= 1000 && y <= 9999 ? y : 'unknown';
      return sign(`dl/2048/${id.slice(0, 2)}/${id}/playa-${year}-${id.slice(0, 10)}.jpg`, true);
    },
    async requestExport(value) {
      const input = exportInput(value);
      const task = admissions.then(async () => {
        await published(input.ids);
        if (await unfinished() >= 8) throw failure(429, 'export-busy');
        const rid = require('crypto').randomBytes(16).toString('hex');
        const data = { v: 1, rid, ...input, created_at: new Date().toISOString() };
        await client.put(`exports/req/${rid}.json`, JSON.stringify(data), {
          ...options(), addRandomSuffix: false, contentType: 'application/json', allowOverwrite: false,
        });
        return { rid };
      });
      admissions = task.catch(() => {});
      return task;
    },
    async exportStatus(rid) {
      if (!validRid(rid)) throw failure(404, 'not-found');
      const [request, status] = await Promise.all([json(`exports/req/${rid}.json`), json(`exports/status/${rid}.json`)]);
      if (!request && !status) throw failure(404, 'not-found');
      // An orphan status cannot authorize an output, even if it says ready.
      if (!request) throw new Error('invalid-export');
      const input = requestRecord(request, rid);
      const photos = await published(input.ids);
      if (!status) return { state: 'queued' };
      const result = progress(status, rid, input.ids.length);
      if (Date.parse(status.expires_at) <= Date.now()) return { state: 'expired' };
      if (status.state === 'failed') return { ...result, error: EXPORT_ERRORS.has(status.error) ? status.error : 'internal' };
      if (status.state !== 'ready') return result;
      const file = status.file;
      if (!file || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || typeof file.name !== 'string' ||
          status.done !== status.total) throw new Error('invalid-export');
      let validName;
      if (input.kind === 'photo') {
        const stem = `playa-${photos.get(input.ids[0]).y}-${input.ids[0].slice(0, 10)}.`;
        const extension = file.name.startsWith(stem) ? file.name.slice(stem.length) : '';
        validName = input.size === '4096' ? extension === 'jpg' : extension.length >= 1 &&
          extension.length <= 10 && !/[^a-z0-9]/.test(extension);
      } else {
        const match = /^playa-shortlist-(\d{4}-\d{2}-\d{2})-(2048|4096|original)\.zip$/.exec(file.name);
        validName = match && match[0] === file.name && match[2] === input.size && Number.isFinite(Date.parse(match[1])) &&
          new Date(match[1]).toISOString().slice(0, 10) === match[1];
      }
      if (!validName) throw new Error('invalid-export');
      const pathname = `exports/out/${rid}/${file.name}`;
      if (file.path !== pathname) throw new Error('invalid-export');
      return { ...result, url: await sign(pathname, true), bytes: file.bytes, name: file.name };
    },
    shortlist,
    // Preserves atomic first creation and ETag-conditional updates.
    async saveShortlist(ids, etag) {
      const current = await shortlist();
      if (!etag || etag !== current.etag) throw conflict();
      const data = { ids, updated_at: new Date().toISOString() };
      try {
        const result = await client.put('state/shortlist.json', JSON.stringify(data), {
          ...options(),
          addRandomSuffix: false,
          contentType: 'application/json',
          // First creation must also be atomic: never overwrite an intervening create.
          allowOverwrite: etag !== EMPTY_ETAG,
          ...(etag === EMPTY_ETAG ? {} : { ifMatch: etag }),
        });
        return { ...data, etag: result.etag };
      } catch (error) {
        if (client.BlobPreconditionFailedError && error instanceof client.BlobPreconditionFailedError) throw conflict();
        if (etag === EMPTY_ETAG && (await shortlist()).etag !== EMPTY_ETAG) throw conflict();
        throw error;
      }
    },
  };
}
module.exports = { createStore, ID };
