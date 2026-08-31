export type ReportTheme = "day" | "night";

export const REPORT_THEME_PALETTES = {
  day: {
    background: "#fffefa",
    decoration: "#e4f0e7",
    decorationStrong: "#d3e6d8",
    surface: "#f3f6f2",
    surfaceAlt: "#e9f0eb",
    border: "#c7d7cb",
    text: "#263b31",
    strong: "#102019",
    muted: "#5f7168",
    accent: "#0b7540",
    chart: ["#087443", "#176fa6", "#9b6500", "#7450a8", "#b93b36", "#187882", "#a23b72", "#567d20"],
  },
  night: {
    background: "#07110d",
    decoration: "#123325",
    decorationStrong: "#17432f",
    surface: "#10211a",
    surfaceAlt: "#0d1b16",
    border: "#28483a",
    text: "#dce9e1",
    strong: "#eff8f2",
    muted: "#9cb3a8",
    accent: "#76e6ad",
    chart: ["#66e2a3", "#67c8ff", "#ffd166", "#b997ff", "#ff7b72", "#8de1e8", "#f7a8d8", "#b7db7b"],
  },
} as const;

export function resolveReportTheme(theme: string | undefined): ReportTheme {
  return theme === "day" ? "day" : "night";
}

export function currentReportTheme(): ReportTheme {
  return resolveReportTheme(typeof document === "undefined" ? undefined : document.documentElement.dataset.theme);
}
