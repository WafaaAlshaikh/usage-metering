import type { FastifyInstance, FastifyRequest  } from 'fastify';
import type { Db } from '../../db/client';
import { assignAccountPlan, registerAccount } from '../../services/accounts';
import { createAccountBody } from '../schemas/accounts';
import { accountView } from '../views';
import { findPlanById } from '../../repo/plans';
import { assignPlanBody } from '../schemas/plans';

export function accountsPublicRoutes(
  app: FastifyInstance,
  deps: { db: Db; adminAuth: (req: FastifyRequest) => Promise<void> },
): void {
  app.post('/accounts', { preHandler: deps.adminAuth }, async (req, reply) => {
    const body = createAccountBody.parse(req.body);
    const account = await registerAccount(deps.db, body);
    return reply.status(201).send(account);
  });
}

export function accountRoutes(app: FastifyInstance, deps: { db: Db }): void {
  const { db } = deps;

  app.get('/account', async (req) => {
    const account = req.account!;
    const plan = await findPlanById(db, account.accountPlanId);
    return accountView(account, plan!);
  });

  app.put('/account/plan', async (req) => {
    const { planId } = assignPlanBody.parse(req.body);
    const { account, plan } = await assignAccountPlan(db, req.account!.id, planId);
    return accountView(account, plan);
  });
}