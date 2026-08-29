import { expect, Page, test } from "@playwright/test";

async function createScoreMatch(page: Page, playerCount = 2) {
  await page.goto("/");
  await page.getByRole("button", { name: /多人追分/ }).click();
  for (let index = 2; index < playerCount; index += 1) {
    await page.getByRole("button", { name: /添加临时玩家/ }).click();
  }
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".live-label")).toHaveText(/对局进行中/);
}

async function seedLongTeamBattle(page: Page, roundCount = 320) {
  const startedAt = 1_788_000_000_000;
  const players = Array.from({ length: 8 }, (_, index) => ({
    id: `team-player-${index + 1}`,
    name: `成员 ${index + 1}`,
    joinedAt: startedAt + index,
  }));
  const playerNames = Object.fromEntries(players.map(({ id, name }) => [id, name]));
  const events = Array.from({ length: roundCount }, (_, index) => ({
    id: `team-round-${index + 1}`,
    sequenceNo: index + 1,
    type: "round",
    occurredAt: startedAt + index + 1,
    playerNames,
    round: {
      playerIds: [players[0].id, players[1].id],
      winnerId: players[index % 2].id,
      winType: "normal",
      fouls: { [players[0].id]: 0, [players[1].id]: 0 },
      note: "",
      startedAt: startedAt + index,
      confirmedAt: startedAt + index + 1,
    },
  }));
  const id = "team-battle-long-e2e";
  const match = {
    schemaVersion: 1,
    id,
    mode: "team_battle",
    status: "completed",
    title: "超长团战",
    location: "",
    note: "",
    createdAt: startedAt,
    startedAt,
    endedAt: startedAt + roundCount + 2,
    pausedDurationMs: 0,
    players,
    events: [...events, {
      id: "team-finish",
      sequenceNo: roundCount + 1,
      type: "finish",
      occurredAt: startedAt + roundCount + 2,
      playerNames,
    }],
  };
  await page.addInitScript(({ storageValue }) => {
    localStorage.setItem("billiards-club-assistant:v1", JSON.stringify(storageValue));
  }, { storageValue: {
    version: 3,
    activeMatch: null,
    history: [],
    savedRules: [],
    scorePresets: [],
    pausedMatches: [],
    recoverySnapshots: [],
    activeEightBallMatch: null,
    eightBallHistory: [],
    activeSnookerMatch: null,
    snookerHistory: [],
    activeTeamBattleMatch: null,
    teamBattleHistory: [match],
  } });
  return id;
}

test("斯诺克本机计分可形成 31+ 单杆、判罚并刷新恢复", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /标准斯诺克/ }).click();
  await page.getByLabel("斯诺克玩家 1 姓名").fill("小丁");
  await page.getByLabel("斯诺克玩家 2 姓名").fill("小特");
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page.getByLabel("每局红球数").fill("6");
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.getByLabel("第 1 小局比分")).toBeVisible();
  await expect(page.locator(".snooker-frame-scoreboard article").nth(0).locator("strong")).toHaveText("0");

  for (let index = 0; index < 4; index += 1) {
    await page.locator(".snooker-ball.red").click();
    await page.locator(".snooker-ball.black").click();
  }
  await expect(page.getByText("当前单杆 32", { exact: true })).toBeVisible();
  await expect(page.getByLabel("红球打进 4 个")).toBeVisible();
  await expect(page.getByLabel("黑球打进 4 个")).toBeVisible();
  await expect(page.getByText(/147 路线/)).toHaveCount(0);
  await expect(page.locator(".snooker-frame-scoreboard article").nth(0).locator("strong")).toHaveText("32");

  await page.reload();
  await expect(page.getByText("当前单杆 32", { exact: true })).toBeVisible();
  await page.locator(".snooker-foul").click();
  await page.getByRole("group", { name: "犯规罚分给小特" }).getByRole("button", { name: "+4" }).click();
  await expect(page.locator(".snooker-frame-scoreboard article").nth(1).locator("strong")).toHaveText("4");
  await page.getByRole("button", { name: "撤销上一事件" }).click();
  await expect(page.locator(".snooker-frame-scoreboard article").nth(1).locator("strong")).toHaveText("0");
  await page.getByRole("button", { name: "结束比赛" }).click();
  await page.getByRole("button", { name: "确认结束并保存" }).click();
  const imageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存竖版长图" }).click();
  await expect((await imageDownload).suggestedFilename()).toMatch(/^斯诺克战绩-.*\.png$/);
});

