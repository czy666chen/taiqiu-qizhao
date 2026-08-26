import { expect, test } from "@playwright/test";

test.describe("多人实时房间全屏化", () => {
  test("首页不再内嵌房间面板，提供进入 /room 的入口", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".realtime-room-panel")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /多人实时房间/ })).toBeVisible();
  });

  test("/room 全屏入口页对游客显示登录引导", async ({ page }) => {
    await page.goto("/room");
    await expect(page.getByRole("heading", { name: "多人实时房间" })).toBeVisible();
    await expect(page.getByText("需要登录", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: /前往登录/ }).click();
    await expect(page).toHaveURL(/\/profile$/);
  });

  test("/room/:code 路径可直达全屏房间页外壳", async ({ page }) => {
    await page.goto("/room/ABC234");
    await expect(page.getByRole("heading", { name: "多人实时房间" })).toBeVisible();
  });

  test("白天主题保留浅色房间控件与计分板白字", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "day";
      document.body.innerHTML = `
      <section class="realtime-score-players"><div class="realtime-player-slot"><button>玩家</button></div></section>
      <section class="match-section card-board baseline-card-panel"><div class="trick-grid"><article class="trick-card">普通牌</article></div></section>
      <section class="match-section card-board realtime-card-panel"><div class="trick-grid"><article class="trick-card"><h3>实时牌</h3><p>允许说明文字自然换成更多行</p><aside>安全提示</aside></article></div><div class="realtime-card-actions"><button class="primary compact">抽 1 张</button><button class="secondary compact" disabled>调整下一轮手牌</button></div></section>
      <section class="card-ledger">流水</section>
      <div class="realtime-rule-grid"><button>普通计分</button></div>
      <details class="realtime-score-tools" open><summary>特殊规则</summary><div class="realtime-tool-grid"><div><button class="realtime-emphasis-button">黑金（双倍）</button></div></div></details>
      <section class="room-members"><article><span>陈</span><div><b>陈致远</b></div><div class="member-actions"><label>认领到<select><option>玩家 A</option></select></label><button>确认认领</button></div></article></section>
      <section class="room-kicked">已移出的成员</section>
      <div class="realtime-eight-score"><article class="red"><span>甲</span><strong>3</strong><small>普胜 3</small></article></div>
      <div class="eight-scoreboard"><article class="blue"><strong>4</strong></article></div>
      <div class="room-topbar-actions"><button class="danger-button">结束对局</button></div>
      `;
    });

    await expect(page.getByRole("button", { name: "抽 1 张" })).toHaveCSS("background-color", "rgb(22, 131, 74)");
    await expect(page.getByRole("button", { name: "抽 1 张" })).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "调整下一轮手牌" })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "调整下一轮手牌" })).toHaveCSS("opacity", "0.42");
    await expect(page.locator(".realtime-card-panel")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".realtime-card-panel .trick-card")).toHaveCSS("background-image", /linear-gradient/);
    await expect(page.locator(".realtime-card-panel .trick-grid")).toHaveCSS("grid-template-columns", /.+ .+ .+/);
    await expect(page.locator(".realtime-card-panel .trick-card")).toHaveCSS("min-height", "310px");
    const cardGeometry = await page.locator(".card-board").evaluateAll((panels) => panels.map((panel) => {
      const card = panel.querySelector(".trick-card")!;
      const panelStyle = getComputedStyle(panel);
      const cardStyle = getComputedStyle(card);
      return [panelStyle.padding, cardStyle.padding, cardStyle.borderRadius, cardStyle.minHeight];
    }));
    expect(cardGeometry[1]).toEqual(cardGeometry[0]);
    await expect(page.locator(".card-ledger")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".realtime-rule-grid button")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.locator(".realtime-tool-grid > div")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.getByRole("button", { name: "黑金（双倍）" })).toHaveCSS("background-color", "rgb(255, 249, 231)");
    await expect(page.locator(".room-kicked")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.locator(".realtime-player-slot > button")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.locator(".realtime-eight-score strong")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.locator(".eight-scoreboard strong")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "结束对局" })).toHaveCSS("background-color", "rgb(227, 74, 88)");

    await page.setViewportSize({ width: 375, height: 812 });
    await expect(page.locator(".realtime-card-panel .trick-grid")).toHaveCSS("grid-template-columns", /^\d+(\.\d+)?px \d+(\.\d+)?px$/);
    await expect(page.locator(".realtime-card-panel .trick-card")).toHaveCSS("min-height", "340px");
    await expect(page.locator(".realtime-card-panel .trick-card > p")).toHaveCSS("font-size", "14px");
    await expect(page.locator(".realtime-card-panel .trick-card aside")).toBeHidden();
    await expect(page.locator(".room-members .member-actions")).toHaveCSS("grid-column-start", "2");
    await expect(page.locator(".room-members .member-actions")).toHaveCSS("justify-self", "end");
    await expect(page.locator(".realtime-eight-score span")).toHaveCSS("font-size", "22px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
