/**
 * test/openapiImport.test.js — Phase 9 deterministic OpenAPI import.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenApiSpecText, openApiToEndpoints, importOpenApiFromText } from '../src/services/openapiImport.js';

const OAS3 = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/users/login': {
      post: {
        summary: 'Login',
        requestBody: {
          content: { 'application/json': { schema: { properties: { email: { type: 'string' }, password: { type: 'string' }, attempts: { type: 'integer' } } } } },
        },
      },
    },
    '/products/search': {
      get: {
        parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
      },
    },
    '/products/{id}': {
      delete: {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
};

describe('parseOpenApiSpecText', () => {
  it('parses JSON', () => {
    const spec = parseOpenApiSpecText(JSON.stringify(OAS3));
    assert.equal(spec.info.title, 'Test API');
  });

  it('parses YAML', () => {
    const yaml = [
      'openapi: 3.0.0',
      'info: { title: YAML API, version: 1.0.0 }',
      'paths:',
      '  /ping:',
      '    get: { summary: ping }',
    ].join('\n');
    const spec = parseOpenApiSpecText(yaml);
    assert.equal(spec.info.title, 'YAML API');
  });

  it('throws a usage-oriented error on garbage', () => {
    assert.throws(() => parseOpenApiSpecText('::: not a spec :::'), /neither valid JSON nor YAML|no paths/i);
  });

  it('throws when the spec has no paths', () => {
    assert.throws(() => parseOpenApiSpecText(JSON.stringify({ openapi: '3.0.0', info: {} })), /no paths/);
  });
});

describe('openApiToEndpoints', () => {
  it('maps paths × methods to apiEndpoints with query params and materialized bodies', () => {
    const { endpoints, version, title } = openApiToEndpoints(OAS3, { targetUrl: 'http://localhost:3000' });
    assert.equal(version, '3.0.0');
    assert.equal(title, 'Test API');
    assert.equal(endpoints.length, 3);

    const login = endpoints.find(e => e.path === '/users/login');
    assert.equal(login.method, 'POST');
    assert.equal(login.body.email, 'qp-sample');
    assert.equal(login.body.password, 'qp-sample');
    assert.equal(login.body.attempts, 1);

    const search = endpoints.find(e => e.path === '/products/search');
    assert.equal(search.method, 'GET');
    assert.equal(search.queryParams.q, 'qp-sample');

    const del = endpoints.find(e => e.method === 'DELETE');
    assert.ok(del, 'DELETE operations are imported');
  });

  it('resolves a relative server URL against the target origin (same-origin baseUrl)', () => {
    const { endpoints } = openApiToEndpoints(OAS3, { targetUrl: 'http://localhost:3000' });
    const login = endpoints.find(e => e.path === '/users/login');
    assert.equal(login.baseUrl, 'http://localhost:3000/api/v1');
  });

  it('omits baseUrl when the spec has no servers', () => {
    const spec = { ...OAS3, servers: undefined };
    const { endpoints } = openApiToEndpoints(spec, { targetUrl: 'http://localhost:3000' });
    assert.equal(endpoints.every(e => e.baseUrl === undefined), true);
  });
});

describe('importOpenApiFromText', () => {
  it('round-trips text → spec → endpoints', () => {
    const { endpoints } = importOpenApiFromText(JSON.stringify(OAS3), { targetUrl: 'http://localhost:3000' });
    assert.equal(endpoints.length, 3);
  });

  it('throws when the spec yields no endpoints', () => {
    // A spec with paths but no supported operations (head/trace only).
    const headOnly = JSON.stringify({ openapi: '3.0.0', info: {}, paths: { '/x': { head: {} } } });
    assert.throws(() => importOpenApiFromText(headOnly), /no endpoints/);
  });
});