test("玩法五卡布局与标准斯诺克设置在视口内稳定显示", async ({ page }) => {
  await page.goto("/");
  const quickCards = page.locator(".quick-start .quick-card");
  await expect(quickCards).toHaveCount(5);
  await expect(quickCards.locator("b")).toHaveText(["中八双人赛", "标准斯诺克", "多人追分", "团战记分", "多人实时房间"]);
  if ((await page.viewportSize())!.width > 900) {
    const lowerCards = await page.locator(".quick-start .quick-card:nth-child(n + 3)").evaluateAll((cards) => cards.map((card) => {
      const bounds = card.getBoundingClientRect();
      return { top: bounds.top, width: bounds.width };
    }));
    expect(new Set(lowerCards.map((card) => Math.round(card.top))).size).toBe(1);
    expect(Math.max(...lowerCards.map((card) => card.width)) - Math.min(...lowerCards.map((card) => card.width))).toBeLessThanOrEqual(1);
  }
  await page.getByRole("button", { name: /团战记分/ }).click();
  await expect(page.getByRole("heading", { name: "创建团战记分" })).toBeVisible();
  await page.getByRole("button", { name: "关闭团战设置" }).click();

  await page.goto("/play");
  const modeCards = page.locator(".mode-card");
  await expect(modeCards).toHaveCount(5);
  await expect(modeCards.locator("h2")).toHaveText(["中八双人赛", "追分", "团队记分", "斯诺克", "奇招卡牌局"]);
  const cardWidths = await modeCards.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
  expect(cardWidths.every((width) => width >= 280)).toBe(true);
  if ((await page.viewportSize())!.width > 900) {
    const cardHeights = await modeCards.evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height));
    expect(Math.max(...cardHeights)).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  await page.getByRole("button", { name: /开始标准斯诺克/ }).click();
  await expect(page.getByRole("button", { name: "标准 15 红" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("每局红球数", { exact: true })).toHaveCount(0);
  const bodyBottom = await page.locator(".snooker-setup .setup-body").evaluate((element) => element.getBoundingClientRect().bottom);
  const footerTop = await page.locator(".snooker-setup .modal-actions").evaluate((element) => element.getBoundingClientRect().top);
  expect(bodyBottom).toBeLessThanOrEqual(footerTop + 1);
});

test("团战多组合比分隔离并在刷新后恢复", async ({ page }) => {
  await page.goto("/play");
  await page.getByRole("button", { name: "开始团战设置" }).click();
  await page.getByRole("button", { name: "开始本机团战" }).click();
  await expect(page.locator(".live-label")).toHaveText(/本机团战进行中/);

  await page.getByRole("button", { name: "成员 1 获胜" }).click();
  await page.getByRole("button", { name: "确认本局并进入下一局" }).click();
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["1", "0"]);

  await page.getByRole("button", { name: "成员管理" }).click();
  for (let member = 3; member <= 8; member += 1) {
    await page.getByLabel("加入新成员").fill(`成员 ${member}`);
    await page.getByRole("button", { name: "加入成员", exact: true }).click();
  }
  await expect(page.getByText("已达到 8 人上限。")).toBeVisible();
  await expect(page.getByRole("button", { name: "加入成员", exact: true })).toBeDisabled();
  await page.getByLabel("蓝方成员").selectOption({ label: "成员 3" });
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["0", "0"]);
  await expect(page.getByLabel("蓝方成员").locator("option").filter({ hasText: "成员 1" })).toHaveAttribute("disabled", "");

  await page.getByLabel("本局备注").fill("不能带到新组合");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByLabel("蓝方成员").selectOption({ label: "成员 4" });
  await expect(page.getByLabel("蓝方成员")).toHaveValue(await page.getByLabel("蓝方成员").locator("option").filter({ hasText: "成员 3" }).getAttribute("value") ?? "");
  await expect(page.getByLabel("本局备注")).toHaveValue("不能带到新组合");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("蓝方成员").selectOption({ label: "成员 4" });
  await expect(page.getByLabel("本局备注")).toHaveValue("");
  await page.getByLabel("蓝方成员").selectOption({ label: "成员 3" });
  await page.getByRole("button", { name: "成员 3 获胜" }).click();
  await page.getByRole("button", { name: "确认本局并进入下一局" }).click();
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["0", "1"]);

  await page.getByRole("button", { name: "暂停计时" }).click();
  await expect(page.getByRole("button", { name: "确认本局并进入下一局" })).toBeDisabled();
  await page.getByRole("button", { name: "继续计时" }).click();
  await page.reload();
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["1", "0"]);
  await page.getByLabel("蓝方成员").selectOption({ label: "成员 3" });
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["0", "1"]);

  await page.locator(".team-pair-ledger").getByRole("button", { name: "更正" }).click();
  await page.getByRole("button", { name: "成员 1 获胜" }).click();
  await page.getByRole("button", { name: "保存更正" }).click();
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["1", "0"]);
  await page.getByRole("button", { name: /撤销当前组合上一局/ }).click();
  await expect(page.locator(".head-to-head-scoreboard strong")).toHaveText(["0", "0"]);
  for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  }
  await page.getByRole("button", { name: "结束团战" }).click();
  await page.getByRole("button", { name: "确认结束并保存" }).click();
  await expect(page.getByRole("heading", { name: "团战结算" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "总排行" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "两两比分" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "逐局流水" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 PNG 长图" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 PDF" })).toBeVisible();
  expect((await page.getByRole("button", { name: "返回战绩" }).boundingBox())?.width ?? 999).toBeLessThan(160);
  const reportControlHeights = await page.locator(".team-report-actions select, .team-report-actions > .export-actions:not(.minor) button").evaluateAll((controls) => controls.map((control) => control.getBoundingClientRect().height));
  expect(reportControlHeights.every((height) => height === 44)).toBe(true);
  await page.getByRole("button", { name: "切换到白天版本" }).click();
  await expect(page.locator(".team-report-preview")).toHaveCSS("color", "rgb(11, 104, 56)");
  await expect(page.locator(".team-report-preview")).toHaveCSS("background-color", "rgb(238, 248, 242)");
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PNG 长图" }).click();
  await expect((await pngDownload).suggestedFilename()).toMatch(/团战战绩-\d{8}\.png$/);
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await pdfDownload).suggestedFilename()).toMatch(/团战战绩-\d{8}\.pdf$/);
  await page.getByLabel("报告范围").selectOption({ label: "成员 1" });
  await expect(page.getByText(/成员 1 专项/)).toBeVisible();
  const memberPdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await memberPdfDownload).suggestedFilename()).toMatch(/团战战绩-成员 1-\d{8}\.pdf$/);
  await page.getByRole("button", { name: "删除战绩" }).click();
  await page.getByRole("button", { name: "确认删除" }).click();
  await expect(page.getByRole("heading", { name: "还没有战绩" })).toBeVisible();
});

