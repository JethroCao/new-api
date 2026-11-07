import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip,prefix);

// No cookie, bearer token, proxy credentials or CLI credentials enter this
// transport. Pin the checked IPv4 address on every HTTPS hop (including DNS
// names); IPv6-only origins are deliberately unsupported, never a fallback.
export async function publicAddress(url, resolve = lookup, signal) {
  signal?.throwIfAborted();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443' || url.href.length > 16384) throw new Error('Invalid reference URL');
  const host = url.hostname;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':') || isIP(host) === 6) throw new Error('Reference host is not public IPv4');
  let abort;
  let addresses;
  try {
    const pending = isIP(host) === 4 ? [{address:host,family:4}] : resolve(host,{family:4,all:true});
    addresses = signal ? await Promise.race([pending, new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    })]) : await pending;
    signal?.throwIfAborted();
  } finally { if(abort) signal.removeEventListener('abort',abort); }
  if (!addresses.length || addresses.some(a => a.family !== 4 || !isIP(a.address) || blocked.check(a.address))) throw new Error('Reference host is not public IPv4');
  return addresses[0].address;
}

export function detectInput(bytes, type) {
  const png=bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  const jpeg=bytes[0]===255 && bytes[1]===216 && bytes[2]===255;
  const riff=bytes.toString('ascii',0,4)==='RIFF';
  const mp4=bytes.toString('ascii',4,8)==='ftyp';
  if(type==='image') {
    if(png) return 'png'; if(jpeg) return 'jpg';
    if(riff && bytes.toString('ascii',8,12)==='WEBP') return 'webp';
  }
  if(type==='video') {
    if(mp4) return 'mp4';
    if(bytes.subarray(0,4).equals(Buffer.from('1a45dfa3','hex'))) return 'webm';
  }
  if(type==='audio') {
    if(riff && bytes.toString('ascii',8,12)==='WAVE') return 'wav';
    if(bytes.toString('ascii',0,3)==='ID3' || bytes[0]===255 && (bytes[1]&224)===224) return 'mp3';
    if(bytes.toString('ascii',0,4)==='OggS') return 'ogg';
    if(mp4) return 'm4a';
    if(bytes.toString('ascii',0,4)==='fLaC') return 'flac';
  }
  throw new Error('Reference bytes do not match a supported '+type+' format');
}

export async function readReference(ref, limit, signal = AbortSignal.timeout(30000)) {
  signal.throwIfAborted();
  let bytes;
  if(ref.url.startsWith('data:')) {
    const match=/^data:((?:image|video|audio)\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(ref.url);
    if(!match || match[1].split('/')[0]!==ref.type || match[2].length%4!==0 || match[2].length>Math.ceil(limit/3)*4) throw new Error('Invalid reference data URL or size');
    bytes=Buffer.from(match[2],'base64');
    if(bytes.toString('base64')!==match[2]) throw new Error('Invalid reference base64');
  } else {
    let url = new URL(ref.url);
    for(let hop=0;hop<5;hop++) {
      const address=await publicAddress(url,lookup,signal);
      const result=await new Promise((resolve,reject)=>{
        const req=request(url,{signal,agent:false,headers:{Accept:'*/*'},lookup:(host,options,callback)=>{
          if(options.all) callback(null,[{address,family:4}]);else callback(null,address,4);
        }},res=>{
          if([301,302,303,307,308].includes(res.statusCode)) { const redirect=res.headers.location;res.resume();resolve({redirect});return; }
          if(res.statusCode!==200 || Number(res.headers['content-length'])>limit || res.headers['content-encoding'] && res.headers['content-encoding']!=='identity') {res.destroy();reject(new Error('Reference download rejected'));return;}
          const chunks=[];let size=0;
          res.on('data',chunk=>{size+=chunk.length;if(size>limit){res.destroy(new Error('Reference size exceeds limit'));}else chunks.push(chunk);});
          res.on('end',()=>resolve({bytes:Buffer.concat(chunks)}));res.on('error',reject);
        });
        req.on('error',()=>reject(new Error('Reference download failed')));req.end();
      });
      if(result.bytes) {bytes=result.bytes;break;}
      if(!result.redirect) throw new Error('Invalid reference redirect');
      url=new URL(result.redirect,url);
    }
  }
  if(!bytes || !bytes.length || bytes.length>limit) throw new Error('Reference is empty or exceeds size limit');
  return {bytes,extension:detectInput(bytes,ref.type)};
}
