// AI content. The language model is used only for wording and for reading screenshots; it never decides a score or a statistic.
//  * Recaps: the model receives validated structured facts and must restate only those; the output is checked against the
//    facts and discarded in favour of the deterministic template recap if anything unverifiable appears.
//  * Screenshots: the model transcribes what is visible; values are returned to an administrator for confirmation and are never saved here.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { recapFacts } from '../engine/recap';
import type { GameResult, Recap, TeamInput } from '../engine/types';
import { HttpError, type Env } from './auth';

const MODEL = 'claude-opus-5-5';

function client(env: Env): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'AI features are not configured. Add the ANTHROPIC_API_KEY secret to the Worker to enable AI recaps and screenshot reading.', { code: 'AI_NOT_CONFIGURED' });
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45_000 });
}

/** The fact sheet handed to the model. Every number and name the recap may use is in here. */
export function recapFactSheet(r: GameResult, teams: [TeamInput, TeamInput]) {
  const name = (id: string | null) => (id ? teams[0].roster.find((p) => p.id === id)?.name ?? teams[1].roster.find((p) => p.id === id)?.name ?? null : null);
  const f = recapFacts(r);
  const line = (l: GameResult['playerStats'][number]) => ({
    player: name(l.playerId), team: teams[l.side].name,
    passing: l.passAtt ? { completions: l.passCmp, attempts: l.passAtt, yards: l.passYds, touchdowns: l.passTd, interceptions: l.passInt } : undefined,
    rushing: l.rushAtt ? { carries: l.rushAtt, yards: l.rushYds, touchdowns: l.rushTd } : undefined,
    receiving: l.rec ? { receptions: l.rec, yards: l.recYds, touchdowns: l.recTd } : undefined,
    defense: l.tklSolo + l.tklAst + l.sacks + l.defInt + l.fr > 0 ? { tackles: l.tklSolo + l.tklAst, sacks: l.sacks, interceptions: l.defInt, fumbleRecoveries: l.fr } : undefined,
    kicking: l.fga ? { fieldGoalsMade: l.fgm, fieldGoalsAttempted: l.fga, long: l.fgLong } : undefined,
  });
  const notable = r.playerStats.filter((l) => l.passAtt >= 5 || l.rushAtt >= 6 || l.rec >= 3 || l.sacks >= 1 || l.defInt >= 1 || l.tklSolo + l.tklAst >= 6 || l.fga >= 1).map(line);
  return {
    kind: r.mode === 'primetime' ? 'reconstruction of a game played in College Football 27 (final score is real, play details are generated)' : 'fully simulated game',
    winner: teams[f.winner].name, loser: teams[f.loser].name, finalScore: `${r.final[f.winner]}-${r.final[f.loser]}`,
    away: { team: teams[0].name, score: r.final[0], byPeriod: r.quarters[0], recordAfter: teams[0].record ? `${teams[0].record.w + (f.winner === 0 ? 1 : 0)}-${teams[0].record.l + (f.winner === 0 ? 0 : 1)}` : undefined },
    home: { team: teams[1].name, score: r.final[1], byPeriod: r.quarters[1], recordAfter: teams[1].record ? `${teams[1].record.w + (f.winner === 1 ? 1 : 0)}-${teams[1].record.l + (f.winner === 1 ? 0 : 1)}` : undefined },
    overtimePeriods: r.overtimePeriods, largestDeficitOvercomeByWinner: f.maxDeficit,
    teamStats: r.teamStats.map((t) => ({ team: teams[t.side].name, totalYards: t.totalYds, passingYards: t.passYds, rushingYards: t.rushYds, firstDowns: t.firstDowns, turnovers: t.turnovers, sacksMade: t.sacks, thirdDowns: `${t.thirdConv}/${t.thirdAtt}`, penalties: t.penalties, possessionSeconds: t.top })),
    scoringPlays: r.scoring.filter((s) => s.kind !== 'XP' && s.kind !== '2PT').map((s) => ({ period: s.quarter, clock: s.clock, team: teams[s.side].name, play: s.desc, scoreAfter: `${teams[0].abbr} ${s.score[0]}, ${teams[1].abbr} ${s.score[1]}` })),
    keyPlays: r.highlights.map((h) => ({ period: h.quarter, title: h.title, description: h.text })),
    notablePlayers: notable,
  };
}

