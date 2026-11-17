/**
 * services/openapiImport.js — deterministic endpoint import from an OpenAPI
 * (3.x) or Swagger (2.0) document.
 *
 * `--openapi <file>` replaces the LLM-inferred API surface with the spec's:
 * every path × method becomes a plan apiEndpoint, with query params sampled
 * and JSON request bodies materialized from the schema (examples > defaults >
 * type dummies). Deterministic — the same spec always produces the same plan.
 *
 * Relative `servers[0].url` (e.g. '/b2b/v2') is resolved against the scan
 * target's origin into endpoint.baseUrl — same-origin, so plan URL
 * validation still holds.
 */

import { parse as parseYaml } from 'yaml';

/**
 * Parse a spec document (JSON or YAML). Throws a usage-oriented error when
 * the document is unreadable or has no paths.
 */
export function parseOpenApiSpecText(text) {
  let spec;
  try {
    spec = JSON.parse(text);
  } catch {
    try {
      spec = parseYaml(text);
    } catch (err) {
      throw new Error(`OpenAPI spec is neither valid JSON nor YAML: ${err.message}`);
    }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('OpenAPI spec is not an object');
  }
  if (!spec.paths || typeof spec.paths !== 'object' || Object.keys(spec.paths).length === 0) {
    throw new Error('OpenAPI spec has no paths');
  }
  return spec;
}

function sampleForSchema(schema) {
  if (!schema || typeof schema !== 'object') return 'qp-sample';
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'integer':
    case 'number':
      return typeof schema.default === 'number' ? schema.default : 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'qp-sample';
  }
}

/** Materialize a JSON request body from an OAS schema (shallow). */
function sampleBodyFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 2) return {};
  if (schema.example !== undefined && typeof schema.example === 'object') return schema.example;
  const props = schema.properties;
  if (!props || typeof props !== 'object') return {};
  const body = {};
  for (const [name, prop] of Object.entries(props)) {
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
    if (type === 'object') body[name] = sampleBodyFromSchema(prop, depth + 1);
    else if (type === 'array') body[name] = [];
    else body[name] = sampleForSchema(prop);
  }
  return body;
}

function requestBodyFor(operation, pathItem) {
  // OAS 3: requestBody.content['application/json'].schema
  const rb = operation.requestBody?.content?.['application/json']?.schema;
  if (rb) return sampleBodyFromSchema(rb);
  // Swagger 2: body parameter with a schema
  const bodyParam = (operation.parameters || []).find((p) => p.in === 'body' && p.schema);
  if (bodyParam) return sampleBodyFromSchema(bodyParam.schema);
  return null;
}

function queryParamsFor(operation, pathItem) {
  const params = [...(pathItem.parameters || []), ...(operation.parameters || [])];
  const query = {};
  for (const p of params) {
    if (p?.in === 'query' && p.name) query[p.name] = sampleForSchema(p.schema || p);
  }
  return query;
}

/**
 * Map a parsed spec to plan apiEndpoints.
 *
 * @param {object} spec  — parsed OpenAPI/Swagger document
 * @param {object} opts
 * @param {string} opts.targetUrl — the scan target; relative server URLs are
 *        resolved against its origin into endpoint.baseUrl (same-origin).
 * @returns {{ endpoints: object[], version: string|null, title: string|null }}
 */
export function openApiToEndpoints(spec, { targetUrl } = {}) {
  const endpoints = [];
  let origin = null;
  if (targetUrl) {
    try { origin = new URL(targetUrl).origin; } catch { origin = null; }
  }
  const serverUrl = Array.isArray(spec.servers) && spec.servers[0]?.url
    ? String(spec.servers[0].url)
    : null;

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      let baseUrl;
      if (serverUrl && !/^https?:/i.test(serverUrl) && origin) {
        baseUrl = origin + (serverUrl.startsWith('/') ? serverUrl : `/${serverUrl}`);
      }

      const endpoint = {
        method: method.toUpperCase(),
        path,
        ...(baseUrl ? { baseUrl } : {}),
        queryParams: queryParamsFor(operation, pathItem),
        ...(requestBodyFor(operation, pathItem) !== null ? { body: requestBodyFor(operation, pathItem) } : {}),
        headers: {},
        description: `OpenAPI import${spec.info?.title ? ` (${spec.info.title})` : ''}${operation.summary ? `: ${operation.summary}` : ''}`,
      };
      endpoints.push(endpoint);
    }
  }

  return {
    endpoints,
    version: spec.openapi || spec.swagger || null,
    title: spec.info?.title || null,
  };
}

/** Convenience: text → parsed spec → endpoints (validation included). */
export function importOpenApiFromText(text, opts = {}) {
  const spec = parseOpenApiSpecText(text);
  const result = openApiToEndpoints(spec, opts);
  if (result.endpoints.length === 0) {
    throw new Error('OpenAPI import produced no endpoints — the spec declares no supported operations');
  }
  return result;
}
