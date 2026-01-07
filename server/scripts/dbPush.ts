import { ensureSchema, pool } from "../db";

const run = async () => {
  await ensureSchema();
  await pool.end();
  console.log("Database schema ensured.");
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
