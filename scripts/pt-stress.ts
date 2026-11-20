import { reconstructPrimetime, allValid, simulateGame, SimError } from '../engine/index';
import type { LockedStats, PrimetimeInput } from '../engine/types';
import { makeTeam } from "../tests/fixtures";
import { Rng } from '../engine/rng';
import { repairStats } from '../engine/primetime';

const a = makeTeam('TUL'), h = makeTeam('FRS');
const rng = new Rng('stress');
let ok = 0, fail = 0, t = 0, worst = 0;
const run = (label: string, input: PrimetimeInput, seed: string, expectFail = false) => {
  const t0 = performance.now();
  try {
    const r = reconstructPrimetime({ seed, teams: [a, h], input });
    const dt = performance.now() - t0; t += dt; worst = Math.max(worst, dt);
    if (dt > 400) console.log(`SLOW ${dt.toFixed(0)}ms`, label);
    if (!allValid(r) || r.final[0] !== input.final[0] || r.final[1] !== input.final[1]) { fail++; console.log('INVALID', label, r.validation.filter((v) => !v.ok)); }
    else if (expectFail) { fail++; console.log('EXPECTED CONFLICT but succeeded:', label); }
    else ok++;
    return r;
  } catch (e) {
    const dt = performance.now() - t0; if (dt > 400) console.log(`SLOW(fail) ${dt.toFixed(0)}ms`, label);
    if (e instanceof SimError) { if (expectFail) ok++; else { fail++; console.log('CONFLICT', label, e.message, e.details.slice(0, 4)); } }
    else throw e;
  }
};
// 1. Plain scores.
const only = process.argv[2];
for (let i = 0; i < (only ? 0 : 300); i++) {
  let x = rng.int(0, 63), y = rng.int(0, 63);
  if (x === y) y++;
  if (x === 1) x = 2; if (y === 1) y = 2; if (x === y) y += 3;
  run(`plain ${x}-${y}`, { final: [x, y] }, `p${i}`);
}
run('38-31', { final: [38, 31] }, 'tulsa');
// 2. Quarter scores taken from real simulations.
for (let i = 0; i < (only ? 0 : 150); i++) {
  const s = simulateGame({ seed: `q${i}`, teams: [a, h] });
  run(`quarters ${s.final.join('-')} ${JSON.stringify(s.quarters)}`, { final: s.final, quarters: s.quarters }, `q${i}`);
}
// 3. Overtime count only.
run('OT 34-31', { final: [34, 31], overtimePeriods: 1 }, 'ot1');
run('OT 41-35', { final: [41, 35], overtimePeriods: 1 }, 'ot2');
run('2OT 45-42', { final: [45, 42], overtimePeriods: 2 }, 'ot3');
run('3OT 50-48', { final: [50, 48], overtimePeriods: 3 }, 'ot4');
// 4. Locked stats taken from real simulations (so they are known to be mutually consistent), in growing amounts.
const levels: ((l: any) => Record<string, number>)[] = [];
for (let i = 0; i < 120; i++) {
  const s = simulateGame({ seed: `L${i}`, teams: [a, h] });
  const locks: LockedStats = { players: {} };
  const level = i % 4;
  const lines = [...s.playerStats].sort((x, y) => (y.passAtt + y.rushAtt + y.rec) - (x.passAtt + x.rushAtt + x.rec));
  for (const l of lines) {
    const st: Record<string, number> = {};
    if (l.passAtt > 5) { st.passYds = l.passYds; st.passTd = l.passTd; st.passInt = l.passInt; if (level >= 1) { st.passAtt = l.passAtt; st.passCmp = l.passCmp; } }
    if (level >= 2 && l.rushAtt >= 4) { st.rushAtt = l.rushAtt; st.rushYds = l.rushYds; st.rushTd = l.rushTd; }
    if (level >= 2 && l.rec >= 3) { st.rec = l.rec; st.recYds = l.recYds; st.recTd = l.recTd; }
    if (level >= 3 && l.tklSolo + l.tklAst >= 5) { st.tackles = l.tklSolo + l.tklAst; st.sacks = l.sacks; st.defInt = l.defInt; }
    if (level >= 3 && (l.fga || l.xpa)) { st.fgm = l.fgm; st.fga = l.fga; st.xpm = l.xpm; st.xpa = l.xpa; }
    if (Object.keys(st).length) locks.players[l.playerId] = st;
  }
  const useQ = i % 3 === 0;
  if (s.overtimePeriods && !useQ) continue;
  run(`locks L${level} ${s.final.join('-')}`, { final: s.final, quarters: useQ ? s.quarters : null, locks }, `L${i}`);
}
// 5. The brief's example: QB locked at 285 yards, 3 TD, 1 INT in a 38-31 game.
const ex = run('example', { final: [38, 31], locks: { players: { 'TUL-QB1': { passYds: 285, passTd: 3, passInt: 1 } } } }, 'ex');
if (ex) console.log('example QB line:', ex.playerStats.find((l) => l.playerId === 'TUL-QB1'));
// 6. Impossible inputs must be rejected.
run('tie', { final: [21, 21] }, 'x1', true);
run('one point', { final: [1, 14] }, 'x2', true);
run('quarters mismatch', { final: [21, 14], quarters: [[7, 7, 0, 0], [7, 7, 0, 0]] }, 'x3', true);
run('too many TDs', { final: [10, 3], locks: { players: { 'TUL-QB1': { passTd: 4 } } } }, 'x4', true);
run('unrostered', { final: [10, 3], locks: { players: { 'nobody': { passYds: 100 } } } }, 'x5', true);
run('fg lock impossible', { final: [14, 3], locks: { players: { 'TUL-K1': { fgm: 3 } } } }, 'x6', true);
run('quarter of 1', { final: [8, 3], quarters: [[1, 7, 0, 0], [3, 0, 0, 0]] }, 'x7', true);
console.log(`repair: ${repairStats.runs} runs, avg ${(repairStats.iterations / Math.max(1, repairStats.runs)).toFixed(0)} iterations`);
console.log(`ok ${ok}, failed ${fail}, avg ${(t / ok).toFixed(1)} ms, worst ${worst.toFixed(0)} ms`);
