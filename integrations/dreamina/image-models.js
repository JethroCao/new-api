// Credits per output from the 2026-11-19 quote survey. The live, accepted
// batch quote is authoritative. Money per credit is configured in New API.
export const IMAGE_MODELS = {
  'high_aes_general_v50_flash': {rates:{'1.5K':3,'2K':3}, max:4, refs:10},
  'jimeng_smart_image_v1': {rates:{'1K':6,'2K':11,'4K':14}, max:4, refs:4},
  'jm_image_model_anycook': {rates:{'2K':1,'4K':2}, max:8, refs:4},
  'jm_image_model_yc_mj82': {rates:{'1K':5,'2K':7}, min:4, max:4, refs:20},
  'seedream_4.0': {rates:{'2K':1,'4K':2}, max:8, refs:6},
  'seedream_4.1': {rates:{'2K':1,'4K':2}, max:8, refs:6},
  'seedream_4.5': {rates:{'2K':3,'4K':4}, max:8, refs:6},
  'seedream_4.6': {rates:{'2K':1,'4K':2}, max:8, refs:6},
  'seedream_4.7': {rates:{'1K':1,'2K':1,'4K':2}, max:8, refs:6},
  'seedream_5.0_lite': {rates:{'2K':3,'4K':4}, max:8, refs:6},
  'seedream_5.0_pro': {rates:{'1.5K':5,'2K':8,'4K':12}, max:4, refs:10},
  'seedream_5.5': {rates:{'1.5K':4,'2K':6}, max:8, refs:10},
};

export function normalizeImage(req, model, allowUploads) {
  if (!Object.prototype.hasOwnProperty.call(IMAGE_MODELS,model)) throw Error('Unsupported image model');
  if (!req || typeof req !== 'object' || Array.isArray(req) ||
      Object.keys(req).some(key => !['model','kind','prompt','resolution','ratio','mode','n','references'].includes(key)) ||
      (req.kind !== undefined && req.kind !== 'image')) throw Error('Invalid image request');
  const spec = IMAGE_MODELS[model];
  let n = req.n === undefined ? spec.min || 1 : req.n;
  if (typeof n === 'string' && /^[1-8]$/.test(n)) n=Number(n);
  // Cap new admissions on both sides of the gateway. Older receipts retain
  // their original model limits when they are read for settlement.
  if (!Number.isSafeInteger(n) || n < (spec.min || 1) || n > Math.min(4,spec.max)) throw Error('Unsupported image count (maximum 4)');
  if (req.resolution !== undefined && typeof req.resolution !== 'string') throw Error('Unsupported image resolution');
  const resolution = req.resolution === undefined ? Object.keys(spec.rates)[0] : req.resolution.toUpperCase();
  if (!Object.prototype.hasOwnProperty.call(spec.rates,resolution)) throw Error('Unsupported image resolution');
  const ratio = req.ratio === undefined ? '1:1' : req.ratio;
  if (typeof ratio !== 'string' || !/^\d{1,2}:\d{1,2}$/.test(ratio)) throw Error('Invalid aspect ratio');
  if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 32000 || /\0|\{\{/.test(req.prompt)) throw Error('Invalid image prompt');
  const references = req.references === undefined ? [] : req.references;
  if (!Array.isArray(references) || references.length > spec.refs) throw Error('Invalid reference image count');
  for (const ref of references) {
    if (!ref || ref.type !== 'image' || Object.keys(ref).some(k=>!['type','url'].includes(k))) throw Error('Invalid reference image');
    const url = ref.url;
    if (typeof url === 'string' && /^(https:\/\/|data:image\/)/.test(url) && !/[\x00-\x20]/.test(url)) continue;
    if (allowUploads && url && typeof url === 'object' && typeof url.__fileRef === 'string' && url.__fileRef.startsWith('request_file:') &&
        url.encoding === 'dataUrl' && Object.keys(url).every(k=>['__fileRef','mimeType','encoding','maxBytes'].includes(k))) continue;
    throw Error('Expected a reference image URL or file');
  }
  const mode = references.length ? 'i2i' : 't2i';
  if (req.mode !== undefined && req.mode !== mode) throw Error('Image mode and reference count disagree');
  return {kind:'image',model,prompt:req.prompt,mode,resolution,ratio,n,references};
}
