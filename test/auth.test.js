import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized, createTicket, csrfGuard } from '../dashboard/server.js';

function fakeReq(headers = {}, method = 'GET') {
  return { headers, method, url: '/api/runs' };
}

function fakeUrl(pathname, search = '') {
  return new URL(`http://localhost:8080${pathname}${search}`);
}

describe('isAuthorized', () => {
  const TOKEN = 'secret-key-123';

  it('is open when no token is configured', () => {
    assert.equal(isAuthorized(fakeReq(), fakeUrl('/api/runs'), ''), true);
  });

  it('accepts a matching Bearer header', () => {
    const req = fakeReq({ authorization: `Bearer ${TOKEN}` });
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), true);
  });

  it('rejects persistent ?token= query param to prevent URL credential leaks', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?token=' + TOKEN), TOKEN), false);
  });

  it('accepts a valid single-use ticket via ?ticket= query param on GET', () => {
    const ticket = createTicket();
    const req = fakeReq({}, 'GET');
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?ticket=' + ticket), TOKEN), true);
    // Single-use: consumed on first use
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?ticket=' + ticket), TOKEN), false);
  });

  it('rejects ticket on mutating method (POST)', () => {
    const ticket = createTicket();
    const req = fakeReq({}, 'POST');
    assert.equal(isAuthorized(req, fakeUrl('/api/runs?ticket=' + ticket), TOKEN), false);
  });

  it('rejects a wrong Bearer header', () => {
    const req = fakeReq({ authorization: 'Bearer wrong' });
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), false);
  });

  it('rejects missing credentials', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/api/runs'), TOKEN), false);
  });

  it('always allows /health', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/health'), TOKEN), true);
  });

  it('allows static assets (non-/api paths)', () => {
    const req = fakeReq({});
    assert.equal(isAuthorized(req, fakeUrl('/app.js'), TOKEN), true);
    assert.equal(isAuthorized(req, fakeUrl('/'), TOKEN), true);
  });
});

describe('csrfGuard', () => {
  function makeMockRes() {
    return {
      status: 200,
      headers: {},
      body: null,
      writeHead(code, headers) { this.status = code; Object.assign(this.headers, headers); },
      end(data) { this.body = data; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    };
  }

  it('allows safe methods (GET, HEAD, OPTIONS)', () => {
    const res = makeMockRes();
    const req = { method: 'GET', url: '/api/runs', headers: {} };
    assert.equal(csrfGuard(req, res), true);
  });

  it('blocks cross-site requests via Sec-Fetch-Site', () => {
    const res = makeMockRes();
    const req = {
      method: 'POST',
      url: '/api/runs',
      headers: {
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
    };
    assert.equal(csrfGuard(req, res), false);
    assert.equal(res.status, 403);
  });

  it('blocks requests with untrusted Origin header', () => {
    const res = makeMockRes();
    const req = {
      method: 'POST',
      url: '/api/runs',
      headers: {
        origin: 'https://attacker.evil',
        'content-type': 'application/json',
      },
    };
    assert.equal(csrfGuard(req, res), false);
    assert.equal(res.status, 403);
  });

  it('allows requests with allowed Origin header', () => {
    const res = makeMockRes();
    const req = {
      method: 'POST',
      url: '/api/runs',
      headers: {
        origin: 'http://localhost:3000',
        'content-type': 'application/json',
      },
    };
    assert.equal(csrfGuard(req, res), true);
  });

  it('blocks non-JSON Content-Type on mutating requests (HTML form submission)', () => {
    const res = makeMockRes();
    const req = {
      method: 'POST',
      url: '/api/runs',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': '25',
      },
    };
    assert.equal(csrfGuard(req, res), false);
    assert.equal(res.status, 415);
  });

  it('allows JSON Content-Type on mutating requests', () => {
    const res = makeMockRes();
    const req = {
      method: 'POST',
      url: '/api/runs',
      headers: {
        'content-type': 'application/json',
        'content-length': '20',
      },
    };
    assert.equal(csrfGuard(req, res), true);
  });
});
