// GET /api/ldn-data — latest dataset for the map (Blob live copy, else seed).
import { readDataset } from './_lib/ldn/store.mjs';

export default async function handler(req, res) {
  try {
    const { dataset, source } = await readDataset();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Data-Source', source);
    res.status(200).send(JSON.stringify(dataset));
  } catch {
    res.status(503).json({ error: 'dataset-unavailable' });
  }
}
