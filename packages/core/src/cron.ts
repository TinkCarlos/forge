/**
 * Cron macros that are accepted and rewritten to the standard 5-field form (minute hour day month weekday). Any other
 * "@..." (e.g. @reboot) is returned unchanged and then fails the 5-field check.
 */
export const CRON_MACROS: Readonly<Record<string, string>> = Object.freeze({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
});

/** 400 message for a cron that is neither 5-field nor one of CRON_MACROS. */
export const CRON_INVALID_MESSAGE = "只支持 5 段 cron 或 @yearly/@annually/@monthly/@weekly/@daily/@midnight/@hourly";

/**
 * The single cron normalizer, shared by schedule create / PATCH, /enable and the scheduler's read side: trim; a macro
 * (case-insensitive) becomes its 5-field expression; anything else is only trimmed (case and inner spacing untouched).
 */
export function normalizeCron(cron: string): string {
  const trimmed = cron.trim();
  if (!trimmed.startsWith("@")) return trimmed;
  return CRON_MACROS[trimmed.toLowerCase()] ?? trimmed;
}
