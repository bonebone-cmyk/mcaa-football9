// Batch calibration: simulates many games and prints league-style averages next to FBS reference ranges.
import { simulateGame, allValid } from '../engine/index';
import { makeTeam } from "../tests/fixtures";
import { OFF_SCHEMES, DEF_SCHEMES } from '../engine/types';

const N = Number(process.argv[2] ?? 2000);
const gap = Number(process.argv[3] ?? 0);
const t0 = Date.now();
const agg = { pts: 0, passYds: 0, rushYds: 0, plays: 0, to: 0, sacks: 0, cmp: 0, att: 0, rushAtt: 0, pen: 0, penYds: 0, homeWins: 0, favWins: 0, blowouts: 0, close: 0, ot: 0, invalid: 0, int: 0, fum: 0, fg: 0, fga: 0, punts: 0, third: 0, thirdAtt: 0, shutouts: 0, high: 0, low: 0, drives: 0, firstDowns: 0, comebacks: 0 };
const hist: Record<number, number> = {};
for (let i = 0; i < N; i++) {
  const a = makeTeam('AAA', { rating: 75 - gap / 2, offScheme: OFF_SCHEMES[i % OFF_SCHEMES.length], defScheme: DEF_SCHEMES[(i * 3) % DEF_SCHEMES.length] });
  const h = makeTeam('HHH', { rating: 75 + gap / 2, offScheme: OFF_SCHEMES[(i * 5) % OFF_SCHEMES.length], defScheme: DEF_SCHEMES[(i * 7) % DEF_SCHEMES.length] });
  const r = simulateGame({ seed: `cal-${i}`, teams: [a, h] });
  if (!allValid(r)) { agg.invalid++; if (agg.invalid <= 3) console.log(`INVALID seed cal-${i}`, r.validation.filter((v) => !v.ok)); }
  for (const t of r.teamStats) {
    agg.pts += t.points; agg.passYds += t.passYds; agg.rushYds += t.rushYds; agg.plays += t.plays; agg.to += t.turnovers; agg.sacks += t.sacks;
    agg.cmp += t.passCmp; agg.att += t.passAtt; agg.rushAtt += t.rushAtt; agg.pen += t.penalties; agg.penYds += t.penaltyYds; agg.int += t.intThrown; agg.fum += t.fumblesLost;
    agg.punts += t.punts; agg.third += t.thirdConv; agg.thirdAtt += t.thirdAtt; agg.firstDowns += t.firstDowns;
    if (t.points === 0) agg.shutouts++;
  }
  for (const l of r.playerStats) { agg.fg += l.fgm; agg.fga += l.fga; }
  agg.drives += r.drives.length;
  const m = r.final[1] - r.final[0];
  if (m > 0) agg.homeWins++;
  if (Math.abs(m) >= 21) agg.blowouts++;
  if (Math.abs(m) <= 7) agg.close++;
  if (r.overtimePeriods) agg.ot++;
  const tot = r.final[0] + r.final[1];
  if (tot >= 70) agg.high++;
  if (tot <= 30) agg.low++;
  const w = m > 0 ? 1 : 0;
  let maxDef = 0; for (const p of r.plays) maxDef = Math.max(maxDef, p.scoreAfter[1 - w] - p.scoreAfter[w]);
  if (maxDef >= 10) agg.comebacks++;
  hist[Math.min(70, Math.floor(r.final[0] / 7) * 7)] = (hist[Math.min(70, Math.floor(r.final[0] / 7) * 7)] ?? 0) + 1;
}
const per = (v: number) => (v / (2 * N)).toFixed(2);
const pctOf = (v: number) => ((100 * v) / N).toFixed(1) + '%';
console.log(`${N} games, rating gap ${gap} (home favored), ${((Date.now() - t0) / N).toFixed(2)} ms/game`);
console.table({
  'Points / team': [per(agg.pts), '24-31'],
  'Pass yds / team': [per(agg.passYds), '215-255'],
  'Rush yds / team (sacks incl.)': [per(agg.rushYds), '150-185'],
  'Plays / team': [per(agg.plays), '64-74'],
  'Completion %': [((100 * agg.cmp) / agg.att).toFixed(1), '59-64'],
  'Yards / pass att': [(agg.passYds / agg.att).toFixed(2), '7.0-7.9'],
  'Yards / rush': [(agg.rushYds / agg.rushAtt).toFixed(2), '4.1-4.8'],
  'Turnovers / team': [per(agg.to), '1.1-1.6'],
  'INT / team': [per(agg.int), '0.6-0.9'],
  'Fumbles lost / team': [per(agg.fum), '0.4-0.7'],
  'Sacks / team': [per(agg.sacks), '1.8-2.5'],
  'Penalties / team': [per(agg.pen), '5.5-7.0'],
  'Penalty yds / team': [per(agg.penYds), '48-62'],
  'Punts / team': [per(agg.punts), '3.6-4.8'],
  'FG made / team': [per(agg.fg), '1.1-1.6'],
  'FG %': [((100 * agg.fg) / agg.fga).toFixed(1), '72-80'],
  '3rd down %': [((100 * agg.third) / agg.thirdAtt).toFixed(1), '37-43'],
  'First downs / team': [per(agg.firstDowns), '19-23'],
  'Drives / game': [(agg.drives / N).toFixed(1), '23-27'],
  'Home win %': [pctOf(agg.homeWins), gap ? 'n/a' : '55-62'],
  'Blowouts (21+)': [pctOf(agg.blowouts), gap ? 'n/a' : '15-25'],
  'One-score games': [pctOf(agg.close), gap ? 'n/a' : '38-50'],
  'Overtime': [pctOf(agg.ot), '3-6'],
  'Winner trailed by 10+': [pctOf(agg.comebacks), '8-16'],
  '70+ total points': [pctOf(agg.high), '8-18'],
  '<=30 total points': [pctOf(agg.low), '5-12'],
  'Shutouts (team-games)': [((100 * agg.shutouts) / (2 * N)).toFixed(2) + '%', '1-3'],
  'Invalid games': [agg.invalid, '0'],
});
console.log('Away score histogram (7-pt bins):', hist);
