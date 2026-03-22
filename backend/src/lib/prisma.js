import { PrismaClient } from '@prisma/client';
import { createClient } from '@libsql/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const url = process.env.DATABASE_URL || 'file:./dev.db';

const libsql = createClient({ url });
const adapter = new PrismaLibSql(libsql);
const prisma = new PrismaClient({ adapter });

export default prisma;