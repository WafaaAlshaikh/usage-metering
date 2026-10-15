import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/client';
import { NotFoundError, GoneError } from '../../domain/errors';
import { findUserWithPlan, listUsersWithPlans } from '../../repo/users';
import { assignUserPlan, registerUser, removeUser } from '../../services/users';
import { assignPlanBody } from '../schemas/plans';
import { createUserBody, listUsersQuery, userParams } from '../schemas/users';
import { userView } from '../views';

export function usersRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.post('/users', async (req, reply) => {
    const body = createUserBody.parse(req.body);
    const { user, created } = await registerUser(db, { accountId: req.account!.id, ...body });
    return reply.status(created ? 201 : 200).send({
      userId: user.externalId,
      planId: user.userPlanId,
      createdAt: user.createdAt,
      reactivated: !created,
    });
  });

  app.get('/users', async (req) => {
    const q = listUsersQuery.parse(req.query);
    const rows = await listUsersWithPlans(db, req.account!.id, q.limit, q.after);
    const page = rows.slice(0, q.limit);
    return {
      users: page.map((r) => userView(r.user, r.plan)),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.user.externalId : null,
    };
  });

  app.get('/users/:externalId', async (req) => {
    const { externalId } = userParams.parse(req.params);
    const row = await findUserWithPlan(db, req.account!.id, externalId);
    if (!row) throw new NotFoundError(`User "${externalId}" is not registered for this account`);
    if (row.user.deletedAt) throw new GoneError(`User "${externalId}" has been deleted`);
    return userView(row.user, row.plan);
  });

  app.put('/users/:externalId/plan', async (req) => {
    const { externalId } = userParams.parse(req.params);
    const { planId } = assignPlanBody.parse(req.body);
    const { user, plan } = await assignUserPlan(db, { accountId: req.account!.id, externalId, planId });
    return userView(user, plan);
  });

  app.delete('/users/:externalId', async (req, reply) => {
    const { externalId } = userParams.parse(req.params);
    await removeUser(db, req.account!.id, externalId);
    return reply.status(204).send();
  });
}