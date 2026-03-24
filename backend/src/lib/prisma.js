import { PrismaClient } from '@prisma/client';
import { createClient } from '@libsql/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const rawUrl = process.env.DATABASE_URL;
const url = rawUrl && rawUrl !== 'undefined' ? rawUrl : 'file:./dev.db';

const libsql = createClient({ url });
const adapter = new PrismaLibSql(libsql);
const prisma = new PrismaClient({ adapter });

export default prisma;