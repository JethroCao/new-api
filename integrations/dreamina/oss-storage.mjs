import OSS from 'ali-oss';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';

export function validateOSSConfig(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['bucket','region','prefix','internal','signedUrlSeconds'].includes(key))) throw Error('Invalid OSS configuration');
  const c = {prefix:'prod/videos',internal:true,signedUrlSeconds:86400,...input};
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket || '') ||
      !/^oss-[a-z]+-[a-z0-9-]+$/.test(c.region || '') || typeof c.internal !== 'boolean' ||
      typeof c.prefix !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(c.prefix) || c.prefix.length > 128 ||
      !Number.isSafeInteger(c.signedUrlSeconds) || c.signedUrlSeconds < 60 || c.signedUrlSeconds > 604800) throw Error('Invalid OSS configuration');
  return c;
}

// Credentials remain in this process, never in job payloads or plugin sources.
export class OSSStorage {
  static fromEnvironment(config, env = process.env) {
    const accessKeyId = env.DREAMINA_OSS_ACCESS_KEY_ID;
    const accessKeySecret = env.DREAMINA_OSS_ACCESS_KEY_SECRET;
    if (!accessKeyId || !accessKeySecret) throw Error('Set DREAMINA_OSS_ACCESS_KEY_ID and DREAMINA_OSS_ACCESS_KEY_SECRET');
    const options = {bucket:config.bucket,region:config.region,accessKeyId,accessKeySecret,
      authorizationV4:true,secure:true,timeout:120000};
    return new OSSStorage(config,new OSS({...options,internal:config.internal}),new OSS({...options,internal:false}));
  }

  constructor(config, client, signer) { this.config=config; this.client=client; this.signer=signer; }

  assertDestination(destination) {
    if (destination.bucket !== this.config.bucket || destination.region !== this.config.region) throw Error('OSS destination does not match the original task');
  }

  async verify(object) {
    this.assertDestination(object);
    const result=await this.client.head(object.key);
    const h=result.res.headers;
    if (Number(h['content-length']) !== object.size || h['x-oss-meta-sha256'] !== object.sha256) throw Error('OSS object integrity mismatch');
    return result;
  }

  async upload(file, path, destination, key) {
    this.assertDestination(destination);
    const object={bucket:destination.bucket,region:destination.region,key,size:file.size,sha256:file.sha256};
    // A PUT may have succeeded before its response or local checkpoint was lost.
    try { await this.verify(object); return {...object,uploaded_at:Math.floor(Date.now()/1000)}; }
    catch(error) { if (error.status !== 404) throw error; }
    const handle=await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
    let stream;
    try {
      const info=await handle.stat();
      if (!info.isFile() || info.size !== file.size) throw Error('Local video size mismatch');
      const sha=createHash('sha256'),md5=createHash('md5');
      for await (const chunk of handle.createReadStream({start:0,autoClose:false})) {sha.update(chunk);md5.update(chunk);}
      if (sha.digest('hex') !== file.sha256) throw Error('Local video digest mismatch');
      stream=handle.createReadStream({start:0,autoClose:false});
      try {
        await this.client.putStream(key,stream,{contentLength:file.size,headers:{
          'Content-Type':file.mime,'Content-MD5':md5.digest('base64'),'x-oss-object-acl':'private',
          'x-oss-forbid-overwrite':'true','x-oss-meta-sha256':file.sha256,
        }});
      } catch(error) {
        if(error.status !== 409) throw error;
      }
      await this.verify(object);
      return {...object,uploaded_at:Math.floor(Date.now()/1000)};
    } finally { stream?.destroy(); await handle.close(); }
  }

  async sign(object, seconds, method='GET') {
    this.assertDestination(object);
    return this.signer.signatureUrlV4(method,seconds,{},object.key);
  }
}
