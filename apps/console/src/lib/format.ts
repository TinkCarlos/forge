const pad = (n: number) => String(n).padStart(2, "0");

/** DESIGN.md §8：列表显示 MM-DD HH:mm，悬停给完整时间和时区。 */
export function shortTime(value: string | null | undefined): { text: string; title?: string } {
  if (!value) return { text: "—" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { text: String(value) };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    text: `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    title: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}（${tz}）`,
  };
}

export const versionLabel = (version: number | string | null | undefined) => (version == null || version === "" ? "—" : `v${version}`);
