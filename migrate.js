import fs from "node:fs/promises";
import bcrypt from "bcryptjs";
import { query, pool } from "./db.js";

const sql = await fs.readFile(new URL("./migrations/001_init.sql", import.meta.url), "utf8");
await query(sql);

const login = process.env.ADMIN_LOGIN || "admin";
const password = process.env.ADMIN_INITIAL_PASSWORD;
if (!password) throw new Error("ADMIN_INITIAL_PASSWORD is required");
const hash = await bcrypt.hash(password, 12);
await query(
  `INSERT INTO users (login, display_name, password_hash, role, must_change_password)
   VALUES ($1, $2, $3, 'admin', true)
   ON CONFLICT (login) DO NOTHING`,
  [login.toLowerCase(), "Администратор", hash],
);
await pool.end();
console.log("Database is ready");
