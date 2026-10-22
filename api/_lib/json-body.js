// Vercel exposes a lazy body getter which can itself throw for invalid JSON.
function jsonBody(req) {
  try {
    const body = req.body;
    return { ok: true, value: typeof body === 'string' ? JSON.parse(body) : body };
  } catch {
    return { ok: false };
  }
}
module.exports = { jsonBody };
