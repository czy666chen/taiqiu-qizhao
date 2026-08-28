import type { ReactNode } from "react";

export interface HeadToHeadScoreboardSide {
  id: string;
  name: string;
  label: string;
  score: number;
  stats: Array<{ label: string; value: ReactNode }>;
}

export function HeadToHeadScoreboard({ sides, layout = "split", onNameChange }: {
  sides: [HeadToHeadScoreboardSide, HeadToHeadScoreboardSide];
  layout?: "split" | "stacked";
  onNameChange?: (playerId: string, name: string) => void;
}) {
  return <section className={`eight-scoreboard head-to-head-scoreboard ${layout}`} aria-label={`${sides[0].name} 对阵 ${sides[1].name}`}>
    {sides.map((side, index) => <article key={side.id} className={index ? "blue" : "red"}>
      <div>
        {onNameChange
          ? <input aria-label={`${side.name}姓名`} value={side.name} onChange={(event) => onNameChange(side.id, event.target.value)} />
          : <b>{side.name}</b>}
        <small>{side.label}</small>
      </div>
      <strong>{side.score}</strong>
      <dl>{side.stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}</dl>
    </article>)}
  </section>;
}