/** Reject AI text that states a number or quotation the fact sheet does not contain. */
export function recapIsGrounded(text: string, sheet: unknown): { ok: boolean; reason?: string } {
  if (/["“”]/.test(text)) return { ok: false, reason: 'contains quotation marks (quotes are never available)' };
  const allowed = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'number') allowed.add(String(Math.abs(v)));
    else if (typeof v === 'string') for (const m of v.match(/\d+(\.\d+)?/g) ?? []) allowed.add(m);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(sheet);
  for (const n of ['1', '2', '3', '4']) allowed.add(n); // quarters, downs, ordinal references
  const words: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
  for (const m of text.match(/\d+(\.\d+)?/g) ?? []) if (!allowed.has(m)) return { ok: false, reason: `states the number ${m}, which is not in the game data` };
  for (const [w, d] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`, 'i').test(text) && !allowed.has(d) && Number(d) > 4) return { ok: false, reason: `states "${w}", which is not in the game data` };
  if (/\b(injur|concussion|suspended|said|told reporters|according to)\b/i.test(text)) return { ok: false, reason: 'mentions injuries, statements or sources that are not in the game data' };
  return { ok: true };
}

export async function aiRecap(env: Env, r: GameResult, teams: [TeamInput, TeamInput]): Promise<Recap | { error: string }> {
  const anthropic = client(env);
  const sheet = recapFactSheet(r, teams);
  try {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system:
        'You write college football game recaps for the MCAA, a fictional league, in the style of a wire-service sports report. ' +
        'You are given a JSON fact sheet produced by the league statistics engine. Use only facts in the fact sheet: every score, statistic, player name and play you mention must appear in it. ' +
        'Never add quotes, injuries, coaches, weather, crowd details, history, or anything else that is not in the data, because readers treat the recap as an official record. ' +
        'Write 4 to 6 short paragraphs of plain prose with no headings, bullet points or quotation marks: the result first, then the players who decided it with their exact stat lines, the turning point, what happened in the fourth quarter, and the defensive story. ' +
        'Spell out nothing as a number word above four; use digits for all statistics. If the fact sheet says the game is a reconstruction, do not describe plays as things that were witnessed; describe the result and the statistical summary.',
      messages: [{ role: 'user', content: `Fact sheet:\n${JSON.stringify(sheet)}\n\nWrite the recap. First line: a headline of at most 12 words. Then a blank line, then the article.` }],
    });
    if (res.stop_reason === 'refusal') return { error: 'The AI model declined to write this recap.' };
    const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
    const [headline, ...rest] = text.split(/\n\s*\n/);
    const body = rest.join('\n\n').trim();
    if (!headline || !body) return { error: 'The AI model returned an empty recap.' };
    const check = recapIsGrounded(`${headline}\n${body}`, sheet);
    if (!check.ok) return { error: `AI recap rejected by the grounding check: it ${check.reason}.` };
    return { headline: headline.replace(/^#+\s*/, '').trim(), text: body, source: 'ai', reconstruction: r.mode === 'primetime' };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { error: 'The ANTHROPIC_API_KEY secret is invalid.' };
    if (e instanceof Anthropic.RateLimitError) return { error: 'The AI service is rate limited right now.' };
    if (e instanceof Anthropic.APIError) return { error: `The AI service returned an error (${e.status ?? 'network'}).` };
    throw e;
  }
}

const statNum = z.number().nullable();
export const ScreenshotSchema = z.object({
  screenType: z.string().describe('What the screenshot shows, e.g. "final scoreboard", "team statistics", "passing statistics"'),
  awayTeamName: z.string().nullable(),
  homeTeamName: z.string().nullable(),
  awayFinal: statNum,
  homeFinal: statNum,
  awayByPeriod: z.array(z.number()).nullable().describe('Away points by period in order (Q1..Q4, then overtime periods), only if visible'),
  homeByPeriod: z.array(z.number()).nullable(),
  players: z.array(z.object({
    name: z.string(), team: z.string().nullable().describe('Team name or abbreviation exactly as shown, if visible'),
    passCmp: statNum, passAtt: statNum, passYds: statNum, passTd: statNum, passInt: statNum,
    rushAtt: statNum, rushYds: statNum, rushTd: statNum,
    rec: statNum, recYds: statNum, recTd: statNum,
    tackles: statNum, sacks: statNum, defInt: statNum,
    fgm: statNum, fga: statNum, xpm: statNum, xpa: statNum,
  })),
  teamStats: z.array(z.object({ team: z.string(), passYds: statNum, rushYds: statNum, turnovers: statNum })),
  unreadable: z.array(z.string()).describe('Anything that was visible but could not be read with confidence'),
});
export type ScreenshotExtraction = z.infer<typeof ScreenshotSchema>;

export async function extractScreenshots(env: Env, images: { mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string }[], context: { away: string; home: string; rosterNames: string[] }): Promise<ScreenshotExtraction> {
  const anthropic = client(env);
  try {
    const res = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: zodOutputFormat(ScreenshotSchema) },
      system:
        'You transcribe statistics from EA Sports College Football 27 post-game screenshots for a league statistician who will check every value before it is used. ' +
        'Report only values you can actually see. Use null for anything not shown, cut off, or unclear, and list unclear items under "unreadable". Never estimate, infer or fill in a value, because a wrong number that looks confident is worse than a blank.',
      messages: [{
        role: 'user',
        content: [
          ...images.map((im) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType, data: im.data } })),
          { type: 'text' as const, text: `These screenshots are from ${context.away} (away) at ${context.home} (home). Rostered player names, to help you read names correctly (do not add players who are not visible): ${context.rosterNames.join(', ') || 'none supplied'}.` },
        ],
      }],
    });
    if (res.stop_reason === 'refusal') throw new HttpError(502, 'The AI model declined to read these screenshots. Enter the values manually.');
    if (!res.parsed_output) throw new HttpError(502, 'The AI model could not produce a readable transcription. Enter the values manually.');
    return res.parsed_output;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, 'The ANTHROPIC_API_KEY secret is invalid.');
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(503, 'The AI service is rate limited right now. Try again shortly or enter the values manually.');
    if (e instanceof Anthropic.BadRequestError) throw new HttpError(422, `The AI service rejected the screenshots (${e.message}).`);
    if (e instanceof Anthropic.APIError) throw new HttpError(502, `The AI service returned an error (${e.status ?? 'network'}). Enter the values manually.`);
    throw e;
  }
}
