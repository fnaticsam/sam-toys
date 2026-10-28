const MCP_URL = 'https://mcp.skiplagged.com/mcp';
const TOOLS = new Set(['sk_flights_search', 'sk_destinations_anywhere', 'sk_flex_departure_calendar', 'sk_flex_return_calendar']);
class UpstreamError extends Error {
  constructor(code = 'upstream-unavailable') { super(code); this.code = code; }
}
function createClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = 6000, maxBytes = 2 * 1024 * 1024 } = {}) {
  return async function callTool(name, args, signal) {
    if (!TOOLS.has(name)) throw new UpstreamError();
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let reader;
    try {
      const response = await fetchImpl(MCP_URL, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      if (!response.ok) throw new UpstreamError(response.status === 429 ? 'upstream-throttled' : 'upstream-unavailable');
      if (!response.body) throw new UpstreamError('invalid-upstream-response');
      reader = response.body.getReader();
      const sse = /text\/event-stream/i.test(response.headers.get('content-type') || '');
      const decoder = new TextDecoder();
      let buffer = '', bytes = 0;
      const unpack = (text) => {
        let value;
        try { value = JSON.parse(text); } catch { throw new UpstreamError('invalid-upstream-response'); }
        if (value.id !== 1) return null; // server notifications are not results
        if (value.error || value.result?.isError || !value.result?.structuredContent) throw new UpstreamError('invalid-upstream-response');
        return value.result.structuredContent;
      };
      const event = (text) => {
        const data = text.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        return data ? unpack(data) : null;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new UpstreamError('invalid-upstream-response');
        buffer += decoder.decode(value, { stream: true });
        if (sse) {
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const result = event(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
            if (result) return result; // do not wait for an SSE connection to close
          }
        }
      }
      buffer += decoder.decode();
      const result = sse ? event(buffer) : unpack(buffer);
      if (!result) throw new UpstreamError('invalid-upstream-response');
      return result;
    } catch (error) {
      // No payloads, itinerary details, upstream error messages or auth values
      // are logged or returned, including in timeout and parsing failure paths.
      if (controller.signal.aborted) throw new UpstreamError('upstream-timeout');
      throw error instanceof UpstreamError ? error : new UpstreamError();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (reader) { try { await reader.cancel(); } catch {} }
    }
  };
}
module.exports = { MCP_URL, UpstreamError, createClient };
