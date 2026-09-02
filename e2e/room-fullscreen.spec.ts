import { expect, test } from "@playwright/test";

function teamBattleSnapshot(role: "host" | "spectator" = "host") {
  const startedAt = 1_788_000_000_000;
  const players = [
    { id: "team-a", name: "阿杰", joinedAt: startedAt },
    { id: "team-b", name: "老王", joinedAt: startedAt + 1 },
  ];
  return {
    matchId: "team-room-match",
    roomCode: "ABC234",
    status: "active",
    version: 1,
    members: [
      { userId: "user-1", nickname: "测试房主", role, joinedAt: startedAt },
      { userId: "user-2", nickname: "第二玩家", role: "player", joinedAt: startedAt + 1 },
    ],
    events: [],
    chaseScore: null,
    eightBall: null,
    snooker: null,
    teamBattle: {
      mode: "team_battle",
      match: {
        schemaVersion: 1,
        id: "team-room-match",
        mode: "team_battle",
        status: "active",
        title: "周末团战",
        location: "朋友台球厅",
        note: "",
        createdAt: startedAt,
        startedAt,
        endedAt: null,
        pausedAt: null,
        pausedDurationMs: 0,
        players,
        events: [{
          id: "round-1",
          sequenceNo: 1,
          type: "round",
          occurredAt: startedAt + 10,
          playerNames: { "team-a": "阿杰", "team-b": "老王" },
          round: {
            playerIds: ["team-a", "team-b"],
            winnerId: "team-a",
            winType: "normal",
            fouls: { "team-a": 0, "team-b": 0 },
            note: "",
            startedAt,
            confirmedAt: startedAt + 10,
          },
        }],
      },
      seats: [{ playerId: "team-a", userId: "user-1" }, { playerId: "team-b", userId: "user-2" }],
      currentPairIds: ["team-a", "team-b"],
    },
  };
}

