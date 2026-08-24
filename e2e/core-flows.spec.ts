import { expect, Page, test } from "@playwright/test";

async function createScoreMatch(page: Page, playerCount = 2) {
  await page.goto("/");
  await page.getByRole("button", { name: /开始追分局/ }).click();
  for (let index = 2; index < playerCount; index += 1) {
    await page.getByRole("button", { name: /添加临时玩家/ }).click();
  }
  await page.getByRole("button", { name: /下一步：确认规则/ }).click();
  await page.getByRole("button", { name: /确认并开始/ }).click();
  await expect(page.locator(".live-label")).toHaveText(/对局进行中/);
}

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
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("button", { name: "打印 / PDF" }).click();
    await expect((await popupPromise).getByRole("heading", { name: "追分战绩" })).toBeVisible();
  });
});

test("牌组页默认数量、精简卡牌表单与官方牌库弹窗", async ({ page }) => {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试玩家", avatarUrl: null } } }));
  await page.route("**/api/card-catalog", (route) => route.fulfill({ json: { customCards: [] } }));
  await page.route("**/api/decks", (route) => route.fulfill({ json: { decks: [] } }));
  await page.goto("/");
  await page.getByRole("button", { name: "牌组" }).click();

  const quantityInputs = page.locator(".deck-card-picker input");
  await expect(quantityInputs.first()).toHaveValue("1");
  expect(await quantityInputs.evaluateAll((inputs) => inputs.every((input) => (input as HTMLInputElement).value === "1"))).toBe(true);
  await expect(page.getByText("安全等级", { exact: true })).toHaveCount(0);
  await expect(page.getByText("安全提示（可选）", { exact: true })).toHaveCount(0);

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
  await expect(page.getByRole("button", { name: "打印 / PDF" })).toBeVisible();
  await expect(page.getByRole("button", { name: "JSON 备份" })).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "打印 / PDF" }).click();
  await expect((await popupPromise).getByRole("heading", { name: "中八双人赛" })).toBeVisible();
});

test("奇招牌抽取、使用、安全跳过和刷新恢复", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "玩法" }).click();
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
  await page.getByRole("button", { name: "玩法" }).click();
  await page.getByRole("button", { name: /开始设置/ }).click();
  await expect(page.getByRole("heading", { name: "发现未结束对局" })).toBeVisible();
  await page.getByRole("button", { name: "保存当前对局后新建" }).click();
  await page.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("button", { name: "返回对局首页" }).click();
  await expect(page.getByRole("heading", { name: "继续未结束对局" })).toBeVisible();
  await page.getByRole("button", { name: /继续 →/ }).click();
  await expect(page.locator(".live-label")).toHaveText(/对局进行中/);
});

test("R2 玩家可独立设分、中途加入、调整顺序并保留离场记录", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /开始追分局/ }).click();
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
  await page.getByRole("button", { name: "玩法" }).click();
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
  await page.getByRole("button", { name: /开始追分局/ }).click();
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
  await expect(page.getByRole("heading", { name: /今晚这桌/ })).toBeVisible();
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.some((key) => key.includes(":corrupt-backup:"))).toBe(true);
});
