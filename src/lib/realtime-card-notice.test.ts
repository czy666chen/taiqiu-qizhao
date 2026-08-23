import { describe, expect, it } from "vitest";
import { createRealtimeCardNotice } from "./realtime-card-notice";

const playerName = (id: string) => ({ p1: "阿杰" })[id] ?? id;

describe("createRealtimeCardNotice", () => {
  it("keeps played and skipped card details but reveals no drawn card", () => {
    const card = { title: "乾坤挪移", effect: "交换两名玩家的当前分数" };
    expect(createRealtimeCardNotice({ kind: "card.played", payload: { playerId: "p1", card } }, playerName)).toEqual({ action: "play", playerName: "阿杰", card });
    expect(createRealtimeCardNotice({ kind: "card.skipped", payload: { playerId: "p1", card } }, playerName)).toEqual({ action: "skip", playerName: "阿杰", card });
    expect(createRealtimeCardNotice({ kind: "card.drawn", payload: { playerId: "p1", card } }, playerName)).toEqual({ action: "draw", playerName: "阿杰" });
  });
});
