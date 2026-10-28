import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Bridge, validateConfig, createServer } from './bridge.mjs';

let bridge, server, timer, stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  if (server) await new Promise(done => { server.close(done); server.closeIdleConnections(); });
  if (bridge) await bridge.close();
  process.exitCode = exitCode;
}

try {
  if (!process.env.DREAMINA_BRIDGE_CONFIG) throw new Error('Set DREAMINA_BRIDGE_CONFIG to your configuration JSON path');
  const input = JSON.parse(await readFile(resolve(process.env.DREAMINA_BRIDGE_CONFIG), 'utf8'));
  const config = validateConfig({ ...input, token: process.env.DREAMINA_BRIDGE_TOKEN });
  // Preflight never creates a canvas, changes space, authorizes a debit, or
  // starts a login flow. The operator prepares a dedicated CLI profile.
  const probe = new Bridge(config);
  await probe.preflight();
  if (process.argv.includes('--check')) {
    console.log('Dreamina context and model configuration verified (no generation performed).');
  } else {
    bridge = await Bridge.open(config);
    bridge.promptLimits = probe.promptLimits;
    server = createServer(bridge);
    await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, config.host, done); });
    console.log('Dreamina bridge listening on ' + config.host + ':' + config.port);
    async function poll() {
      if (stopping) return;
      try { await bridge.tick(); } catch {
        console.error('Job persistence failed; bridge stopped to protect submission identities.');
        await stop(1); return;
      }
      if (!stopping) timer = setTimeout(poll, config.pollMs);
    }
    timer = setTimeout(poll, 0);
    process.once('SIGINT', () => void stop());
    process.once('SIGTERM', () => void stop());
  }
} catch (error) {
  // Configuration/preflight failures contain only our own messages. Never
  // print upstream responses, subprocess stderr, environment or credentials.
  console.error(error.code === 'EEXIST' ? 'Data directory locked. Verify its recorded PID has stopped before removing .lock.' : error.message);
  await stop(1);
}
