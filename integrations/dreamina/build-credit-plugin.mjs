import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {VIDEO_MODELS} from './plugin.js';

// Keep sale/procurement prices in the host, outside the generated plugin.
export async function buildCreditPlugin(config) {
 const models=config?.models, promotion=config?.promotionReservationCreditsPerVideo;
 if(!config || Object.keys(config).some(k=>!['models','promotionReservationCreditsPerVideo'].includes(k)) ||
    !Array.isArray(models) || !models.length || new Set(models).size!==models.length ||
    models.some(model=>!Object.hasOwn(VIDEO_MODELS,model)))throw Error('Configure models with unique canonical video model names; legacy reservationCreditsPerVideo must be replaced');
 if(promotion!==undefined && promotion!==null && (!Number.isSafeInteger(promotion) || promotion<1 || promotion>250000000))throw Error('Invalid promotionReservationCreditsPerVideo');
 let source=await readFile(new URL('./plugin.js',import.meta.url),'utf8');
 for(const name of ['buildSubmitRequest','buildQueryRequest','parseSubmitResponse','parseTaskResult','extractUsage','extractUsageOnComplete']) {
  const declaration='export function '+name+'(';
  if(source.split(declaration).length!==2)throw Error('Shared plugin hook contract changed: '+name);
  source=source.replace(declaration,'function seconds_'+name+'(');
 }
 return source+'\n// Generated credit variant; rebuild with build-credit-plugin.mjs.\nconst CREDIT_MODELS='+JSON.stringify(models)+';\nconst PROMOTION_RESERVATION='+JSON.stringify(promotion??null)+';\n'+await readFile(new URL('./credit-hooks.js',import.meta.url),'utf8');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [configPath,outputPath]=process.argv.slice(2);
 if(!configPath || !outputPath)throw Error('Usage: node build-credit-plugin.mjs reservations.json output.js');
 const source=await buildCreditPlugin(JSON.parse(await readFile(configPath,'utf8')));
 // Refuse to overwrite existing sources or already reviewed release artifacts.
 await writeFile(outputPath,source,{flag:'wx',mode:0o600});
}
