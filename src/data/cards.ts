export interface CardDefinition {
  id: string;
  title: string;
  effect: string;
  count: number;
  needsReview?: boolean;
  riskLevel?: "medium";
  safetyNote?: string;
  supportedGames: SupportedGame[];
  ruleImpact: CardRuleImpact;
}

export type SupportedGame = "chinese_eight" | "snooker";
export type CardRuleImpact = "presentation" | "physical" | "turn" | "scoring" | "table_state";

export type CardCategory = "strategy" | "social" | "physical" | "chaos";
export type CardSafetyLevel = "low" | "medium" | "review";

const SOCIAL_PATTERN = /红包|朋友圈|红牛|夸奖|问一句|掰手腕|场外选手|微信|表白/;
const STRATEGY_PATTERN = /球权|自由球|开球权|花色球|目标球|进球袋口|黑8|移除|贴库|连杆|犯规|反弹|无效/;

// 逐张人工审阅。未列入 snooker 的牌会改变球值、合法顺序、台面状态或胜负条件。
const SNOOKER_COMPATIBLE_IDS = new Set([1, 7, 8, 9, 11, 12, 16, 17, 20, 22, 24, 25, 26, 28, 30, 35, 38, 39, 45, 47, 49]);
const CARD_RULE_IMPACTS: Record<number, CardRuleImpact> = {
  1:"physical",2:"scoring",3:"turn",4:"scoring",5:"table_state",6:"scoring",7:"presentation",8:"turn",9:"physical",10:"table_state",
  11:"turn",12:"turn",13:"table_state",14:"turn",15:"table_state",16:"physical",17:"turn",18:"turn",19:"scoring",20:"physical",
  21:"table_state",22:"physical",23:"scoring",24:"physical",25:"physical",26:"turn",27:"scoring",28:"physical",29:"scoring",30:"physical",
  31:"table_state",32:"scoring",33:"scoring",34:"table_state",35:"turn",36:"scoring",37:"table_state",38:"physical",39:"turn",40:"turn",
  41:"scoring",42:"table_state",43:"table_state",44:"turn",45:"physical",46:"scoring",47:"physical",48:"table_state",49:"presentation",50:"table_state",
};

export function getCardCategory(cardDefinition: CardDefinition): CardCategory {
  if (cardDefinition.safetyNote || cardDefinition.riskLevel === "medium") return "physical";
  if (SOCIAL_PATTERN.test(`${cardDefinition.title}${cardDefinition.effect}`)) return "social";
  if (STRATEGY_PATTERN.test(`${cardDefinition.title}${cardDefinition.effect}`)) return "strategy";
  return "chaos";
}

export function getCardSafetyLevel(cardDefinition: CardDefinition): CardSafetyLevel {
  if (cardDefinition.needsReview) return "review";
  if (cardDefinition.safetyNote || cardDefinition.riskLevel === "medium") return "medium";
  return "low";
}

const card = (
  id: number,
  title: string,
  effect: string,
  count = 1,
  needsReview = false,
  safetyNote?: string,
  riskLevel?: "medium",
): CardDefinition => ({
  id: `card-${String(id).padStart(3, "0")}`,
  title,
  effect,
  count,
  supportedGames: SNOOKER_COMPATIBLE_IDS.has(id) ? ["chinese_eight", "snooker"] : ["chinese_eight"],
  ruleImpact: CARD_RULE_IMPACTS[id],
  ...(needsReview ? { needsReview } : {}),
  ...(riskLevel ? { riskLevel } : {}),
  ...(safetyNote ? { safetyNote } : {}),
});

