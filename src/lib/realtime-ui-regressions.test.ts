import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gameAppSource = readFileSync(fileURLToPath(new URL("../../app/GameApp.tsx", import.meta.url)), "utf8");
const globalCss = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

describe("realtime room UI regressions", () => {
  it("uses only browser-allowed WebSocket close codes", () => {
    const closeCodes = [
      ...[...gameAppSource.matchAll(/\.close\((\d{4})\b/g)].map((match) => Number(match[1])),
      Number(gameAppSource.match(/const CLIENT_RECONNECT_CLOSE_CODE = (\d{4})/)?.[1]),
    ];

    expect(closeCodes.every(Number.isFinite)).toBe(true);
    expect(closeCodes.every((code) => code === 1000 || (code >= 3000 && code <= 4999))).toBe(true);
  });

  it("does not blur the whole page behind a card broadcast", () => {
    const backdropRule = globalCss.match(/\.card-notice-backdrop\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(backdropRule).not.toContain("backdrop-filter");
  });
});
