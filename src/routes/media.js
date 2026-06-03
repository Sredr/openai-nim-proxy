const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const router = express.Router();
const { extractApiKey, handleError, trackEndpoint, fetchWithRetry, stats, config } = require('../utils/helpers');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const GENAI_BASE = 'https://ai.api.nvidia.com/v1/genai';

function toGenaiBody(body) {
  const out = { prompt: body.prompt, cfg_scale: body.cfg_scale ?? body.guidance_scale ?? 3.5, steps: body.steps ?? 30 };
  if (body.negative_prompt && (!body.model || !String(body.model).toLowerCase().includes('flux'))) out.negative_prompt = body.negative_prompt;
  if (body.width) out.width = Number(body.width);
  if (body.height) out.height = Number(body.height);
  if (body.seed != null) out.seed = Number(body.seed);
  return out;
}

function toIntegrateBody(body) {
  const out = { ...body };
  if (out.steps && !out.num_inference_steps) { out.num_inference_steps = out.steps; delete out.steps; }
  if (out.scale && !out.guidance_scale) { out.guidance_scale = out.scale; delete out.scale; }
  if (out.model && String(out.model).toLowerCase().includes('flux')) delete out.negative_prompt;
  return out;
}

router.post('/images/generations', async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ', code: 401 } });
  stats.total++; trackEndpoint('POST /v1/images/generations');
  const model = String(req.body.model).trim();

  try {
    let result;
    try {
      const r = await fetchWithRetry({
        method: 'post', url: `${NIM_API_BASE}/images/generations`, data: toIntegrateBody(req.body),
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: config.timeoutMs,
      });
      result = r.data;
    } catch (e) {
      if (e.response && new Set([400, 404, 405, 422]).has(e.response.status)) {
        const r = await fetchWithRetry({
          method: 'post', url: `${GENAI_BASE}/${model}`, data: toGenaiBody(req.body),
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: config.timeoutMs,
        });
        const data = r.data;
        result = data?.data ? data : { created: Math.floor(Date.now() / 1000), data: (data?.artifacts ?? []).map(a => ({ b64_json: a.base64 ?? a.b64_json ?? '' })) };
      } else throw e;
    }
    stats.success++; res.json(result);
  } catch (err) { handleError(err, res); }
});

router.post('/audio/transcriptions', upload.single('file'), async (req, res) => {
  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: { message: 'Відсутній API ключ' } });
  stats.total++; trackEndpoint('POST /v1/audio/transcriptions');
  const form = new FormData();
  form.append('file', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
  form.append('model', req.body.model);
  try {
    const r = await fetchWithRetry({
      method: 'post', url: `${NIM_API_BASE}/audio/transcriptions`, data: form,
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() }, timeout: config.timeoutMs,
    });
    stats.success++; res.json(r.data);
  } catch (err) { handleError(err, res); }
});

module.exports = router;