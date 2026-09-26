/* ============================================================
   Moa — on-device AI worker (CLIP ViT-B/32 via Transformers.js)
   Runs apart from the page: it only ever sees pixels and words, never
   the GitHub token, so it alone gets the looser CSP the WASM runtime
   needs (see vercel.json). The model is fetched once from Hugging Face
   and kept in the browser cache; photos never leave the device.
   Messages: {id, type:'init'|'image'|'text', ...} → {id, ok|vec|vecs|error}
   plus {type:'progress', loaded, total} while the model downloads.
   ============================================================ */

import { env, AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage } from '../vendor/transformers/transformers.min.js';

const MODEL = 'Xenova/clip-vit-base-patch32';
env.allowLocalModels = false;
env.useBrowserCache = true;
// the WASM runtime ships with Moa instead of coming from a CDN
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('../vendor/transformers/ort-wasm-simd-threaded.mjs', import.meta.url).href,
  wasm: new URL('../vendor/transformers/ort-wasm-simd-threaded.wasm', import.meta.url).href,
};
env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation, so no threads anyway
env.useWasmCache = false; // import the runtime straight from Moa, not via a blob: copy the CSP would refuse

const files = new Map(); // file → [loaded, total], summed for one progress figure
function progress(p) {
  if (p.status !== 'progress' && p.status !== 'done') return;
  const prev = files.get(p.file) || [0, 0];
  files.set(p.file, [p.status === 'done' ? prev[1] || p.loaded || 0 : p.loaded || 0, p.total || prev[1] || 0]);
  let loaded = 0, total = 0;
  for (const [l, t] of files.values()) { loaded += l; total += t; }
  postMessage({ type: 'progress', loaded, total });
}

let models = null;
function load() {
  const opts = { device: 'wasm', dtype: 'q8', progress_callback: progress };
  return models ||= Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    AutoTokenizer.from_pretrained(MODEL),
    CLIPVisionModelWithProjection.from_pretrained(MODEL, opts),
    CLIPTextModelWithProjection.from_pretrained(MODEL, opts),
  ]).then(([processor, tokenizer, vision, text]) => ({ processor, tokenizer, vision, text }))
    .catch(e => { models = null; throw e; });
}

function unit(data) {
  const v = Float32Array.from(data);
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

self.onmessage = async ({ data: m }) => {
  try {
    const { processor, tokenizer, vision, text } = await load();
    if (m.type === 'init') return postMessage({ id: m.id, ok: true });
    if (m.type === 'image') {
      const image = new RawImage(new Uint8ClampedArray(m.data), m.width, m.height, 4);
      const { image_embeds } = await vision(await processor(image));
      const vec = unit(image_embeds.data);
      return postMessage({ id: m.id, vec }, [vec.buffer]);
    }
    if (m.type === 'text') {
      const { text_embeds } = await text(tokenizer(m.texts, { padding: true, truncation: true }));
      const d = text_embeds.dims[text_embeds.dims.length - 1];
      return postMessage({ id: m.id, vecs: m.texts.map((_, i) => unit(text_embeds.data.slice(i * d, (i + 1) * d))) });
    }
    postMessage({ id: m.id, error: 'unknown request' });
  } catch (e) {
    postMessage({ id: m.id, error: String(e?.message || e) });
  }
};
