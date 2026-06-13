// Single shared Prisma client for the whole server.
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
