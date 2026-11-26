// Provider Ledger service: runs under the host's Node on 127.0.0.1, reachable
// only through OpenChamber's proxy and its quota and OpenCode roles.
import http from 'node:http';

import { createService } from './app.ts';
import { defaultStorePath } from './store.ts';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const service = await createService({
  token,
  storePath: defaultStorePath(),
  opencodeUrl: process.env.OPENCHAMBER_OPENCODE_URL,
});

const server = http.createServer((req, res) => {
  void service.handle(req, res);
});
server.listen(port, '127.0.0.1');

const shutdown = (): void => {
  server.close();
  void service.persist().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
