import "dotenv/config";
import { parseConfig, type Config } from "./config-schema";

// The schema and parseConfig live in ./config-schema (pure: no dotenv, no process.env, no import side effects) so they
// can be unit-tested without a .env or a database. This module keeps the startup behaviour: load .env, validate once,
// and throw (process exits with rc=1) on invalid configuration.
export * from "./config-schema";

export function loadConfig(): Config {
  return parseConfig(process.env);
}

export const config = loadConfig();
