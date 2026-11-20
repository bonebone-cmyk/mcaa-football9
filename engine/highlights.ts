// Highlight selection. Every highlight points at a play that exists in the ledger; nothing is written that the ledger does not contain.
import type { Highlight, Play, Side } from './types';

/** Simple home-team win probability from lead and time left. Used only to rank swings. */
export function winProb(homeLead: number, secondsLeft: number): number {
  const z = homeLead / (0.9 + 0.42 * Math.sqrt(Math.max(secondsLeft, 0)));
  return 1 / (1 + Math.exp(-1.7 * z));
}

const secondsLeft = (p: Play, qs: number) => (p.quarter > 4 ? 0 : (4 - p.quarter) * qs + p.clock);

export function selectHighlights(plays: Play[], teamName: [string, string], final: [number, number], quarterSeconds = 900): Highlight[] {
  const winner: Side = final[1] > final[0] ? 1 : 0;
  // The game-winning play: the last score that put the winner ahead for good.
  let winnerSeq = -1;
  {
    let prev: [number, number] = [0, 0];
    for (const p of plays) {
      if (p.points) {
        const before = prev[winner] - prev[winner === 0 ? 1 : 0];
        const after = p.scoreAfter[winner] - p.scoreAfter[winner === 0 ? 1 : 0];
        if (before <= 0 && after > 0) winnerSeq = p.seq;
        else if (after <= 0) winnerSeq = -1;
      }
      prev = p.scoreAfter;
    }
  }
  const cands: (Highlight & { _score: number })[] = [];
  let prev: [number, number] = [0, 0];
  let firstScore = true;
  for (const p of plays) {
    const before = prev;
    prev = p.scoreAfter;
    const off = p.offense;
    const def: Side = off === 0 ? 1 : 0;
    let score = 0;
    let title = '';
    let side: Side = off;
    const tags: string[] = [];
    const big = p.yards >= 25 && (p.type === 'run' || (p.type === 'pass' && p.complete));

    if (p.td != null) {
      side = p.td;
      if (p.type === 'kickoff' || p.type === 'punt') (score = 85), (title = `${p.type === 'punt' ? 'Punt' : 'Kickoff'} Return Touchdown`), tags.push('return');
      else if (p.td !== off) (score = 90), (title = p.turnover === 'interception' ? 'Pick-Six' : 'Scoop and Score'), tags.push('defense', 'turnover');
      else (score = 55 + Math.min(p.yards, 60) * 0.5), (title = 'Touchdown'), tags.push('scoring');
      if (p.td === off && p.yards >= 25) tags.push('explosive');
    } else if (p.points?.kind === 'SAFETY') (score = 55), (side = p.points.side), (title = 'Safety'), tags.push('defense', 'scoring');
    else if (p.type === 'field_goal') {
      if (p.good) (score = 18 + ((p.fgDistance ?? 0) >= 45 ? 10 : 0)), (title = 'Field Goal'), tags.push('scoring');
      else (score = p.blockedBy ? 34 : 14), (side = def), (title = p.blockedBy ? 'Blocked Field Goal' : 'Missed Field Goal'), tags.push('defense');
    } else if (p.turnover === 'interception') (score = 42 + (p.returnYards ?? 0) * 0.3), (side = def), (title = 'Interception'), tags.push('defense', 'turnover');
    else if (p.turnover === 'fumble') (score = 38), (side = def), (title = 'Fumble Recovery'), tags.push('defense', 'turnover');
    else if (p.turnover === 'downs') (score = 30 + (p.ballOn >= 95 ? 25 : p.ballOn >= 80 ? 10 : 0)), (side = def), (title = p.ballOn >= 95 ? 'Goal-Line Stand' : 'Fourth-Down Stop'), tags.push('defense');
    else if (p.fourthDownTry && p.firstDown) (score = 26 + (big ? p.yards * 0.4 : 0)), (title = 'Fourth-Down Conversion');
    else if (big) (score = 14 + p.yards * 0.5), (title = p.type === 'run' ? 'Breakaway Run' : 'Big Pass Play'), tags.push('explosive');
    else if (p.type === 'sack' && (p.down ?? 0) >= 3) (score = 12), (side = def), (title = 'Third-Down Sack'), tags.push('defense');
    else if (p.type === 'two_point') (score = p.good ? 20 : 16), (side = p.good ? off : def), (title = p.good ? 'Two-Point Conversion' : 'Two-Point Stop');
    if (!score) continue;

    const t = secondsLeft(p, quarterSeconds);
    const swing = Math.abs(winProb(p.scoreAfter[1] - p.scoreAfter[0], t) - winProb(before[1] - before[0], t));
    score += swing * 120;
    const leadBefore = before[side] - before[side === 0 ? 1 : 0];
    const leadAfter = p.scoreAfter[side] - p.scoreAfter[side === 0 ? 1 : 0];
    let context = '';
    if (p.points) {
      const o: Side = side === 0 ? 1 : 0;
      const line = `${teamName[side]} ${p.scoreAfter[side]}, ${teamName[o]} ${p.scoreAfter[o]}`;
      if (firstScore) (context = ' First points of the game.'), (firstScore = false);
      else if (leadBefore < 0 && leadAfter > 0) (score += 18), (context = ` Go-ahead score: ${line}.`), tags.push('lead-change');
      else if (leadBefore === 0 && leadAfter > 0) (score += 12), (context = ` Breaks the tie: ${line}.`), tags.push('lead-change');
      else if (leadBefore < 0 && leadAfter === 0) (score += 12), (context = ` Ties the game at ${p.scoreAfter[0]}.`), tags.push('tie');
      else if (leadAfter < 0) {
        context = ` Cuts the deficit to ${-leadAfter}: ${line}.`;
        if (leadBefore <= -14 && leadAfter >= -8) (score += 10), tags.push('comeback');
      } else context = ` Extends the lead to ${leadAfter}: ${line}.`;
    }
    if (p.quarter > 4) (score *= 1.4), tags.push('overtime');
    else if (p.quarter === 4 && p.clock <= 300) (score *= 1.35), tags.push('late');
    else if (p.quarter === 4) score *= 1.15;
    if (p.seq === winnerSeq) (score += 60), (title = `Game-Winning ${title}`), tags.push('game-winning');
    cands.push({ playSeq: p.seq, quarter: p.quarter, clock: p.clock, side, title: `${teamName[side]} ${title}`, text: `${p.desc}${context}`, rank: 0, tags, _score: score });
  }
  cands.sort((a, b) => b._score - a._score || a.playSeq - b.playSeq);
  const strong = cands.filter((c) => c._score >= 30).length;
  const n = Math.min(cands.length, Math.max(5, Math.min(strong, strong >= 18 ? 16 : 12)));
  const picked = cands.slice(0, n);
  picked.forEach((c, i) => (c.rank = i + 1));
  picked.sort((a, b) => a.playSeq - b.playSeq);
  return picked.map(({ _score, ...h }) => h);
}
