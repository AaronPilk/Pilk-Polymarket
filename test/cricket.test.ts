import test from 'node:test';
import assert from 'node:assert/strict';
import { ballsOf, battingWinProb, chaseWinProb, cricketState, eventBetween, matchCricket } from '../src/cricketmath.ts';

const ev = (o: any = {}) => ({
  id: '1557448', date: '2026-11-25T14:30Z',
  status: { summary: o.summary ?? '', type: { state: o.state ?? 'in' } },
  competitions: [{ class: { eventType: o.type ?? 'T20' }, competitors: [
    { team: { displayName: 'Dubai Capitals', abbreviation: 'DBC' }, score: '164/7', winner: 'false',
      linescores: [{ period: 1, runs: 164, wickets: 7, overs: 20, isBatting: true, isCurrent: 0 }, { period: 2, runs: 0, wickets: 0, overs: 12.3, isBatting: false, isCurrent: 1 }] },
    { team: { displayName: 'Desert Vipers', abbreviation: 'DV' }, score: o.score ?? '90/3 (12.3/20 ov, target 165)', winner: 'false',
      linescores: [{ period: 1, runs: 0, wickets: 0, overs: 20, isBatting: false, isCurrent: 0 }, { period: 2, runs: o.runs ?? 90, wickets: o.wkts ?? 3, overs: o.overs ?? 12.3, isBatting: true, isCurrent: 1 }] },
  ] }],
});

test('cricket: ESPN scorepanel event -> state (innings, score, balls, target, format)', () => {
  assert.equal(ballsOf(12.3), 75);
  assert.equal(ballsOf(20), 120);
  const s = cricketState(ev())!;
  assert.equal(s.format, 't20');
  assert.equal(s.innings, 2);
  assert.equal(s.battingTeam, 'Desert Vipers');
  assert.deepEqual([s.runs, s.wickets, s.balls, s.target, s.maxBalls], [90, 3, 75, 165, 120]);
  assert.equal(cricketState(ev({ type: 'Test' }))!.format, 'multi');
});

test('cricket: win chance moves the right way and by sensible amounts', () => {
  const base = { format: 't20' as const, maxBalls: 120, innings: 2, target: 165 };
  // the fitted chase model, checked against the research example: 17 off 11 balls, 5 in hand is about 68%
  assert.ok(Math.abs(chaseWinProb('t20', 17, 11, 5, 120) - 0.68) < 0.05, `${chaseWinProb('t20', 17, 11, 5, 120)}`);
  // a strong favourite chasing gets a lift from its pre-match price early, little of it late
  const even = battingWinProb({ ...base, runs: 0, wickets: 0, balls: 0 })!, fav = battingWinProb({ ...base, runs: 0, wickets: 0, balls: 0 }, 0.75)!;
  assert.ok(fav > even + 0.1, `${even} ${fav}`);
  const p = battingWinProb({ ...base, runs: 135, wickets: 5, balls: 108 })!;   // 30 off 12, 5 down
  const wicket = battingWinProb({ ...base, runs: 135, wickets: 6, balls: 109 })!;
  const six = battingWinProb({ ...base, runs: 141, wickets: 5, balls: 109 })!;
  assert.ok(p > 0.05 && p < 0.3, `p ${p}`);
  assert.ok(wicket < p && six > p);
  assert.equal(battingWinProb({ ...base, runs: 165, wickets: 5, balls: 110 }), 1);
  assert.equal(battingWinProb({ ...base, runs: 150, wickets: 10, balls: 110 }), 0);
  assert.equal(battingWinProb({ format: 'multi', maxBalls: null, innings: 2, runs: 1, wickets: 0, balls: 1, target: null }), null);
});

test('cricket: scoring events between two polls', () => {
  const a = cricketState(ev())!, b = cricketState(ev({ runs: 94, overs: 12.4 }))!, w = cricketState(ev({ runs: 94, wkts: 4, overs: 12.5 }))!;
  assert.deepEqual(eventBetween(a, b), { runs: 4, wickets: 0, balls: 1, inningsChanged: false });
  assert.equal(eventBetween(b, w)!.wickets, 1);
  assert.equal(eventBetween(a, a), null);
});

test('cricket: Polymarket market matches the ESPN match, NZ brand names included', () => {
  const e = ev();
  assert.ok(matchCricket({ slug: 'aec-ilt20-dbc-dv-2026-11-25', long_team: 'Dubai Capitals', short_team: 'Desert Vipers', game_start: '2026-11-25T14:30:00Z' }, [e]));
  assert.equal(matchCricket({ slug: 'aec-ilt20-dbc-dv-2026-11-25', long_team: 'Dubai Capitals', short_team: 'Desert Vipers', game_start: '2026-11-28T14:30:00Z' }, [e]), null);
  const nz = { id: '9', date: '2026-11-27T21:30Z', competitions: [{ competitors: [{ team: { displayName: 'Auckland Women' } }, { team: { displayName: 'Northern Districts Women' } }] }] };
  assert.ok(matchCricket({ slug: 'aec-hjs-ndw-ahu-2026-11-27', long_team: 'Northern Districts Women', short_team: 'Auckland Hearts', game_start: '2026-11-27T21:30:00Z' }, [nz]));
});
