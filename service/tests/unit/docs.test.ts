import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import { buildApp } from '../../src/app';
import type { Db } from '../../src/db/client';
import { buildOpenApi } from '../../src/http/docs/openapi';
import { registerDocumentation } from '../../src/http/docs/register';
import { consumeBody } from '../../src/http/schemas/consume';
import { schemaOf } from '../../src/http/docs/schemas';
import type { OpenAPIV3 } from 'openapi-types';

const instances: FastifyInstance[] = [];
const neverDb = new Proxy({}, {
  get() { throw new Error('Documentation and missing-key checks must not access the database'); },
}) as Db;
function app(adminToken?: string) {
  const instance = buildApp({
    db: neverDb,
    config: { DATABASE_URL: 'unused', PORT: 3000, DB_POOL_MAX: 20, LOG_LEVEL: 'silent', ADMIN_TOKEN: adminToken },
  });
  instances.push(instance);
  return instance;
}
afterEach(async () => { await Promise.all(instances.splice(0).map(a => a.close())); });

describe('public API documentation', () => {
  it('serves Swagger HTML, local assets, JSON and YAML without a database or credentials', async () => {
    const server = app('test-only-not-a-real-token');
    const ui = await server.inject('/docs/');
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toContain('swagger-ui');
    expect(ui.headers['content-security-policy']).toContain("style-src-attr 'unsafe-inline'");
    expect(ui.headers['content-security-policy']).toContain("script-src-attr 'none'");
    for (const path of ['/docs/static/swagger-ui.css', '/docs/static/swagger-ui-bundle.js']) {
      expect((await server.inject(path)).statusCode).toBe(200);
    }
    const json = await server.inject('/openapi.json');
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-disposition']).toContain('openapi.json');
    expect(json.headers['cache-control']).toBe('no-store');
    expect(json.json().openapi).toBe('3.0.3');
    expect(json.body).not.toContain('test-only-not-a-real-token');
    const yaml = await server.inject('/openapi.yaml');
    expect(yaml.statusCode).toBe(200);
    expect(yaml.headers['content-disposition']).toContain('openapi.yaml');
    expect(yaml.body).toContain('openapi: 3.0.3');
    expect((await server.inject('/docs/json')).json()).toEqual(json.json());
  });

  it('describes every actual business route and no nonexistent business route', async () => {
    const server = app();
    const actual = new Set(['GET /health', 'POST /accounts', 'GET /account', 'PUT /account/plan']);
    // buildApp registers these synchronous routes before returning; encapsulated routes
    // are captured during ready(). Ignore automatic HEAD routes and docs assets.
    server.addHook('onRoute', route => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD' || route.url.startsWith('/docs') || route.url.startsWith('/openapi')) continue;
        actual.add(`${method} ${route.url.replace(/:([^/]+)/g, '{$1}')}`);
      }
    });
    await server.ready();
    const doc = (await server.inject('/openapi.json')).json() as OpenAPIV3.Document;
    const described = new Set<string>();
    const ids: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const operation = item?.[method];
        if (!operation) continue;
        described.add(`${method.toUpperCase()} ${path}`);
        ids.push(operation.operationId!);
        expect(operation.summary).toBeTruthy();
        expect(operation.responses).toHaveProperty('500');
      }
    }
    expect(described).toEqual(actual);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('reflects optional admin authentication without exposing credentials', () => {
    const protectedDoc = buildOpenApi(true);
    expect(protectedDoc.security).toEqual([{ ApiKey: [] }]);
    expect(protectedDoc.paths['/health']!.get!.security).toEqual([]);
    expect(protectedDoc.paths['/accounts']!.post!.security).toEqual([{ AdminToken: [] }]);
    expect(buildOpenApi(false).paths['/accounts']!.post!.security).toEqual([]);
    expect(protectedDoc.components!.securitySchemes!.ApiKey).toMatchObject({ in: 'header', name: 'x-api-key' });
  });

  it('does not bypass authentication on existing business routes', async () => {
    const server = app('required-test-token');
    for (const path of ['/account', '/users', '/plans', '/usage', '/history']) {
      const result = await server.inject(path);
      expect(result.statusCode).toBe(401);
      expect(result.json().error.code).toBe('unauthorized');
    }
    for (const path of ['/accounts', '/consume']) {
      const result = await server.inject({ method: 'POST', url: path, payload: {} });
      expect(result.statusCode).toBe(401);
    }
  });

  it('reuses Zod request constraints and preserves wire formats for transformed queries', () => {
    const doc = buildOpenApi(false);
    const request = doc.paths['/consume']!.post!.requestBody as OpenAPIV3.RequestBodyObject;
    expect(request.content['application/json'].schema).toEqual(schemaOf(consumeBody));
    const units = (request.content['application/json'].schema as OpenAPIV3.SchemaObject).properties!.units;
    expect(units).toMatchObject({ type: 'integer', maximum: 1_000_000_000_000 });
    const history = doc.paths['/history']!.get!.parameters as OpenAPIV3.ParameterObject[];
    expect(history.find(p => p.name === 'accepted')!.schema).toMatchObject({ type: 'string', enum: ['true', 'false'] });
    expect(history.find(p => p.name === 'period')!.schema).toMatchObject({ type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' });
    const patch = doc.paths['/plans/{id}']!.patch!.requestBody as OpenAPIV3.RequestBodyObject;
    expect(patch.content['application/json'].schema).toHaveProperty('minProperties', 1);
  });

  it('documents accepted/rejected/replayed outcomes and create/edit/delete response differences', () => {
    const doc = buildOpenApi(false);
    const response = doc.paths['/consume']!.post!.responses['200'] as OpenAPIV3.ResponseObject;
    const examples = response.content!['application/json'].examples!;
    expect(Object.keys(examples)).toEqual(['accepted', 'rejected', 'replayed']);
    expect((examples.rejected as OpenAPIV3.ExampleObject).value.accepted).toBe(false);
    expect(doc.paths['/users']!.post!.responses).toHaveProperty('200');
    expect(doc.paths['/users']!.post!.responses).toHaveProperty('201');
    expect(doc.paths['/users/{externalId}']!.delete!.responses['204']).not.toHaveProperty('content');
    expect(doc.paths['/plans/{id}']!.delete!.responses['200']).toHaveProperty('content');
  });

  it('resolves all local references and declares each path parameter', () => {
    const doc = buildOpenApi(true);
    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      if ('$ref' in value) {
        const ref = String(value.$ref);
        expect(ref.startsWith('#/')).toBe(true);
        let target: unknown = doc;
        for (const key of ref.slice(2).split('/')) target = (target as Record<string, unknown>)?.[key];
        expect(target, ref).toBeDefined();
      }
      Object.values(value).forEach(walk);
    };
    walk(doc);
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        expect(item!.parameters).toEqual(expect.arrayContaining([expect.objectContaining({
          name: match[1], in: 'path', required: true,
        })]));
      }
    }
  });

  it('offers a clearly labelled preview with execution disabled and no mock API', async () => {
    const server = Fastify();
    instances.push(server);
    registerDocumentation(server, { adminTokenRequired: true, previewOnly: true });
    const result = await server.inject('/openapi.json');
    expect(result.json().info.description).toContain('Documentation-only preview');
    expect((await server.inject({ method: 'POST', url: '/consume', payload: {} })).statusCode).toBe(404);
    const init = await server.inject('/docs/static/swagger-initializer.js');
    expect(init.statusCode).toBe(200);
    expect(init.body).toMatch(/"supportedSubmitMethods"\s*:\s*\[\]/);
    expect(init.body).toMatch(/"persistAuthorization"\s*:\s*false/);
  });
});
