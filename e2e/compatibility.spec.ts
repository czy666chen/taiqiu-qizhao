import { expect, test } from "@playwright/test";

test("追分和中八的起始手牌都可设为 0", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /开始追分局/ }).click();
  await page.getByRole("button", { name: "独立手牌" }).click();
  await page.getByLabel("追分每人起始手牌").fill("");
  await expect(page.getByLabel("追分每人起始手牌")).toHaveValue("");
  await page.getByLabel("追分每人起始手牌").fill("0");
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await expect(page.getByText(/起始 0 张/)).toBeVisible();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".trick-card")).toHaveCount(0);

  await page.getByRole("button", { name: "结束对局" }).click();
  await page.getByRole("button", { name: "确认结束并保存" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: /开始中八比赛/ }).click();
  await page.getByRole("button", { name: "独立手牌" }).click();
  await page.getByLabel("中八玩家 1 起始手牌").fill("0");
  await page.getByLabel("中八玩家 2 起始手牌").fill("0");
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".eight-scoreboard")).toBeVisible();
  await expect(page.locator(".trick-card")).toHaveCount(0);
});

test("浏览器拒绝 localStorage 时仍能进入首页", async ({ page }) => {
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      Object.defineProperty(Storage.prototype, method, { configurable: true, value: () => { throw new DOMException("blocked", "SecurityError"); } });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /开始追分局/ })).toBeVisible();
  await expect(page.locator(".loading-screen")).toHaveCount(0);
});

test("切换明暗主题会同步浏览器主题色", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#07100d");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(7, 16, 13)");
  await page.getByRole("button", { name: "切换到白天版本" }).click();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f7fbf7");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "day");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(247, 251, 247)");
  await page.getByRole("button", { name: "切换到黑夜版本" }).click();
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#07100d");
  await expect(page.locator("html")).toHaveCSS("background-color", "rgb(7, 16, 13)");
});
