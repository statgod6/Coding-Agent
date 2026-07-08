/**
 * Prisma client singleton.
 *
 * A single PrismaClient is shared across the whole process. In dev, we stash
 * it on `globalThis` so hot-reload (tsx watch) does not spawn a new client —
 * and a new connection pool — on every file change.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
