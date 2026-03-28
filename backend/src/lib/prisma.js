import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const rawUrl = process.env.DATABASE_URL;
const url = rawUrl && rawUrl !== 'undefined' ? rawUrl : 'file:./dev.db';
const authToken = process.env.TURSO_AUTH_TOKEN;

const adapter = new PrismaLibSql({ url, authToken });
const prisma = new PrismaClient({ adapter });

export default prisma;