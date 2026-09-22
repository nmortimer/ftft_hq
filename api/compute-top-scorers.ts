import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getJSON, setJSON } from './_lib/store.js';
import { teams } from '../src/data/teams.js';

const START_SEASON = 2018;
const TOP_SCORERS_KEY = 'ftfl:top-scorers';
const RAW_KEY = 'ftfl:top-scorers-raw';
const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Real incident: season 2020's discovery call hit a 403 right after
 * 2018 and 2019 both succeeded back-to-back — almost certainly
 * Fleaflicker rate-limiting a fast run of ~150 requests in quick
 * succession, confirmed by the fact that manually pacing clicks (i.e.
 * waiting between runs) let it through fine. Rather than rely on Nick
 * manually pacing every future run of this too, retry automatically on
 * 403/429 with a short exponential backoff before giving up — 3 tries,
 * 1s/2s/4s waits. Any other error still fails immediately, same as
 * before.
 */
async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url);
    if (res.ok) return res;
    if ((res.status === 403 || res.status === 429) && i < attempts - 1) {
      await sleep(1000 * Math.pow(2, i));
      continue;
    }
    return res; // failed, non-retryable (or out of attempts) — caller checks res.ok and reports res.status itself
  }
  throw new Error('unreachable'); // TS needs a return on every path; the loop always returns above
}

export interface TopScorer {
  position: string;
  playerName: string;
  totalPoints: number;
}

export interface TeamTopScorers {
  teamSlug: string;
  scorers: TopScorer[];
}

export interface TopScorersResult {
  computedAtEpochMilli: number;
  seasonsCovered: { from: number; to: number };
  teams: TeamTopScorers[];
}

// Raw per-player totals, kept separately from the final "best per
// position" summary so seasons can be merged into it incrementally,
// one at a time, across many separate calls to this endpoint.
interface RawState {
  processedSeasons: number[];
  totals: Record<number, Record<string, Record<string, number>>>; // teamId -> position -> playerName -> points
}