test("手机竖屏首页隐藏计分台预览且导航状态徽标不重叠", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".match-table-preview")).toBeHidden();
  const portraitHeroHeights = await page.locator(".welcome-panel").evaluate((panel) => ({
    panel: panel.getBoundingClientRect().height,
    copy: panel.querySelector(".welcome-copy")?.getBoundingClientRect().height ?? 0,
  }));
  expect(portraitHeroHeights.panel - portraitHeroHeights.copy).toBeLessThanOrEqual(32);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator(".match-table-preview")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/play");
  await page.getByRole("button", { name: "开始团战设置" }).click();
  await page.getByRole("button", { name: "开始本机团战" }).click();
  await expect(page.locator('.desktop-nav a[href="/"] i')).toHaveCSS("position", "static");
});

test("超长团战报告自动降级后仍可导出整场和八人成员报告", async ({ page }) => {
  const matchId = await seedLongTeamBattle(page);
  await page.goto(`/history/${matchId}`);

  await expect(page.getByRole("heading", { name: "超长团战" })).toBeVisible();
  await expect(page.locator(".team-pair-results article strong")).toHaveText("160 : 160");
  await expect(page.getByText("内容较长，已省略逐局变化，仅展示两两最终比分")).toBeVisible();

  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PNG 长图" }).click();
  await expect((await pngDownload).suggestedFilename()).toMatch(/团战战绩-\d{8}\.png$/);
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await pdfDownload).suggestedFilename()).toMatch(/团战战绩-\d{8}\.pdf$/);

  await page.getByLabel("报告范围").selectOption({ label: "成员 1" });
  await expect(page.getByText("报告预览：成员 1 专项")).toBeVisible();
  await expect(page.getByText("内容较长，已省略逐局变化，仅展示两两最终比分")).toBeVisible();
  const memberPdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await memberPdfDownload).suggestedFilename()).toMatch(/团战战绩-成员 1-\d{8}\.pdf$/);
});

