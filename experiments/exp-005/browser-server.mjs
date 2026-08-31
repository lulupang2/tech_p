// EXP-005 control: launch a browser server on Node, publish its ws endpoint.
// Lets us test whether a non-Node runtime can drive the browser over websocket
// instead of the default --remote-debugging-pipe transport.
import fs from 'node:fs';
import { chromium } from 'playwright';

const opts = { headless: true };
if (process.env.PW_CHROMIUM_PATH) opts.executablePath = process.env.PW_CHROMIUM_PATH;

const server = await chromium.launchServer(opts);
fs.writeFileSync('ws-endpoint.txt', server.wsEndpoint(), 'utf8');
console.log('ws endpoint written');

process.on('SIGTERM', async () => { await server.close(); process.exit(0); });
process.on('SIGINT', async () => { await server.close(); process.exit(0); });
setTimeout(async () => { await server.close(); process.exit(0); }, 120000);
