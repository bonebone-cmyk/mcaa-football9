import { describe, expect, it } from 'vitest';
import { allValid, checkPrimetimeInput, reconstructPrimetime, simulateGame, SimError, validateGame } from '../engine/index';
import type { LockedStats, PrimetimeInput } from '../engine/types';
import { makeTeam } from './fixtures';

const a = makeTeam('TUL'), h = makeTeam('FRS');
const rec = (input: PrimetimeInput, seed = 'pt') => reconstructPrimetime({ seed, teams: [a, h], input });
const line = (r: ReturnType<typeof rec>, id: string) => r.playerStats.find((l) => l.playerId === id)!;

describe('CFB 27 primetime reconstruction', () => {
  it('never changes an imported final score', () => {
    const scores: [number, number][] = [[38, 31], [3, 0], [2, 0], [0, 6], [9, 8], [63, 59], [13, 12], [24, 23], [5, 3], [70, 0], [21, 20], [16, 15], [11, 10], [4, 2], [45, 44]];
    scores.forEach(([x, y], i) => {
      const r = rec({ final: [x, y] }, `score-${i}`);
      expect(r.final).toEqual([x, y]);
      expect(r.plays[r.plays.length - 1].scoreAfter).toEqual([x, y]);
      expect(allValid(r), JSON.stringify(r.validation.filter((v) => !v.ok))).toBe(true);
    });
  });
  it('is not influenced by ratings or percentages: the imported winner always stands', () => {
    const weak = makeTeam('TUL', { rating: 45, pct: { activity: 0, upset: 0, star: 0 } }), strong = makeTeam('FRS', { rating: 99, pct: { activity: 100, upset: 100, star: 100 } });
    for (let i = 0; i < 8; i++) {
      const r = reconstructPrimetime({ seed: `mismatch-${i}`, teams: [weak, strong], input: { final: [38, 31] } });
      expect(r.final).toEqual([38, 31]);
      expect(r.percentageChecks).toHaveLength(0); // percentages are not rolled for an imported result
    }
  });
  it('reconciles supplied quarter scores exactly, including overtime', () => {
    for (let i = 0; i < 40; i++) {
      const s = simulateGame({ seed: `src-${i}`, teams: [a, h] });
      const r = rec({ final: s.final, quarters: s.quarters }, `q-${i}`);
      expect(r.quarters).toEqual(s.quarters);
      expect(r.final).toEqual(s.final);
      expect(r.overtimePeriods).toBe(s.overtimePeriods);
      expect(allValid(r)).toBe(true);
    }
    const ot = rec({ final: [34, 31], overtimePeriods: 1 });
    expect(ot.overtimePeriods).toBe(1);
    expect(ot.quarters[0].slice(0, 4).reduce((x, y) => x + y, 0)).toBe(ot.quarters[1].slice(0, 4).reduce((x, y) => x + y, 0));
  });
  it('keeps locked player statistics exactly as confirmed and generates the rest around them', () => {
    const r = rec({ final: [38, 31], locks: { players: { 'TUL-QB1': { passYds: 285, passTd: 3, passInt: 1 } } } });
    const qb = line(r, 'TUL-QB1');
    expect(qb).toMatchObject({ passYds: 285, passTd: 3, passInt: 1 });
    expect(qb.passAtt).toBeGreaterThanOrEqual(qb.passCmp); // generated, and consistent
    expect(qb.passCmp).toBeGreaterThan(8);
    expect(r.final).toEqual([38, 31]);
    expect(allValid(r)).toBe(true);
    // Receivers account for exactly the locked passing yards.
    expect(r.playerStats.filter((l) => l.side === 0).reduce((x, l) => x + l.recYds, 0)).toBe(285);
  });
  it('satisfies full locked box scores across passing, rushing, receiving, defense and kicking', () => {
    for (let i = 0; i < 12; i++) {
      const s = simulateGame({ seed: `box-${i}`, teams: [a, h] });
      if (s.overtimePeriods) continue;
      const locks: LockedStats = { players: {} };
      for (const l of s.playerStats) {
        const st: Record<string, number> = {};
        if (l.passAtt > 5) Object.assign(st, { passAtt: l.passAtt, passCmp: l.passCmp, passYds: l.passYds, passTd: l.passTd, passInt: l.passInt });
        if (l.rushAtt >= 4) Object.assign(st, { rushAtt: l.rushAtt, rushYds: l.rushYds, rushTd: l.rushTd });
        if (l.rec >= 3) Object.assign(st, { rec: l.rec, recYds: l.recYds, recTd: l.recTd });
        if (l.tklSolo + l.tklAst >= 6) Object.assign(st, { tackles: l.tklSolo + l.tklAst, sacks: l.sacks, defInt: l.defInt });
        if (l.fga || l.xpa) Object.assign(st, { fgm: l.fgm, fga: l.fga, xpm: l.xpm, xpa: l.xpa });
        if (Object.keys(st).length) locks.players[l.playerId] = st;
      }
      const r = rec({ final: s.final, locks }, `boxrec-${i}`);
      expect(r.final).toEqual(s.final);
      for (const [pid, st] of Object.entries(locks.players)) {
        const got = line(r, pid) as unknown as Record<string, number>;
        for (const [k, v] of Object.entries(st)) expect(k === 'tackles' ? got.tklSolo + got.tklAst : got[k], `${pid} ${k}`).toBe(v);
      }
      expect(allValid(r)).toBe(true);
    }
  });
  it('honours team-level locks', () => {
    const r = rec({ final: [24, 17], locks: { players: {}, teams: [{ passYds: 230, rushYds: 141, turnovers: 2 }, { turnovers: 0 }] } });
    expect(r.teamStats[0]).toMatchObject({ passYds: 230, rushYds: 141, turnovers: 2 });
    expect(r.teamStats[1].turnovers).toBe(0);
  });
  it('rejects impossible constraints and explains the conflict instead of altering inputs', () => {
    const bad = (input: PrimetimeInput, re: RegExp) => {
      let err: SimError | null = null;
      try { rec(input); } catch (e) { err = e as SimError; }
      expect(err, JSON.stringify(input)).toBeInstanceOf(SimError);
      expect([err!.message, ...err!.details].join(' ')).toMatch(re);
    };
    bad({ final: [21, 21] }, /tied/);
    bad({ final: [1, 14] }, /exactly 1 point/);
    bad({ final: [21, 14], quarters: [[7, 7, 0, 0], [7, 7, 0, 0]] }, /add up to 14/);
    bad({ final: [8, 3], quarters: [[1, 7, 0, 0], [3, 0, 0, 0]] }, /1 point in quarter 1/);
    bad({ final: [31, 28], quarters: [[7, 7, 7, 7, 3], [7, 7, 7, 0, 7]] }, /regulation is not tied/);
    bad({ final: [10, 3], locks: { players: { 'TUL-QB1': { passTd: 4 } } } }, /touchdown/);
    bad({ final: [14, 3], locks: { players: { 'TUL-K1': { fgm: 3 } } } }, /kicking/);
    bad({ final: [10, 3], locks: { players: { ghost: { passYds: 100 } } } }, /not on either roster/);
    bad({ final: [10, 3], locks: { players: { 'TUL-QB1': { passCmp: 20, passAtt: 15 } } } }, /completions exceed attempts/);
    bad({ final: [10, 3], locks: { players: { 'TUL-K1': { passYds: 50 } } } }, /cannot be credited/);
    bad({ final: [20, 3], locks: { players: { 'TUL-QB1': { passYds: 100 }, 'TUL-QB2': { passYds: 0 }, 'TUL-WR1': { recYds: 180 } } } }, /receiving yards .* exceed/);
    bad({ final: [17, 3], locks: { players: { 'TUL-QB1': { passInt: 0 }, 'FRS-CB1': { defInt: 2 } } } }, /interceptions/);
  });
  it('refuses to credit an inactive or unrostered player', () => {
    const t = makeTeam('TUL');
    t.roster.find((p) => p.id === 'TUL-WR2')!.active = false;
    expect(checkPrimetimeInput({ final: [10, 3], locks: { players: { 'TUL-WR2': { rec: 4 } } } }, [t, h]).join(' ')).toMatch(/inactive/);
    const r = reconstructPrimetime({ seed: 'inactive', teams: [t, h], input: { final: [27, 10] } });
    expect(r.playerStats.some((l) => l.playerId === 'TUL-WR2')).toBe(false);
  });
  it('produces a ledger that fails validation if anything authoritative is altered afterwards', () => {
    const r = rec({ final: [38, 31], locks: { players: { 'TUL-QB1': { passYds: 285 } } } });
    const tampered = { ...r, plays: r.plays.map((p) => ({ ...p })) };
    const c = tampered.plays.find((p) => p.type === 'pass' && p.complete && p.passer === 'TUL-QB1' && p.td == null)!;
    c.yards += 3;
    const v = validateGame(tampered, [a, h]);
    expect(v.every((x) => x.ok)).toBe(false);
  });
  it('labels the recap as reconstruction-based and keeps highlights tied to stored plays', () => {
    const r = rec({ final: [38, 31] });
    expect(r.mode).toBe('primetime');
    expect(r.recap.reconstruction).toBe(true);
    const seqs = new Set(r.plays.map((p) => p.seq));
    for (const hl of r.highlights) expect(seqs.has(hl.playSeq)).toBe(true);
  });
});