test.describe("追分核心流程", () => {
  for (const playerCount of [2, 4, 8]) {
    test(`${playerCount} 人可建局`, async ({ page }) => {
      await createScoreMatch(page, playerCount);
      await expect(page.locator(".ranking-grid button")).toHaveCount(playerCount);
    });
  }

  test("建局、计分、撤销、结束和历史查看", async ({ page }) => {
    await createScoreMatch(page, 2);
    await page.locator(".score-actions button").filter({ hasText: "普胜" }).click();
    await expect(page.locator(".ledger-row")).toHaveCount(1);
    await page.getByRole("button", { name: /撤销上一笔/ }).click();
    await expect(page.locator(".ledger-row")).toHaveCount(0);
    await page.locator(".score-actions button").filter({ hasText: "小金" }).click();
    await page.getByRole("button", { name: "结束对局" }).click();
    await page.getByRole("button", { name: "确认结束并保存" }).click();
    await expect(page.getByRole("heading", { name: "追分结算" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "追分结算" })).toBeVisible();
    const imageDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "保存竖版长图" }).click();
    await expect((await imageDownload).suggestedFilename()).toMatch(/^追分战绩-.*\.png$/);
    const pdfDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载 PDF" }).click();
    await expect((await pdfDownload).suggestedFilename()).toMatch(/^追分战绩-.*\.pdf$/);
  });
});

test("牌组页默认数量、精简卡牌表单与官方牌库弹窗", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试玩家", avatarUrl: null } } }));
  await page.route("**/api/card-catalog", (route) => route.fulfill({ json: { customCards: [] } }));
  await page.route("**/api/decks", (route) => route.fulfill({ json: { decks: [] } }));
  await page.goto("/");
  await page.getByRole("link", { name: "牌组" }).click();

  const quantityInputs = page.locator(".deck-card-picker input");
  await expect(quantityInputs.first()).toHaveValue("1");
  expect(await quantityInputs.evaluateAll((inputs) => inputs.every((input) => (input as HTMLInputElement).value === "1"))).toBe(true);
  await expect(page.getByText("安全等级", { exact: true })).toHaveCount(0);
  await expect(page.getByText("安全提示（可选）", { exact: true })).toHaveCount(0);

  await expect(page.locator(".deck-summary span").first()).toContainText("2");
  const snookerDeck = page.getByRole("button", { name: /斯诺克牌组/ });
  await expect(snookerDeck).toContainText("22 张");
  await snookerDeck.click();
  await expect(page.getByRole("dialog", { name: "斯诺克牌组清单" })).toBeVisible();
  await expect(page.locator(".card-catalog-modal .catalog-list article")).toHaveCount(21);
  await page.keyboard.press("Escape");
  await expect(snookerDeck).toBeFocused();

  const officialDeck = page.getByRole("button", { name: /全量牌库/ });
  await officialDeck.click();
  await expect(page.getByRole("dialog", { name: "官方卡牌清单" })).toBeVisible();
  await expect(page.getByLabel("搜索官方卡牌")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "官方卡牌清单" })).toHaveCount(0);
  await expect(officialDeck).toBeFocused();
});

