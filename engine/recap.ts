// Grounded recap writer. Deterministic: it only restates facts that exist in the validated result.
import { periodLabel } from './describe';
import { Rng } from './rng';
import type { GameResult, PlayerLine, Recap, Side, TeamInput } from './types';

const pl = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface RecapFacts {
  winner: Side;
  loser: Side;
  margin: number;
  maxDeficit: number;
  overtime: number;
  leaders: { side: Side; passer?: PlayerLine; rusher?: PlayerLine; receiver?: PlayerLine; defender?: PlayerLine }[];
}

export function recapFacts(r: Pick<GameResult, 'final' | 'playerStats' | 'plays' | 'overtimePeriods'>): RecapFacts {
  const winner: Side = r.final[1] > r.final[0] ? 1 : 0;
  const loser: Side = winner === 0 ? 1 : 0;
  let maxDeficit = 0;
  for (const p of r.plays) maxDeficit = Math.max(maxDeficit, p.scoreAfter[loser] - p.scoreAfter[winner]);
  const leaders = ([0, 1] as Side[]).map((side) => {
    const ls = r.playerStats.filter((l) => l.side === side);
    const top = (f: (l: PlayerLine) => number, min = 1) => [...ls].sort((a, b) => f(b) - f(a) || a.playerId.localeCompare(b.playerId)).find((l) => f(l) >= min);
    return {
      side,
      passer: top((l) => l.passYds + l.passAtt * 0.01, 1),
      rusher: top((l) => l.rushYds + l.rushTd * 20, 10),
      receiver: top((l) => l.recYds + l.recTd * 15, 10),
      defender: top((l) => l.tklSolo + l.tklAst * 0.5 + l.sacks * 3 + l.defInt * 5 + l.fr * 4, 3),
    };
  });
  return { winner, loser, margin: r.final[winner] - r.final[loser], maxDeficit, overtime: r.overtimePeriods, leaders };
}