function teamBattleSnapshotWithNonRoundEvent() {
  const snapshot = teamBattleSnapshot() as unknown as {
    version: number;
    teamBattle: { match: { events: Array<Record<string, unknown>> } };
  };
  const startedAt = 1_788_000_000_000;
  snapshot.version = 3;
  snapshot.teamBattle.match.events.push(
    {
      id: "pause-1",
      sequenceNo: 2,
      type: "pause",
      occurredAt: startedAt + 20,
      playerNames: { "team-a": "阿杰", "team-b": "老王" },
    },
    {
      id: "round-2",
      sequenceNo: 3,
      type: "round",
      occurredAt: startedAt + 30,
      playerNames: { "team-a": "阿杰", "team-b": "老王" },
      round: {
        playerIds: ["team-a", "team-b"],
        winnerId: "team-b",
        winType: "break_clear",
        fouls: { "team-a": 1, "team-b": 0 },
        note: "恢复后第二局",
        startedAt: startedAt + 21,
        confirmedAt: startedAt + 30,
      },
    },
  );
  return snapshot;
}

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

  test("团战流水局号不受暂停等非对局事件影响", async ({ page }) => {
    await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试房主", avatarUrl: null } } }));
    await page.route("**/api/history", (route) => route.fulfill({ json: { matches: [] } }));
    await page.route("**/api/realtime/rooms/ABC234", (route) => route.fulfill({ json: { snapshot: teamBattleSnapshotWithNonRoundEvent(), kicked: [] } }));
    await page.routeWebSocket("**/api/realtime/rooms/ABC234/connect**", () => {});

    await page.goto("/room/ABC234");

    const latestRound = page.locator(".team-pair-ledger article").first();
    await expect(latestRound.getByText("第 2 局", { exact: true })).toBeVisible();
    await expect(latestRound.getByText("第 3 局", { exact: true })).toHaveCount(0);
  });

  test("登录房主可直接创建实时团战，移动端计分并在只读角色下禁用写操作", async ({ page }) => {
    let viewerRole: "host" | "spectator" = "host";
    let directDraft: Record<string, unknown> | undefined;
    const socketMessages: Array<Record<string, unknown>> = [];
    await page.setViewportSize({ width: 320, height: 740 });
    await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "user-1", username: "tester", publicCode: "TEST0001", nickname: "测试房主", avatarUrl: null } } }));
    await page.route("**/api/history", (route) => route.fulfill({ json: { matches: [] } }));
    await page.route("**/api/realtime/rooms", (route) => route.fulfill({ json: { rooms: [] } }));
    await page.route("**/api/realtime/rooms/direct", async (route) => {
      directDraft = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ json: { matchId: "team-room-match", room: { code: "ABC234" } } });
    });
    await page.route("**/api/realtime/rooms/ABC234", (route) => route.fulfill({ json: { snapshot: teamBattleSnapshot(viewerRole), kicked: [] } }));
    await page.routeWebSocket("**/api/realtime/rooms/ABC234/connect**", (socket) => {
      socket.onMessage((message) => socketMessages.push(JSON.parse(String(message)) as Record<string, unknown>));
    });

    await page.goto("/");
    await page.getByRole("button", { name: /团战记分/ }).click();
    await expect(page.getByRole("button", { name: "开始本机团战" })).toBeVisible();
    await page.getByRole("button", { name: "创建实时房间" }).click();
    await expect(page).toHaveURL(/\/room\/ABC234$/);
    expect(directDraft).toMatchObject({
      mode: "team_battle",
      players: [{ name: "成员 1" }, { name: "成员 2" }],
    });

    await expect(page.getByRole("heading", { name: "团战实时" })).toBeVisible();
    const liveStatus = page.getByRole("status").filter({ hasText: "已连接服务器" });
    await expect(liveStatus).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.theme = "day"; });
    await expect(liveStatus).toHaveCSS("background-color", "rgb(238, 248, 242)");
    await page.evaluate(() => { document.documentElement.dataset.theme = "night"; });
    await expect(page.getByText("已认领：阿杰")).toBeVisible();
    await page.getByLabel("红方成员").focus();
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("蓝方成员")).toBeFocused();
    await page.getByRole("button", { name: "老王 获胜" }).click();
    await page.getByRole("button", { name: "炸清" }).click();
    await page.getByLabel("老王 本局犯规").fill("2");
    await page.getByRole("button", { name: "确认本局", exact: true }).click();
    await expect.poll(() => socketMessages.length).toBe(1);
    expect(socketMessages[0]).toMatchObject({
      type: "command",
      expectedVersion: 1,
      kind: "team_battle.round.record",
      payload: { winnerId: "team-b", winType: "break_clear", fouls: { "team-a": 0, "team-b": 2 } },
    });
    await page.getByRole("button", { name: "更正", exact: true }).click();
    await page.getByRole("button", { name: "保存更正" }).click();
    await expect.poll(() => socketMessages.length).toBe(2);
    expect(socketMessages[1]).toMatchObject({ kind: "team_battle.round.correct", payload: { eventId: "round-1" } });
    await page.getByRole("button", { name: /撤销当前组合上一局/ }).click();
    await page.getByRole("button", { name: "暂停团战" }).click();
    await expect.poll(() => socketMessages.length).toBe(4);
    expect(socketMessages.slice(2).map((message) => message.kind)).toEqual(["team_battle.round.undo", "team_battle.pause"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    viewerRole = "spectator";
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: "由房主负责团战计分" })).toBeVisible();
    await expect(page.getByRole("button", { name: "确认本局", exact: true })).toBeDisabled();
    await expect(page.getByLabel("红方成员")).toBeDisabled();
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

    await expect(page.getByRole("button", { name: "抽 1 张" })).toHaveCSS("background-color", "rgb(23, 107, 74)");
    await expect(page.getByRole("button", { name: "抽 1 张" })).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "调整下一轮手牌" })).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "调整下一轮手牌" })).toHaveCSS("opacity", "0.42");
    await expect(page.locator(".realtime-card-panel")).toHaveCSS("background-color", "rgb(255, 254, 250)");
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
    await expect(page.locator(".card-ledger")).toHaveCSS("background-color", "rgb(255, 254, 250)");
    await expect(page.locator(".realtime-rule-grid button")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.locator(".realtime-tool-grid > div")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.getByRole("button", { name: "黑金（双倍）" })).toHaveCSS("background-color", "rgb(255, 249, 231)");
    await expect(page.locator(".room-kicked")).toHaveCSS("background-color", "rgb(255, 254, 250)");
    await expect(page.locator(".realtime-player-slot > button")).toHaveCSS("background-color", "rgb(241, 250, 244)");
    await expect(page.locator(".realtime-eight-score strong")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.locator(".eight-scoreboard strong")).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(page.getByRole("button", { name: "结束对局" })).toHaveCSS("background-color", "rgb(201, 84, 76)");

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
