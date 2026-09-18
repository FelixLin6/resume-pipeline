// Tiny static file server for the local HTML fixtures.
//
// Why a server rather than file:// — iframes and localStorage need a real
// origin, and the iCIMS fixtures are all about the nested frame. No network
// access: this binds 127.0.0.1 on an ephemeral port and serves one directory.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function serveFixtures(dir = FIXTURES) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.join(dir, name);
    // Never serve outside the fixture directory.
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        url: (n) => `http://127.0.0.1:${port}/${n}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
