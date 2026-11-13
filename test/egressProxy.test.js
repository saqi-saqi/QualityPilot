import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { startEgressProxy, getSharedEgressProxy, stopSharedEgressProxy } from '../src/security/egressProxy.js';

describe('egressProxy', () => {
  let proxyServer;
  let proxyPort;

  before(async () => {
    proxyServer = await startEgressProxy(0);
    proxyPort = proxyServer.address().port;
  });

  after(async () => {
    await new Promise(resolve => proxyServer.close(resolve));
  });

  it('blocks HTTP requests to loopback addresses with 403', async () => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: 'http://127.0.0.1:8080/secret',
      method: 'GET',
    });

    const res = await new Promise((resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    });

    assert.equal(res.statusCode, 403);
    const body = await new Promise(resolve => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    assert.equal(body, 'blocked');
  });

  it('blocks HTTP CONNECT tunnels to loopback addresses with 403', async () => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write('CONNECT 127.0.0.1:8080 HTTP/1.1\r\nHost: 127.0.0.1:8080\r\n\r\n');
    });

    const response = await new Promise((resolve) => {
      sock.on('data', data => {
        resolve(data.toString());
        sock.destroy();
      });
    });

    assert.match(response, /HTTP\/1\.1 403 Forbidden/);
  });

  it('blocks CONNECT to private RFC1918 addresses', async () => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write('CONNECT 10.0.0.1:443 HTTP/1.1\r\nHost: 10.0.0.1:443\r\n\r\n');
    });

    const response = await new Promise((resolve) => {
      sock.on('data', data => {
        resolve(data.toString());
        sock.destroy();
      });
    });

    assert.match(response, /HTTP\/1\.1 403 Forbidden/);
  });

  it('shared proxy reference counting works properly', async () => {
    const p1 = await getSharedEgressProxy();
    assert(p1.port > 0);
    const p2 = await getSharedEgressProxy();
    assert.equal(p1.port, p2.port);

    await stopSharedEgressProxy();
    // Proxy should still be listening because refCount was 2
    assert.equal(p1.server.listening, true);

    await stopSharedEgressProxy();
    // Now closed
    assert.equal(p1.server.listening, false);
  });
});
