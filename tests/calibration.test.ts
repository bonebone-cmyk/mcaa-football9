import { describe, expect, it } from 'vitest';
import { allValid, simulateGame } from '../engine/index';
import { DEF_SCHEMES, OFF_SCHEMES } from '../engine/types';
import { makeTeam } from './fixtures';

// Reference ranges are deliberately wider than recent FBS season averages: the goal is believable football, not a fixed answer.
describe('simulation calibration (600 evenly matched games across all schemes)', () => {
  const N = 600;
  const t = { pts: 0, pass: 0, rush: 0, plays: 0, to: 0, sacks: 0, cmp: 0, att: 0, home: 0, blow: 0, close: 0, ot: 0, invalid: 0, pen: 0, shootouts: 0, grinders: 0, comebacks: 0 };
  const finals = new Set<string>();
  for (let i = 0; i < N; i++) {
    const r = simulateGame({ seed: `calib-${i}`, teams: [makeTeam('AAA', { offScheme: OFF_SCHEMES[i % 8], defScheme: DEF_SCHEMES[(i * 3) % 9] }), makeTeam('HHH', { offScheme: OFF_SCHEMES[(i * 5) % 8], defScheme: DEF_SCHEMES[(i * 7) % 9] })] });
    if (!allValid(r)) t.invalid++;
    for (const s of r.teamStats) { t.pts += s.points; t.pass += s.passYds; t.rush += s.rushYds; t.plays += s.plays; t.to += s.turnovers; t.sacks += s.sacks; t.cmp += s.passCmp; t.att += s.passAtt; t.pen += s.penalties; }
    const m = r.final[1] - r.final[0];
    if (m > 0) t.home++;
    if (Math.abs(m) >= 21) t.blow++;
    if (Math.abs(m) <= 7) t.close++;
    if (r.overtimePeriods) t.ot++;
    if (r.final[0] + r.final[1] >= 70) t.shootouts++;
    if (r.final[0] + r.final[1] <= 34) t.grinders++;
    const w = m > 0 ? 1 : 0;
    if (r.plays.some((p) => p.scoreAfter[1 - w] - p.scoreAfter[w] >= 10)) t.comebacks++;
    finals.add(r.final.join('-'));
  }
  const per = (v: number) => v / (2 * N);
  const range = (name: string, v: number, lo: number, hi: number) => it(`${name}: ${v.toFixed(2)} within ${lo}-${hi}`, () => { expect(v).toBeGreaterThanOrEqual(lo); expect(v).toBeLessThanOrEqual(hi); });
  it('every game passes statistical validation', () => expect(t.invalid).toBe(0));
  range('points per team', per(t.pts), 22, 32);
  range('passing yards per team', per(t.pass), 200, 275);
  range('rushing yards per team', per(t.rush), 130, 195);
  range('plays per team', per(t.plays), 62, 76);
  range('completion percentage', (100 * t.cmp) / t.att, 56, 66);
  range('turnovers per team', per(t.to), 0.9, 1.9);
  range('sacks per team', per(t.sacks), 1.5, 3);
  range('penalties per team', per(t.pen), 4.5, 8);
  range('home win rate', t.home / N, 0.5, 0.64);
  range('blowout (21+) rate', t.blow / N, 0.1, 0.32);
  range('one-score game rate', t.close / N, 0.3, 0.55);
  range('overtime rate', t.ot / N, 0.015, 0.09);
  it('produces variety: shootouts, defensive battles, comebacks and many distinct final scores', () => {
    expect(t.shootouts).toBeGreaterThan(10);
    expect(t.grinders).toBeGreaterThan(10);
    expect(t.comebacks).toBeGreaterThan(20);
    expect(finals.size).toBeGreaterThan(250); // no hard-coded or repeated results
  });
});