test("战绩 JSON 可校验并下载长图和 PDF", async ({ page }) => {
  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET") mutationRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试玩家", avatarUrl: null } } }));
  await page.route("**/api/history", (route) => route.fulfill({ json: { matches: [] } }));
  await page.goto("/profile");

  const dataControlTrigger = page.getByRole("button", { name: "导出与删除" });
  await expect(dataControlTrigger).toBeVisible();
  await expect(page.getByRole("dialog", { name: "导出与删除" })).toHaveCount(0);
  await dataControlTrigger.click();
  await expect(page.getByRole("dialog", { name: "导出与删除" })).toBeVisible();

  const input = page.getByLabel("粘贴 JSON 内容");
  await input.fill("{nope}");
  await input.blur();
  await expect(page.getByRole("alert")).toContainText("JSON 格式无效");

  await input.fill(JSON.stringify({ exportVersion: 1, match: {
    version: 1, id: "match-report", mode: "score", status: "completed", createdAt: 1_786_423_085_575,
    startedAt: 1_786_423_085_575, endedAt: 1_786_423_145_575,
    players: [
      { id: "a", name: "阿杰", kind: "guest", initialScore: 0, score: 4, active: true },
      { id: "b", name: "小陈", kind: "guest", initialScore: 0, score: 0, active: true },
    ],
    currentPlayerId: "a", rules: [],
    scoreEvents: [{ id: "event-1", type: "score", label: "普胜", playerId: "a", changes: { a: 4 }, previousCurrentPlayerId: "a", occurredAt: 1_786_423_115_575 }],
  } }));
  await expect(page.getByLabel("日期与逐条时间")).toBeChecked();
  await expect(page.getByLabel("比分走势")).toBeChecked();
  await expect(page.getByLabel("分类统计")).toBeChecked();
  const pngDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载长图 PNG" }).click();
  await expect((await pngDownload).suggestedFilename()).toBe("战绩报告-长图.png");

  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await pdfDownload).suggestedFilename()).toBe("战绩报告.pdf");
  expect(mutationRequests).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "导出与删除" })).toHaveCount(0);
  await expect(dataControlTrigger).toBeFocused();
});

test("登录用户可输入旧密码更改密码并看到忘记密码提示", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试玩家", avatarUrl: null } } }));
  await page.route("**/api/history", (route) => route.fulfill({ json: { matches: [] } }));
  await page.route("**/api/auth/change-password", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ currentPassword: "old-secret", newPassword: "new-secret" });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/profile");

  await expect(page.getByLabel("旧密码")).toHaveCount(0);
  await page.getByRole("button", { name: "更改密码" }).click();
  await expect(page.getByRole("dialog", { name: "更改密码" })).toBeVisible();
  await expect(page.getByText(/忘记旧密码.*联系管理员/)).toBeVisible();
  await page.getByLabel("旧密码").fill("old-secret");
  await page.getByLabel("新密码", { exact: true }).fill("new-secret");
  await page.getByLabel("确认新密码").fill("new-secret");
  await page.getByRole("button", { name: "确认更改密码" }).click();
  await expect(page.getByText("密码已更新，其他设备上的登录已失效")).toBeVisible();
});

test("直接刷新牌组深链后仍能完成客户端恢复", async ({ page }) => {
  await page.goto("/decks");
  await expect(page.getByRole("heading", { name: "牌组", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "牌组", exact: true })).toBeVisible();
  await expect(page.getByText("正在恢复本机对局…")).toHaveCount(0);
});

