import { existsSync } from "node:fs";

// Tests run against a real Postgres (see README). Load DATABASE_URL from .env.
if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
