/**
 * security/egressProxy.js — validating forward egress proxy.
 *
 * Enforces connect-time SSRF validation for all browsers (Chromium, Firefox, WebKit).
 * Every HTTP request and HTTPS CONNECT tunnel must resolve to public IP addresses via resolvePublic().
 * Any request to private subnets, link-local, loopback, or metadata endpoints is rejected (403 Forbidden).
 */
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';
import { resolvePublic } from '../services/ssrf.js';

let _activeProxy = null;
let _refCount = 0;

export function startEgressProxy(port = 0) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url);
      const addrs = await resolvePublic(u.hostname);
      const addr = addrs[0];
      const up = http.request(
        {
          host: addr.address,
          port: u.port || 80,
          path: u.pathname + u.search,
          method: req.method,
          headers: req.headers,
        },
        r => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        }
      );
      up.on('error', () => {
        try { res.writeHead(502).end('Bad Gateway'); } catch {}
        res.destroy();
      });
      req.on('error', () => up.destroy());
      req.pipe(up);
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('blocked');
    }
  });

  server.on('connect', async (req, sock, head) => {
    sock.on('error', () => {});
    try {
      let host;
      let p;
      if (req.url.startsWith('[')) {
        const endBracket = req.url.indexOf(']');
        host = req.url.slice(1, endBracket);
        p = req.url.slice(endBracket + 2);
      } else {
        const parts = req.url.split(':');
        host = parts[0];
        p = parts[1];
      }

      const addrs = await resolvePublic(host);
      const addr = addrs[0];
      const up = net.connect(+p || 443, addr.address, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on('error', () => {
        try { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch {}
        sock.destroy();
      });
      sock.on('error', () => up.destroy());
    } catch {
      try { sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {}
      sock.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
    server.on('error', reject);
  });
}

/**
 * Get or start a shared local egress proxy for browser instances.
 */
export async function getSharedEgressProxy() {
  _refCount++;
  if (!_activeProxy || !_activeProxy.listening) {
    _activeProxy = await startEgressProxy(0);
  }
  const addr = _activeProxy.address();
  return {
    server: _activeProxy,
    port: addr.port,
    proxyUrl: `http://127.0.0.1:${addr.port}`,
  };
}

export async function stopSharedEgressProxy() {
  _refCount = Math.max(0, _refCount - 1);
  if (_refCount === 0 && _activeProxy) {
    const s = _activeProxy;
    _activeProxy = null;
    if (typeof s.closeAllConnections === 'function') {
      s.closeAllConnections();
    }
    await new Promise(resolve => s.close(resolve));
  }
}
