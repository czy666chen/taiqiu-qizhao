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
  await page.route("**/api/admin/users/user-1", (route) => route.request().method() === "DELETE" ? route.fulfill({
    json: { deleted: true },
  }) : route.fulfill({ json: {
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
    await route.fulfill({ json: { newPassword: "123456" } });
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
  await page.getByRole("link", { name: "查看详情" }).click();
  await expect(page.getByRole("heading", { name: "测试玩家" })).toBeVisible();
  await page.getByRole("button", { name: "重置用户密码" }).click();
  await page.getByLabel("当前管理员密码").fill("not-a-real-secret");
  await page.getByLabel("输入目标用户名确认").fill("player");
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(page.getByText("123456")).toBeVisible();
  await page.getByLabel("我已告知用户登录后立即更改密码").check();
  await page.getByRole("button", { name: "关闭" }).click();

  await page.getByRole("button", { name: "删除账户" }).click();
  await page.getByLabel("当前管理员密码").fill("not-a-real-secret");
  await page.getByLabel("输入目标用户名确认").fill("player");
  await page.getByRole("button", { name: "永久删除账户" }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);

  await page.getByRole("link", { name: "战绩", exact: true }).click();
  await expect(page.getByRole("heading", { name: "战绩管理" })).toBeVisible();
  await expect(page.getByText("match-1")).toBeVisible();
});

test("管理后台可筛选团战并从同步快照展示最终统计与逐局流水", async ({ page }) => {
  const names = { red: "甲", blue: "乙", green: "丙" };
  const snapshot = {
    schemaVersion: 1, id: "local-team", mode: "team_battle", status: "completed",
    title: "周末团战", location: "俱乐部", note: "", createdAt: 1000, startedAt: 1001, endedAt: 1010, pausedDurationMs: 0,
    players: [
      { id: "red", name: "甲", joinedAt: 1001 },
      { id: "blue", name: "乙", joinedAt: 1001 },
      { id: "green", name: "丙", joinedAt: 1001 },
    ],
    events: [
      { id: "round-1", sequenceNo: 1, type: "round", occurredAt: 1004, playerNames: names, round: { playerIds: ["red", "blue"], winnerId: "red", winType: "normal", fouls: { red: 0, blue: 0 }, note: "", startedAt: 1002, confirmedAt: 1004 } },
      { id: "round-2", sequenceNo: 2, type: "round", occurredAt: 1007, playerNames: names, round: { playerIds: ["red", "green"], winnerId: "green", winType: "break_clear", fouls: { red: 0, green: 0 }, note: "", startedAt: 1005, confirmedAt: 1007 } },
      { id: "finish-1", sequenceNo: 3, type: "finish", occurredAt: 1010, playerNames: names },
    ],
  };
  const players = ["甲", "乙", "丙"].map((nicknameSnapshot, seatNo) => ({
    id: `stored-${seatNo}`, seatNo, userId: null, role: "player", nicknameSnapshot,
    username: null, nickname: null, userStatus: null, finalScore: seatNo === 0 || seatNo === 2 ? 1 : 0,
  }));
  await page.route("**/api/admin/auth/session", (route) => route.fulfill({
    json: { admin: { id: "admin-1", username: "admin" }, session: { authenticated: true } },
  }));
  await page.route("**/api/admin/matches?**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("mode")).toBe("team_battle");
    await route.fulfill({ json: { matches: [{
      id: "team-match-1", mode: "team_battle", status: "completed", privacy: "participants", version: 3,
      owner: { userId: "user-1", username: "player", nickname: "测试玩家", userStatus: "active" },
      players, createdAt: 1000, updatedAt: 1010, startedAt: 1001, endedAt: 1010, isRealtime: false,
    }], nextCursor: null } });
  });
  await page.route("**/api/admin/matches/team-match-1", (route) => route.fulfill({ json: {
    match: {
      id: "team-match-1", mode: "team_battle", status: "completed", privacy: "participants", version: 3,
      owner: { userId: "user-1", username: "player", nickname: "测试玩家", userStatus: "active" },
      players, createdAt: 1000, updatedAt: 1010, startedAt: 1001, endedAt: 1010, isRealtime: false,
      snapshotChecksum: "checksum", rawSnapshot: snapshot, realtime: null,
    },
    scoreEvents: [], cardEvents: [], auditEvents: [],
  } }));

  await page.goto("/admin/matches?mode=team_battle");
  await expect(page.getByLabel("模式")).toHaveValue("team_battle");
  await expect(page.getByRole("option", { name: "团战记分" })).toBeAttached();
  await page.getByRole("link", { name: /甲 · 乙 · 丙/ }).click();
  await expect(page.getByRole("heading", { name: "团战记分" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "团战最终统计" })).toBeVisible();
  await expect(page.getByText("1 胜 1 负")).toBeVisible();
  await expect(page.getByText("0 胜 1 负")).toBeVisible();
  await expect(page.getByText("1 胜 0 负")).toBeVisible();
  await expect(page.getByRole("heading", { name: "逐局流水 · 2" })).toBeVisible();
  await expect(page.getByText("甲 胜 乙")).toBeVisible();
  await expect(page.getByText("丙 胜 甲")).toBeVisible();
});