test("R2.5 中八建局、逐局录入、布局切换、恢复与战绩导出", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /开始中八比赛/ }).click();
  await expect(page.getByText("计分板布局", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "上下二等分" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "左右二等分" })).toHaveCount(0);
  await expect(page.locator(".setup-section").filter({ has: page.getByText("02") })).toContainText("赛制");
  await expect(page.locator(".setup-section").filter({ has: page.getByText("02") })).not.toContainText("先开球");
  await expect(page.locator(".setup-section").filter({ has: page.getByText("03") })).toContainText("先开球（选填）");
  await expect(page.locator(".setup-section").filter({ has: page.getByText("03") })).toContainText("后续开球（选填）");
  await page.getByLabel("中八玩家 1 姓名").fill("阿杰");
  await page.getByLabel("中八玩家 2 姓名").fill("老王");
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".eight-scoreboard")).toHaveClass(/stacked/);
  await page.getByRole("button", { name: "阿杰 获胜" }).click();
  await page.getByRole("button", { name: "炸清" }).click();
  await page.getByText("老王 本局犯规").locator("..").getByRole("spinbutton").fill("2");
  await page.getByRole("button", { name: /确认本局并进入下一局/ }).click();
  await expect(page.locator(".eight-scoreboard article.red > strong")).toHaveText("1");
  await expect(page.locator(".eight-ledger article")).toHaveCount(1);
  await page.getByRole("button", { name: "切换左右" }).click();
  await expect(page.locator(".eight-scoreboard")).toHaveClass(/split/);
  await page.reload();
  await expect(page.locator(".eight-scoreboard")).toHaveClass(/split/);
  await expect(page.locator(".eight-scoreboard article.red > strong")).toHaveText("1");
  await page.getByRole("button", { name: "结束比赛" }).click();
  await page.getByRole("button", { name: "确认结束并保存" }).click();
  await expect(page.getByRole("checkbox", { name: "日期与逐条时间" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "比分走势" })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: "分类统计" })).toBeChecked();
  await expect(page.getByRole("button", { name: "保存竖版长图" })).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JSON 备份" })).toBeVisible();
  const imageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存竖版长图" }).click();
  await expect((await imageDownload).suggestedFilename()).toMatch(/^中八战绩-.*\.png$/);
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 PDF" }).click();
  await expect((await pdfDownload).suggestedFilename()).toMatch(/^中八战绩-.*\.pdf$/);
});

test("奇招牌抽取、使用、安全跳过和刷新恢复", async ({ page }) => {
  await page.goto("/");
  await page.goto("/play");
  await page.getByRole("button", { name: "查看并开始" }).click();
  await page.getByRole("button", { name: /全量牌库/ }).click();
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  const initialCards = await page.locator(".trick-card").count();
  await page.locator(".trick-card").first().getByRole("button", { name: "使用此卡" }).click();
  await expect(page.locator(".trick-card")).toHaveCount(initialCards - 1);
  await page.getByRole("button", { name: /抽一张/ }).click();
  await page.locator(".trick-card").first().getByRole("button", { name: "安全跳过" }).click();
  await expect(page.getByRole("status")).toContainText("已安全跳过");
  await page.reload();
  await expect(page.locator(".live-label")).toHaveText(/对局进行中/);
  await expect(page.locator(".card-log")).toContainText("安全跳过");
});

test("未结束对局可保存后新建并恢复", async ({ page }) => {
  await createScoreMatch(page, 2);
  await page.goto("/play");
  await page.getByRole("button", { name: /开始设置/ }).click();
  await expect(page.getByRole("heading", { name: "发现未结束对局" })).toBeVisible();
  await page.getByRole("button", { name: "保存当前对局后新建" }).click();
  await page.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("link", { name: "返回对局首页" }).click();
  await expect(page.getByRole("heading", { name: "继续未结束对局" })).toBeVisible();
  await page.getByRole("button", { name: /继续 →/ }).click();
  await expect(page.locator(".live-label")).toHaveText(/对局进行中/);
});

test("R2 玩家可独立设分、中途加入、调整顺序并保留离场记录", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /多人追分/ }).click();
  await page.getByLabel("玩家 B初始积分").fill("30");
  await page.getByRole("button", { name: /添加临时玩家/ }).click();
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".ranking-grid button").filter({ hasText: "玩家 B" })).toContainText("30分");
  await page.getByRole("button", { name: "本局信息" }).click();
  await page.getByLabel("中途加入玩家昵称").fill("新手");
  await page.getByLabel("中途加入玩家初始积分").fill("50");
  await page.getByRole("button", { name: /中途加入/ }).click();
  const newcomer = page.locator(".manager-list article").filter({ hasText: "新手" });
  await expect(newcomer).toContainText("50 分");
  await newcomer.getByRole("button", { name: "新手上移" }).click();
  await newcomer.getByRole("button", { name: "设为当前" }).click();
  await page.locator(".score-actions button").filter({ hasText: "普胜" }).click();
  await newcomer.getByRole("button", { name: "离场" }).click();
  await expect(page.locator(".departed-list")).toContainText("新手");
  await expect(page.locator(".departed-list")).toContainText("54 分");
});

