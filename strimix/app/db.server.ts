import { PrismaClient } from "@prisma/client";

/**
 * Avoid `declare global` + `var` — some TS versions infer a PrismaClient variant
 * that omits newly generated delegates until the IDE restarts. Pattern from Prisma docs.
 */
const globalForPrisma = globalThis as unknown as {
  strimixPrisma: PrismaClient | undefined;
};

/** Explicit annotation so delegates (e.g. `customerDataRequest`) stay on the type. */
export const prisma: PrismaClient =
  globalForPrisma.strimixPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.strimixPrisma = prisma;
}

export default prisma;