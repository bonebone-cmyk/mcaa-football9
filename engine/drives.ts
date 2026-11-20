import type { Drive, DriveResult, Play } from './types';

/** Rebuild drive records purely from a play ledger (used when a ledger arrives from outside the simulator). */
export function rebuildDrives(plays: Play[]): Drive[] {
  const nums = [...new Set(plays.filter((p) => p.drive > 0).map((p) => p.drive))].sort((a, b) => a - b);
  return nums.map((num) => {
    const dp = plays.filter((p) => p.drive === num);
    const core = dp.filter((p) => p.type !== 'extra_point' && p.type !== 'two_point' && p.type !== 'timeout');
    const scr = core.filter((p) => p.type === 'run' || p.type === 'pass' || p.type === 'sack' || p.type === 'kneel');
    const first = dp[0];
    const last = core[core.length - 1];
    const side = first.offense;
    let result: DriveResult = first.quarter <= 2 ? 'END_HALF' : 'END_GAME';
    if (!last) result = dp.some((p) => p.type === 'two_point' && p.good) ? 'TD' : 'DOWNS';
    else if (last.td === side) result = 'TD';
    else if (last.type === 'field_goal') result = last.good ? 'FG' : 'MISSED_FG';
    else if (last.type === 'punt') result = 'PUNT';
    else if (last.turnover === 'interception') result = 'INT';
    else if (last.turnover === 'fumble') result = 'FUMBLE';
    else if (last.turnover === 'downs') result = 'DOWNS';
    else if (last.points?.kind === 'SAFETY') result = 'SAFETY';
    const lastAny = dp[dp.length - 1];
    const nxt = plays[plays.indexOf(lastAny) + 1];
    const endClock = nxt && nxt.quarter === lastAny.quarter ? nxt.clock : 0;
    return {
      num, side, quarter: first.quarter, startClock: first.clock, startBallOn: first.ballOn,
      plays: scr.length + core.filter((p) => p.type === 'punt' || p.type === 'field_goal').length,
      yards: scr.reduce((a, p) => a + p.yards, 0),
      seconds: first.quarter <= 4 && first.quarter === lastAny.quarter ? Math.max(0, first.clock - endClock) : 0,
      result, points: dp.reduce((a, p) => a + (p.points?.side === side ? p.points.pts : 0), 0),
    };
  });
}