export const CARD_DEFINITIONS: CardDefinition[] = [
  card(1,"落井下石","对手下一杆无论距离，必须使用架杆。"),
  card(2,"人和","本局游戏对手让己方后二。"),
  card(3,"我的地盘听我的","使对手此次获得的全场自由变为线上自由；或者在己方击球前，直接获得线上自由球。"),
  card(4,"地利","本局游戏对手让己方前三。"),
  card(5,"低保户","对手只剩黑8时，己方还有两颗或以上的花色球，立即交换击球权并获得自由球。"),
  card(6,"自恋狂","对手每进一球必须问一句“难不难”；忘了需罚球一颗并交换球权。"),
  card(7,"RED闷","对手落败时需购买一瓶红牛，向己方双手奉上，并配合词“心服口服”。",1,true),
  card(8,"反弹","将对手向己方所出的卡牌效果反弹至对手身上，下一回合生效。"),
  card(9,"物理学","对手下一杆必须以翻袋的方式完成进球。"),
  card(10,"消消乐","可将己方两颗紧密相贴的球任意移除一颗（两球之间不可有缝隙）。"),
  card(11,"凤雏","对手下一杆由对手邀请一位场外选手替对手击打。"),
  card(12,"听天由命","对手需石头剪刀布获胜才可连杆。"),
  card(13,"损人利己","对手将己方和对方的球同时打进后，可将对手的进球拿出放至黑8点位或附近；己方算进，并获得球权。"),
  card(14,"半免死金牌","可免除己方一次非落袋自由球（白球掉袋、打飞，不可免）。"),
  card(15,"大变活球","己方击球前，可移除任意一颗花色球。"),
  card(16,"纷乱头脑","对手出杆之前必须原地转10圈。",1,false,"可能造成眩晕或跌倒，身体不适或场地狭小时请跳过。"),
  card(17,"卧龙","对手下一杆由己方邀请一位场外选手替对手击打。"),
  card(18,"落井下石","对手开球没下，己方获得全场自由球。如遇上“关系户”卡，只能暂避锋芒，换卡一张。"),
  card(19,"祸不单行","对手下一杆白球必须先碰撞单数球；犯规则己方获得自由球。"),
  card(20,"金鸡独立","对手下一杆必须以单腿站立的方式完成击打。",1,false,"请先确认站立稳定，避免在湿滑地面或身体不适时尝试。"),
  card(21,"恶魔契约","分球后移除己方所有花色球，只留黑8；但打不进时，对方可移除一颗花色球并获得线上自由。当对手只剩黑8时，直接获胜。"),
  card(22,"杰克船长","对手下一杆击球只能用一只眼睛瞄准和击打。",1,false,undefined,"medium"),
  card(23,"双喜临门","对手下一杆白球必须先碰撞双数球；犯规则己方获得自由球。"),
  card(24,"杨过大侠","对手下一杆必须单手持杆击球，不可使用手架和架杆。",1,false,"单手击球更难控制球杆，请降低力度并保持安全距离。"),
  card(25,"天黑喽","对手下一杆瞄准后，须紧闭双眼完成击打。",1,false,"闭眼击球存在碰撞风险，仅在确认周围无人且双方同意时尝试。"),
  card(26,"无懈可击","使对手此次所出的卡牌无效。",2),
  card(27,"天时","本局游戏对手让己方后二。"),
  card(28,"倒反天罡","对手下一杆击球必须为反手握杆击球。",1,false,"反手动作可能失控，请降低力度并留出充足空间。"),
  card(29,"听我指挥","发动此卡即可指定对手下一次所要打进的球；进错则拿出至黑8点位或附近。",1,true),
  card(30,"本末倒置","对手下一杆必须用球杆尾部击球。",1,false,"部分球房禁止杆尾击球；请先确认球房规定并保护台呢。"),
  card(31,"亡羊补牢","当击打己方花色球时，误将对方球打进，可将对方球拿出放至黑8点位或附近。"),
  card(32,"兔子不吃窝边草","此次出杆禁止对方击打袋口球，黑8除外。袋口球指距离袋口两颗球距离及以内的球。"),
  card(33,"快刀斩乱麻","对手的下一杆必须在两秒内击球，超时罚球一颗。",1,false,"不要因计时仓促挥杆；安全优先，场地拥挤时请跳过。"),
  card(34,"买一送一","己方进球时，由对手为己方额外选择一颗球拿进（黑8除外）。",1,true),
  card(35,"猛男福利","掰手腕获胜者获得开球权。如遇上“关系户”卡，只能暂避锋芒，换卡一张。"),
  card(36,"洁癖","对手此次击打的花色球不可以碰任何库和球，否则进球无效。"),
  card(37,"分享既是关心","发动此卡后，对手每进一个球，己方也移除一个球。对手进球连杆时，己方最多移除两个。"),
  card(38,"花里胡哨","对手下一杆必须用背后出杆的方式击打。",1,false,"背后出杆视野有限，请确认身后无人并降低击球力度。"),
  card(39,"光明偷偷","发动此卡，可在对方现有手牌中抽取一张。"),
  card(40,"关系户","直接获得开球权，有无下球都可连杆。开球下白球作废，对手获得线上自由。"),
  card(41,"情绪价值","己方每进一球，对手必须夸奖“哥哥打得好”；忘记夸奖罚球一颗。"),
  card(42,"拿来吧你","分球时可强行获得对手所选花色球，分球者继续击球。"),
  card(43,"施法即是防御","此球打进，可将对手一颗球移至贴库。",1,true),
  card(44,"不再错过","击打目标球未进，可使用此卡再次击打，但目标球不可更换（黑8除外）。"),
  card(45,"表白卡","对手下一杆由己方用“比心手势”的手架代替对手的手架。",1,false,"双人靠近球杆时须先沟通，避免手部被球杆碰伤。"),
  card(46,"金主爸爸","打几号球未进，可向对手发几元红包，把球买进并继续连杆。"),
  card(47,"缴械","对手下一杆击球不许使用架杆，只能手架。"),
  card(48,"指哪打哪","替对手指定下一球的进球袋口；如进错袋口，拿出至黑8点位或附近。"),
  card(49,"准神","连续进球5个及以上，即可获得“准神”称号；对手需要修改微信备注并截图发朋友圈称赞。"),
  card(50,"背水一战","对手打进黑8时，可将黑8放回开球点位，白球位置不变；对手再次击打，如果没进，己方将一颗花色球移除并获得击球权。"),
];