export function writeRecap(r: Pick<GameResult, 'final' | 'playerStats' | 'teamStats' | 'plays' | 'overtimePeriods' | 'highlights' | 'quarters' | 'scoring' | 'mode' | 'seed'>, teams: [TeamInput, TeamInput]): Recap {
  const rng = new Rng(`${r.seed}/recap`);
  const f = recapFacts(r);
  const name = (id: string) => teams[0].roster.find((p) => p.id === id)?.name ?? teams[1].roster.find((p) => p.id === id)?.name ?? '';
  const W = teams[f.winner];
  const Lz = teams[f.loser];
  const ws = r.final[f.winner];
  const ls = r.final[f.loser];
  const comeback = f.maxDeficit >= 10;
  const otLabel = f.overtime === 1 ? 'in overtime' : `in ${f.overtime} overtimes`;

  // Past tense throughout: it reads naturally for any team name, singular or plural.
  const verb = f.overtime
    ? 'outlasted'
    : comeback
      ? 'rallied past'
      : f.margin <= 3
        ? rng.pick(['edged', 'slipped past', 'survived'])
        : f.margin <= 8
          ? rng.pick(['held off', 'got past', 'topped'])
          : f.margin <= 17
            ? rng.pick(['beat', 'handled', 'pulled away from'])
            : f.margin <= 27
              ? rng.pick(['rolled past', 'cruised past'])
              : rng.pick(['routed', 'overwhelmed']);
  const poss = (n: string) => (n.endsWith('s') ? `${n}'` : `${n}'s`);
  const headline = `${W.name} ${ws}, ${Lz.name} ${ls}${f.overtime ? (f.overtime === 1 ? ' (OT)' : ` (${f.overtime}OT)`) : ''}`;

  const paras: string[] = [];
  // Lead.
  {
    let s = `${W.name} ${verb} ${Lz.name} ${ws}-${ls}${f.overtime ? ` ${otLabel}` : ''}`;
    if (comeback) s += `, erasing a ${f.maxDeficit}-point deficit`;
    s += '.';
    if (W.record && Lz.record) s += ` ${W.name} moved to ${W.record.w + 1}-${W.record.l}, while ${Lz.name} fell to ${Lz.record.w}-${Lz.record.l + 1}.`;
    paras.push(s);
  }
  // Leaders.
  const leaderPara = (side: Side) => {
    const l = f.leaders[side];
    const bits: string[] = [];
    if (l.passer && l.passer.passAtt > 0) {
      const p = l.passer;
      bits.push(`${name(p.playerId)} completed ${p.passCmp} of ${p.passAtt} passes for ${pl(p.passYds, 'yard')}${p.passTd ? ` and ${pl(p.passTd, 'touchdown')}` : ''}${p.passInt ? ` with ${pl(p.passInt, 'interception')}` : ''}`);
    }
    if (l.rusher) {
      const p = l.rusher;
      bits.push(`${name(p.playerId)} ran ${pl(p.rushAtt, 'time')} for ${pl(p.rushYds, 'yard')}${p.rushTd ? ` and ${pl(p.rushTd, 'score')}` : ''}`);
    }
    if (l.receiver) {
      const p = l.receiver;
      bits.push(`${name(p.playerId)} caught ${pl(p.rec, 'pass', 'passes')} for ${pl(p.recYds, 'yard')}${p.recTd ? ` and ${pl(p.recTd, 'touchdown')}` : ''}`);
    }
    if (!bits.length) return '';
    return `For ${teams[side].name}, ${bits.join('; ')}.`;
  };
  const wl = leaderPara(f.winner);
  if (wl) paras.push(wl);

  // Flow of the game.
  {
    const half = [0, 1].map((s) => r.quarters[s][0] + r.quarters[s][1]);
    const third = [0, 1].map((s) => half[s] + r.quarters[s][2]);
    const lead = (x: number[]) => `${Math.max(x[0], x[1])}-${Math.min(x[0], x[1])}`;
    const hl = half[0] === half[1] ? -1 : half[1] > half[0] ? 1 : 0;
    const tl = third[0] === third[1] ? -1 : third[1] > third[0] ? 1 : 0;
    let s = hl < 0 ? `The teams were tied ${half[0]}-${half[1]} at halftime` : `${teams[hl === 1 ? 1 : 0].name} led ${lead(half)} at halftime`;
    if (tl < 0) s += `, and the score was level at ${third[0]} entering the fourth quarter.`;
    else if (tl === hl) s += ` and ${lead(third)} after three quarters.`;
    else s += `, and ${teams[tl === 1 ? 1 : 0].name} took a ${lead(third)} lead into the fourth quarter.`;
    const late = r.scoring.filter((e) => e.quarter >= 4 && e.kind !== 'XP' && e.kind !== '2PT');
    if (late.length) {
      const last = late[late.length - 1];
      const when = last.quarter <= 4 ? `with ${Math.floor(last.clock / 60)}:${String(last.clock % 60).padStart(2, '0')} left in regulation` : `in ${periodLabel(last.quarter) === 'OT' ? 'overtime' : `the ${periodLabel(last.quarter).replace('OT', '')}${['', 'st', 'nd', 'rd'][last.quarter - 4] ?? 'th'} overtime`}`;
      s += ` There ${late.length === 1 ? 'was' : 'were'} ${pl(late.length, 'scoring play')} in the ${f.overtime ? 'fourth quarter and overtime' : 'fourth quarter'}; the last, ${when}, made it ${last.score[f.winner]}-${last.score[f.loser]}.`;
    }
    paras.push(s);
  }
  // Turning point.
  {
    const key = [...r.highlights].sort((a, b) => a.rank - b.rank)[0];
    if (key) paras.push(`The key moment: ${key.text}`);
  }
  const ll = leaderPara(f.loser);
  if (ll) paras.push(ll);
  // Defense and team numbers.
  {
    const tw = r.teamStats[f.winner];
    const tl = r.teamStats[f.loser];
    const bits: string[] = [`${W.name} gained ${pl(tw.totalYds, 'yard')} to ${poss(Lz.name)} ${tl.totalYds}`];
    if (tl.turnovers || tw.turnovers) bits.push(`${W.name} forced ${pl(tl.turnovers, 'turnover')} and committed ${tw.turnovers}`);
    if (tw.sacks) bits.push(`the ${W.name} defense recorded ${pl(tw.sacks, 'sack')}`);
    bits.push(`${W.name} converted ${tw.thirdConv} of ${tw.thirdAtt} third downs, ${Lz.name} ${tl.thirdConv} of ${tl.thirdAtt}`);
    let s = `${bits.join('; ')}.`;
    const d = f.leaders[f.winner].defender;
    if (d) {
      const extra = [d.sacks ? pl(d.sacks, 'sack') : '', d.defInt ? pl(d.defInt, 'interception') : '', d.fr ? pl(d.fr, 'fumble recovery', 'fumble recoveries') : ''].filter(Boolean);
      s += ` ${name(d.playerId)} led the ${W.name} defense with ${pl(d.tklSolo + d.tklAst, 'tackle')}${extra.length ? ` and ${extra.join(', ')}` : ''}.`;
    }
    paras.push(s);
  }
  const reconstruction = r.mode === 'primetime';
  return { headline, text: paras.join('\n\n'), source: 'template', reconstruction };
}