/**
 * REBUILT to process ONE SEASON PER CALL, on purpose — this is the real
 * root cause of a very long debugging saga: this endpoint makes 700+
 * external requests across 9 seasons in a single run, and Vercel
 * serverless functions have a hard execution time limit (10s by default,
 * up to 60s configured in vercel.json). Every previous "fix" in this
 * file was a real, legitimate bug, but NONE of them mattered as long as
 * the function was being silently killed by the platform before it ever
 * reached the line that saves to Redis — which is exactly why the
 * result never changed no matter what got fixed inside it, across a
 * brand new deployment, brand new repo, brand new everything.
 *
 * Now: each visit processes exactly ONE unprocessed season (well within
 * any time limit — one season is ~30-80 requests, not 700), merges its
 * player totals into a raw running tally in Redis (`ftfl:top-scorers-raw`),
 * and recomputes the public summary (`ftfl:top-scorers`) from that
 * merged tally. Visiting this URL repeatedly advances one season each
 * time until every season is done — there is no way for this to time
 * out silently again, because no single call ever does more than one
 * season's worth of work.
 *
 * Pass `?season=YYYY` to force a specific season instead of "the next
 * unprocessed one" (e.g. to redo one after a genuine data question).
 * Pass `?reset=1` to wipe all progress and start over from scratch.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const leagueId = process.env.FLEAFLICKER_LEAGUE_ID;
  if (!leagueId) {
    return res.status(400).json({ error: 'FLEAFLICKER_LEAGUE_ID is not set on the server.' });
  }

  const throughSeason = Number(req.query.through) || new Date().getFullYear();
  const allSeasons: number[] = [];
  for (let y = START_SEASON; y <= throughSeason; y++) allSeasons.push(y);

  const knownIds = new Set(teams.map((t) => t.fleaflickerId));

  let raw: RawState = (await getJSON<RawState>(RAW_KEY)) ?? { processedSeasons: [], totals: {} };
  if (req.query.reset === '1') {
    raw = { processedSeasons: [], totals: {} };
  }
  for (const t of teams) {
    if (!raw.totals[t.fleaflickerId]) raw.totals[t.fleaflickerId] = {};
    for (const p of POSITIONS) {
      if (!raw.totals[t.fleaflickerId][p]) raw.totals[t.fleaflickerId][p] = {};
    }
  }

  const requestedSeason = Number(req.query.season) || null;
  const season = requestedSeason ?? allSeasons.find((s) => !raw.processedSeasons.includes(s));

  if (!season) {
    const summary = summarize(raw, throughSeason);
    return res.status(200).json({ ok: true, alreadyComplete: true, processedSeasons: raw.processedSeasons, summary });
  }

  function addPoints(teamId: number, position: string, playerName: string, points: number) {
    if (!knownIds.has(teamId) || !POSITIONS.includes(position) || !points) return;
    const byPos = raw.totals[teamId];
    byPos[position][playerName] = (byPos[position][playerName] ?? 0) + points;
  }

  let sampleBox: any = null;
  let sampleSlot: any = null;

  /**
   * REBUILT against the real, literal boxscore structure — Nick pasted
   * the complete raw response and it revealed TWO compounding wrong
   * assumptions in every previous version of this function:
   *
   * 1. There is no `box.away`/`box.home` holding lineup groups at all.
   *    The real container is `box.lineups[]` (an array of groups —
   *    START, bench, INJURED, TAXI, matching the same group shape
   *    confirmed elsewhere), and EACH SLOT within a group carries its
   *    own `.away` and `.home` sub-objects — one slot per roster
   *    position, both teams shown side-by-side for that slot.
   *
   * 2. There is no `leaguePlayer` wrapper. Every previous version
   *    assumed `slot.leaguePlayer.proPlayer`, copying the shape
   *    confirmed for FetchRoster — but here it's `slot.away.proPlayer`
   *    directly, with `viewingActualPoints` and `owner` siblings right
   *    next to it, no extra nesting.
   *
   * Bonus found in the same paste: each player slot carries its own
   * `owner.id` directly — real team ownership for that exact slot, no
   * need to separately track which side of the boxscore is which team.
   * This replaced the (also real, but now moot) `box.game.away.id`
   * approach from a previous attempt.
   *
   * Verified against real values from the paste before shipping:
   * Saquon Barkley (away side, RB slot) → 19.8 pts, owner.id 1417685.
   */
  /**
   * Confirmed rule (changed on request, was previously "any roster
   * spot — bench/IR/taxi/start all counted"): now ONLY the starting
   * lineup counts. `box.lineups[]`'s `group` field is exactly what
   * distinguishes this — "START" is the active starting group; bench
   * has no `group` key at all (same pattern confirmed elsewhere in
   * this project), and INJURED/TAXI are their own separate groups.
   * Skipping straight to filtering on `group.group === 'START'` is
   * all this needs, since the rest of the extraction (player, points,
   * owner) was already confirmed correct against real data.
   */
  function processBox(box: any) {
    if (!sampleBox) sampleBox = box;
    const lineups: any[] = box?.lineups ?? [];
    for (const group of lineups) {
      if (group?.group !== 'START') continue;
      const slots: any[] = group?.slots ?? [];
      for (const slot of slots) {
        for (const sideKey of ['away', 'home'] as const) {
          const side = slot?.[sideKey];
          const player = side?.proPlayer;
          if (!player?.nameFull) continue;
          if (!sampleSlot) sampleSlot = slot;
          const position: string = player.position ?? '';
          const points: number = side?.viewingActualPoints?.value ?? 0;
          const teamId: number = side?.owner?.id;
          if (teamId) addPoints(teamId, position, player.nameFull, points);
        }
      }
    }
  }

  try {
    const firstWeekRes = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=1`);
    if (!firstWeekRes.ok) throw new Error(`Scoreboard discovery failed for season ${season} (HTTP ${firstWeekRes.status})`);
    const firstWeekData: any = await firstWeekRes.json();
    const eligiblePeriods: number[] = (firstWeekData?.eligibleSchedulePeriods ?? []).map((p: any) => p.ordinal).filter((n: any) => typeof n === 'number');
    const maxWeek = eligiblePeriods.length > 0 ? Math.max(...eligiblePeriods) : 1;

    const weekResults = await Promise.all(
      Array.from({ length: maxWeek }, (_, i) => i + 1).map(async (week) => {
        if (week === 1) return firstWeekData;
        const r = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=${leagueId}&season=${season}&scoring_period=${week}`);
        if (!r.ok) throw new Error(`Scoreboard failed for season ${season} week ${week} (HTTP ${r.status})`);
        return r.json();
      })
    );

    const gameRefs: { gameId: string; week: number }[] = [];
    for (let i = 0; i < weekResults.length; i++) {
      const games: any[] = weekResults[i]?.games ?? [];
      for (const g of games) {
        if (g?.id && knownIds.has(g?.away?.id) && knownIds.has(g?.home?.id)) {
          gameRefs.push({ gameId: String(g.id), week: i + 1 });
        }
      }
    }

    const boxscores = await Promise.all(
      gameRefs.map(async ({ gameId, week }) => {
        const r = await fetchWithRetry(`https://www.fleaflicker.com/api/FetchLeagueBoxscore?sport=NFL&league_id=${leagueId}&fantasy_game_id=${gameId}&scoring_period=${week}`);
        if (!r.ok) throw new Error(`Boxscore failed for game ${gameId} (season ${season}, week ${week}, HTTP ${r.status})`);
        return r.json();
      })
    );

    for (const box of boxscores) {
      processBox(box);
    }

    let pointsFoundThisSeason = 0;
    for (const teamTotals of Object.values(raw.totals)) {
      for (const byName of Object.values(teamTotals)) {
        pointsFoundThisSeason += Object.values(byName).reduce((a, b) => a + b, 0);
      }
    }

    if (!raw.processedSeasons.includes(season)) raw.processedSeasons.push(season);
    raw.processedSeasons.sort((a, b) => a - b);

    if (gameRefs.length > 0 && pointsFoundThisSeason === 0 && raw.processedSeasons.length <= 1) {
      return res.status(502).json({
        error: `Season ${season}: found ${gameRefs.length} games but extracted zero points from any of them — refusing to save, since that almost certainly means a field name is wrong. Raw samples:`,
        sampleBox,
        sampleSlot,
      });
    }

    await setJSON(RAW_KEY, raw);
    const summary = summarize(raw, throughSeason);
    await setJSON(TOP_SCORERS_KEY, summary);

    const remaining = allSeasons.filter((s) => !raw.processedSeasons.includes(s));
    return res.status(200).json({
      ok: true,
      processedThisCall: season,
      gamesThisSeason: gameRefs.length,
      seasonsProcessedSoFar: raw.processedSeasons,
      seasonsRemaining: remaining,
      complete: remaining.length === 0,
      summary,
    });
  } catch (err: any) {
    return res.status(502).json({ error: `Season ${season} failed partway through: ${err?.message}. Nothing new was saved for this season — progress from earlier seasons is untouched.` });
  }
}

function summarize(raw: RawState, throughSeason: number): TopScorersResult {
  const teamTopScorers: TeamTopScorers[] = teams.map((t) => {
    const byPos = raw.totals[t.fleaflickerId] ?? {};
    const scorers: TopScorer[] = POSITIONS.map((position) => {
      const byName = byPos[position] ?? {};
      let best: { playerName: string; totalPoints: number } | null = null;
      for (const [playerName, totalPoints] of Object.entries(byName)) {
        if (!best || totalPoints > best.totalPoints) best = { playerName, totalPoints };
      }
      return { position, playerName: best?.playerName ?? '—', totalPoints: best?.totalPoints ?? 0 };
    });
    return { teamSlug: t.slug, scorers };
  });

  return {
    computedAtEpochMilli: Date.now(),
    seasonsCovered: { from: START_SEASON, to: throughSeason },
    teams: teamTopScorers,
  };
}