test("R2 转账计分由每名输家支付固定分数", async ({ page }) => {
  await createScoreMatch(page, 3);
  await page.getByRole("button", { name: "转账计分" }).click();
  await page.getByRole("checkbox", { name: "玩家 B" }).check();
  await page.getByRole("checkbox", { name: "玩家 C" }).check();
  await page.getByLabel("每名输家支付分数").fill("10");
  await page.getByLabel("转账计分备注").fill("两位输家各付 10");
  await page.getByRole("button", { name: "确认转账" }).click();
  await expect(page.locator(".ranking-grid button").filter({ hasText: "玩家 A" })).toContainText("20分");
  await expect(page.locator(".ranking-grid button").filter({ hasText: "玩家 B" })).toContainText("-10分");
  await expect(page.locator(".ranking-grid button").filter({ hasText: "玩家 C" })).toContainText("-10分");
  await expect(page.locator(".ledger-row").first()).toContainText("两位输家各付 10");
});

test("R2 高级抽牌与牌分联动可撤销并进入统一历史", async ({ page }) => {
  await page.goto("/");
  await page.goto("/play");
  await page.getByRole("button", { name: "同时加入奇招牌" }).click();
  await page.getByLabel("自动补牌策略").selectOption("after_play");
  await page.getByLabel("卡牌最高安全等级").selectOption("low");
  await page.getByRole("checkbox", { name: "身体动作" }).check();
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  const initialCards = await page.locator(".trick-card").count();
  await page.getByLabel("卡牌关联分值").fill("6");
  await page.getByLabel("卡牌关联计分备注").fill("奇招奖励");
  await page.locator(".trick-card").first().getByRole("button", { name: "使用此卡" }).click();
  await expect(page.locator(".trick-card")).toHaveCount(initialCards);
  await expect(page.locator(".ledger-row").first()).toContainText("卡牌");
  await page.locator(".card-log summary").click();
  await expect(page.locator(".card-log")).toContainText("已关联积分");
  await page.locator(".card-log > div").first().getByRole("button", { name: "撤销" }).click();
  await expect(page.locator(".ledger-row")).toHaveCount(0);
  await expect(page.locator(".trick-card")).toHaveCount(initialCards);

  await page.getByLabel("卡牌关联分值").fill("8");
  await page.locator(".trick-card").first().getByRole("button", { name: "使用此卡" }).click();
  await page.getByRole("button", { name: "结束对局" }).click();
  await page.getByRole("button", { name: "确认结束并保存" }).click();
  await expect(page.getByRole("heading", { name: "真实发生顺序" })).toBeVisible();
  await expect(page.locator(".timeline-row.unified.score")).toContainText("查看关联卡牌");
  await expect(page.locator(".timeline-row.unified.card").filter({ hasText: "查看关联积分" })).toBeVisible();
});

test("14710 默认预设允许清空分值后重新输入", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /多人追分/ }).click();
  await expect(page.getByLabel("计分预设")).toHaveValue("builtin-14710");
  await expect(page.getByLabel("犯规分值")).toHaveValue("1");
  await expect(page.getByLabel("普胜分值")).toHaveValue("4");
  await expect(page.getByLabel("小金分值")).toHaveValue("7");
  await expect(page.getByLabel("大金分值")).toHaveValue("10");
  const normalWin = page.getByLabel("普胜分值");
  await normalWin.fill("");
  await expect(normalWin).toHaveValue("");
  await normalWin.fill("6");
  await expect(normalWin).toHaveValue("6");
});

test("损坏的本机数据不会被静默覆盖", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("billiards-club-assistant:v1", "{broken-json"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "本机数据无法读取" })).toBeVisible();
  await page.getByRole("button", { name: "备份并安全重置" }).click();
  await expect(page.getByRole("heading", { name: /朋友到齐/ })).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.some((key) => key.includes(":corrupt-backup:"))).toBe(true);
});
