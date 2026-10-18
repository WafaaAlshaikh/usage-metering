import type { OpenAPIV3 } from 'openapi-types';
import type { z } from 'zod';
import { createAccountBody } from '../schemas/accounts';
import { consumeBody } from '../schemas/consume';
import { historyQuery } from '../schemas/history';
import { assignPlanBody, createPlanBody, listPlansQuery, patchPlanBody, planIdParams } from '../schemas/plans';
import { usageQuery } from '../schemas/usage';
import { createUserBody, listUsersQuery, userParams } from '../schemas/users';
import { consumeExamples, responseSchemas, schemaOf } from './schemas';

type Operation = OpenAPIV3.OperationObject;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonResponse = (name: string, description: string): OpenAPIV3.ResponseObject => ({
  description, content: { 'application/json': { schema: ref(name) } },
});
const errorInfo: Record<number, [string, string]> = {
  400: ['Invalid body, query, path parameter, period, or cursor.', 'validation_error'],
  401: ['Missing or invalid API key or required admin token.', 'unauthorized'],
  403: ['Predefined plans are read-only.', 'plan_read_only'],
  404: ['Resource not found, including a resource owned by another account.', 'not_found'],
  409: ['Conflict. See the operation description for possible error codes.', 'conflict'],
  410: ['The user has been deleted.', 'gone'],
  500: ['Unexpected server error; internal details are not exposed.', 'internal_error'],
  503: ['Connection acquisition, lock, or statement timeout. Retry consumption with the same requestId.', 'busy'],
};
function errors(codes: number[]): OpenAPIV3.ResponsesObject {
  return Object.fromEntries(codes.map(code => [String(code), { $ref: `#/components/responses/Error${code}` }]));
}
function parameters(value: z.ZodType, location: 'query' | 'path'): OpenAPIV3.ParameterObject[] {
  const shape = schemaOf(value);
  return Object.entries(shape.properties ?? {}).map(([name, schema]) => ({
    name, in: location, required: location === 'path' || (shape.required ?? []).includes(name),
    schema: name === 'period'
      ? { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', example: '2026-10' }
      : schema,
    ...(name === 'period' ? { description: 'UTC calendar month, YYYY-MM. Defaults to the current month for /usage.' } : {}),
    ...(name === 'cursor' ? { description: 'Opaque nextCursor returned by /history; do not construct it yourself.' } : {}),
    ...(name === 'after' ? { description: 'The nextCursor returned by the previous page (last user ID).' } : {}),
  }));
}
function body(value: z.ZodType, example: unknown, nonempty = false): OpenAPIV3.RequestBodyObject {
  const schema = schemaOf(value);
  if (nonempty) schema.minProperties = 1;
  return { required: true, content: { 'application/json': { schema, example } } };
}
function op(
  operationId: string, tag: string, summary: string, description: string,
  response: string, extra: Partial<Operation> = {}, errorCodes = [400, 401],
): Operation {
  return {
    operationId, tags: [tag], summary, description,
    responses: { '200': jsonResponse(response, 'Success'), ...errors([...errorCodes, 500, 503]) },
    ...extra,
  };
}

export function buildOpenApi(adminTokenRequired: boolean, previewOnly = false): OpenAPIV3.Document {
  const paths: OpenAPIV3.PathsObject = {
    '/health': {
      get: op('getHealth', 'Health', 'Check service and database health',
        'Executes a database query. No authentication required.', 'Health', { security: [] }, []),
    },
    '/accounts': {
      post: op('createAccount', 'Accounts', 'Create an account and issue its API key',
        'The raw API key is returned once; save it securely. Defaults to Starter; planName may select another predefined account plan. '
        + (adminTokenRequired ? 'x-admin-token is required on this installation.' : 'ADMIN_TOKEN is unset: account creation is public on this installation.')
        + ' Account creation does not support requestId-based deduplication.',
        'CreatedAccount', {
          security: adminTokenRequired ? [{ AdminToken: [] }] : [],
          requestBody: body(createAccountBody, { name: 'Acme', planName: 'Starter' }),
          responses: { '201': jsonResponse('CreatedAccount', 'Created; raw apiKey is shown once'), ...errors([400, 401, 500, 503]) },
        }),
    },
    '/account': {
      get: op('getAccount', 'Accounts', 'Inspect the authenticated account', 'Returns the current account plan and limits.', 'Account', {}, [401]),
    },
    '/account/plan': {
      put: op('assignAccountPlan', 'Accounts', 'Switch the account plan',
        'Use a predefined account plan or your own custom account plan. Preserves consumption. Archived plans cannot be newly assigned (409 plan_archived).',
        'Account', { requestBody: body(assignPlanBody, { planId: '11111111-1111-4111-8111-111111111111' }) }, [400, 401, 404, 409]),
    },
    '/users': {
      get: op('listUsers', 'Users', 'List active users',
        'Ordered by external user ID. Pass nextCursor as after. Deleted users are omitted.',
        'Users', { parameters: parameters(listUsersQuery, 'query') }),
      post: op('registerUser', 'Users', 'Register or reactivate a user',
        'Defaults to Basic. An active duplicate returns 409 user_exists. Reactivation preserves usage; an explicitly supplied plan changes the assignment. An archived plan returns 409 plan_archived.',
        'RegisteredUser', {
          requestBody: body(createUserBody, { externalId: 'alice' }),
          responses: {
            '201': jsonResponse('RegisteredUser', 'Created (reactivated: false)'),
            '200': jsonResponse('RegisteredUser', 'Reactivated (reactivated: true)'),
            ...errors([400, 401, 404, 409, 500, 503]),
          },
        }),
    },
    '/users/{externalId}': {
      parameters: parameters(userParams, 'path'),
      get: op('getUser', 'Users', 'Inspect a user and their plan',
        'The external ID must belong to the authenticated account. Deleted users return 410.', 'User', {}, [400, 401, 404, 410]),
      delete: op('deleteUser', 'Users', 'Soft-delete a user',
        'Preserves usage and history. Repeating deletion is harmless; an unknown user returns 404.', 'User', {
          responses: { '204': { description: 'Deleted; no response body' }, ...errors([400, 401, 404, 500, 503]) },
        }),
    },
    '/users/{externalId}/plan': {
      parameters: parameters(userParams, 'path'),
      put: op('assignUserPlan', 'Users', 'Switch a user plan',
        'Preserves usage. Only predefined or account-owned user plans can be assigned. A newly assigned archived plan returns 409 plan_archived.',
        'User', { requestBody: body(assignPlanBody, { planId: '22222222-2222-4222-8222-222222222222' }) }, [400, 401, 404, 409, 410]),
    },
    '/plans': {
      get: op('listPlans', 'Plans', 'List visible plans', 'Predefined plans and this account’s custom plans; optionally include archived plans.',
        'Plans', { parameters: parameters(listPlansQuery, 'query') }),
      post: op('createPlan', 'Plans', 'Create a custom plan',
        'null means unlimited. Omitted limits default to null. Duplicate names within the same account and kind return 409 plan_name_taken.',
        'Plan', {
          requestBody: body(createPlanBody, { kind: 'user', name: 'Gold', monthlyAllowance: 2000, maxUnitsPerRequest: 100 }),
          responses: { '201': jsonResponse('Plan', 'Custom plan created'), ...errors([400, 401, 409, 500, 503]) },
        }),
    },
    '/plans/{id}': {
      parameters: parameters(planIdParams, 'path'),
      get: op('getPlan', 'Plans', 'Inspect a plan', 'Includes archived plans. Another account’s plan is indistinguishable from an unknown plan.',
        'Plan', {}, [400, 401, 404]),
      patch: op('updatePlan', 'Plans', 'Update a custom plan',
        'Supply at least one recognized field. Omitted fields stay unchanged; null removes a limit. Predefined plans return 403 plan_read_only; duplicate names return 409 plan_name_taken. Updates preserve usage and recorded decisions.',
        'Plan', { requestBody: body(patchPlanBody, { maxUnitsPerRequest: 50 }, true) }, [400, 401, 403, 404, 409]),
      delete: op('archivePlan', 'Plans', 'Archive a custom plan',
        'Soft delete, not removal. Existing assignments continue to work. New assignments are blocked, and the name remains reserved. Repeated archival is harmless.',
        'Plan', {}, [400, 401, 403, 404]),
    },
    '/consume': {
      post: op('consumeUnits', 'Consumption', 'Evaluate and record a consumption request',
        'Both account and user rules must allow the full amount. A quota rejection is HTTP 200 with accepted=false and consumes nothing. '
        + 'Failure priority: user per-request, account per-request, user monthly, account monthly. '
        + 'requestId is unique per account: same user and amount replay the original result; a different user or amount returns 409 idempotency_conflict. '
        + 'Retry timeouts using the same ID; use a new ID for a new action, including after a plan change. '
        + 'A saved result is replayed even if the user was deleted afterwards; new consumption for a deleted user returns 410.',
        'Consume', {
          requestBody: body(consumeBody, { userId: 'alice', units: 10, requestId: 'doc-8841' }),
          responses: {
            '200': { description: 'Accepted, rejected, or replayed decision', content: { 'application/json': { schema: ref('Consume'), examples: consumeExamples } } },
            ...errors([400, 401, 404, 409, 410, 500, 503]),
          },
        }),
    },
    '/usage': {
      get: op('getUsage', 'Usage', 'Inspect account and user usage for a month',
        'Defaults to the current UTC month. Account totals repeat on each page. Remaining allowance uses current plan limits even for past months; null means unlimited. Deleted users with usage remain visible. A plan switch does not reset counters.',
        'Usage', { parameters: parameters(usageQuery, 'query') }),
    },
    '/history': {
      get: op('getHistory', 'History', 'List recorded decisions',
        'Newest first. Filters are optional; without period, history spans months. Use nextCursor as cursor. Each decision preserves its original plan limits and remaining allowance. Unknown users return 404; deleted users’ history is retained.',
        'History', { parameters: parameters(historyQuery, 'query') }, [400, 401, 404]),
    },
  };
  return {
    openapi: '3.0.3',
    info: {
      title: 'Usage Metering & Quota Service', version: '1.0.0',
      description: (previewOnly ? '**Documentation-only preview. API execution is disabled here; run the complete service with PostgreSQL to try requests.**\n\n' : '')
        + 'Shared account limits, individual user quotas, and safe consumption retries. '
        + 'Create an account, copy its one-time apiKey, then use Authorize → ApiKey (raw key, no Bearer prefix). '
        + 'Examples contain illustrative IDs; replace them with IDs from your API responses.\n\n'
        + '**Try it out sends real requests and can consume units or modify data. Use a disposable demo account.** '
        + 'Credentials are not persisted between browser reloads. Health, documentation, and specification downloads are public.',
    },
    servers: [{ url: '/', description: 'Same origin as this documentation (no hardcoded host)' }],
    security: [{ ApiKey: [] }],
    tags: ['Health', 'Accounts', 'Users', 'Plans', 'Consumption', 'Usage', 'History'].map(name => ({ name })),
    paths,
    components: {
      securitySchemes: {
        ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'Account API key, issued once by POST /accounts. Do not include Bearer.' },
        AdminToken: { type: 'apiKey', in: 'header', name: 'x-admin-token', description: 'Configured ADMIN_TOKEN; only used to create accounts. Never put real tokens in this document.' },
      },
      schemas: responseSchemas,
      responses: Object.fromEntries(Object.entries(errorInfo).map(([status, [description, code]]) => [
        `Error${status}`, {
          description,
          content: { 'application/json': { schema: ref('Error'), ...(status === '409' ? {} : { example: { error: { code, message: description } } }) } },
          ...(status === '503' ? { headers: { 'Retry-After': { description: 'Seconds before retrying', schema: { type: 'string', example: '1' } } } } : {}),
        },
      ])),
    },
  };
}
