import { expect, test } from "@playwright/test";

test("管理员可登录并进入用户列表", async ({ page }, testInfo) => {
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({
    json: { admin: null, session: { authenticated: false } },
  }));
  await page.route("**/api/admin/auth/login", async (route) => {
    const body = route.request().postDataJSON() as { username: string; password: string };
    expect(body).toEqual({ username: "admin", password: "not-a-real-secret" });
    await route.fulfill({ json: { admin: { id: "admin-1", username: "admin" }, session: { authenticated: true } } });
  });
  await page.route("**/api/admin/users?**", (route) => route.fulfill({
    json: {
      users: [{
        id: "user-1", username: "player", publicCode: "PLAYER01", nickname: "测试玩家",
        status: "active", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
        matchCount: 3, lastMatchAt: 1_700_000_000_000,
      }],
      nextCursor: null,
    },
  }));
  await page.route("**/api/admin/users/user-1", (route) => route.fulfill({
    json: {
      user: {
        id: "user-1", username: "player", publicCode: "PLAYER01", nickname: "测试玩家",
        status: "active", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
        matchCount: 3, lastMatchAt: 1_700_000_000_000, avatarUrl: null, deletedAt: null,
        passwordResetAt: null, activeSessionCount: 1,
      },
      recentMatches: [],
      recentAuthEvents: [],
    },
  }));
  await page.route("**/api/admin/users/user-1/reset-password", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ currentPassword: "not-a-real-secret" });
    await route.fulfill({ json: { newPassword: "NEW-PASSWORD-1234" } });
  });
  await page.route("**/api/admin/matches?**", (route) => route.fulfill({
    json: {
      matches: [{
        id: "match-1", mode: "chinese_eight", status: "completed", privacy: "participants", version: 1,
        owner: { userId: "user-1", username: "player", nickname: "测试玩家", userStatus: "active" },
        players: [], createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
        startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000, isRealtime: false,
      }],
      nextCursor: null,
    },
  }));

  await page.goto("/admin/login");
  await expect(page.getByRole("heading", { name: "管理后台" })).toBeVisible();
  await expect.poll(() => page.locator(".admin-login-shell").evaluate((element) => (
    getComputedStyle(element).getPropertyValue("--admin-bg").trim()
  ))).toBe("#f7fbf7");
  await page.getByLabel("管理员用户名").fill("admin");
  await page.getByLabel("密码").fill("not-a-real-secret");
  await page.getByRole("button", { name: "进入后台" }).click();

  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole("heading", { name: "用户管理" })).toBeVisible();
  await expect.poll(() => page.locator(".admin-root").evaluate((element) => (
    getComputedStyle(element).getPropertyValue("--admin-bg").trim()
  ))).toBe("#f7fbf7");
  await expect(page.getByText("测试玩家")).toBeVisible();
  if (testInfo.project.name === "mobile-chromium") {
    await expect(page.locator(".admin-mobile-bar")).toBeVisible();
  } else {
    await expect(page.locator(".admin-sidebar")).toBeVisible();
  }

  await page.getByLabel("用户名或昵称").fill("player");
  await page.getByRole("button", { name: "查询" }).click();
  await expect(page.getByText("测试玩家")).toBeVisible();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("heading", { name: "测试玩家" })).toBeVisible();
  await page.getByRole("button", { name: "重置用户密码" }).click();
  await page.getByLabel("当前管理员密码").fill("not-a-real-secret");
  await page.getByLabel("输入目标用户名确认").fill("player");
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(page.getByText("NEW-PASSWORD-1234")).toBeVisible();
  await page.getByLabel("我已安全保存新密码").check();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "战绩", exact: true }).click();
  await expect(page.getByRole("heading", { name: "战绩管理" })).toBeVisible();
  await expect(page.getByText("match-1")).toBeVisible();
});
