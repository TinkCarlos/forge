import { checkTestDatabase } from "../scripts/db-guard.js";

// OPS-026: refuse to start the test run unless TEST_DATABASE_URL points at a *_test database.
export default function setup(): void {
  const result = checkTestDatabase(process.env);
  if (!result.ok) throw new Error(`[test DB guard] ${result.reason}`);
}
