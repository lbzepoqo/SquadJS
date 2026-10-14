import assert from 'assert';
import { describe, it } from 'node:test';

import { decideSwap } from '../squad-server/plugins/squad-balancer/strategy.js';

const config = { moveCoefficient: 0.5, maxMoveFraction: 0.4, minMoveSize: 9 };

function makeSquad(squadID, size, perPlayerScore) {
  return {
    squadID,
    players: Array.from({ length: size }, (_, index) => ({ eosID: `${squadID}-${index}` })),
    performanceScore: size * perPlayerScore
  };
}

const movedPlayers = (squads) => squads.reduce((total, squad) => total + squad.players.length, 0);
const movedIDs = (squads) => squads.map((squad) => squad.squadID);

describe('SquadBalancer decideSwap', () => {
  it('ranks squads by score per player, not by squad total', () => {
    const plan = decideSwap({
      winner: {
        squads: [makeSquad('W-big', 9, 3), makeSquad('W-strong', 6, 6), makeSquad('W-mid', 3, 3)],
        playerCount: 30
      },
      loser: {
        squads: [
          makeSquad('L-big-weak', 9, 1),
          makeSquad('L-solo', 1, 4),
          makeSquad('L-mid', 8, 3)
        ],
        playerCount: 30
      },
      config
    });

    assert.deepStrictEqual(movedIDs(plan.movesFromWinnerToLoser), ['W-strong', 'W-mid']);
    assert.deepStrictEqual(movedIDs(plan.movesFromLoserToWinner), ['L-big-weak']);
  });

  it('moves several winner squads when the target is larger than one squad', () => {
    const winnerSquads = [9, 9, 9, 9, 9].map((size, index) =>
      makeSquad(`W${index}`, size, 8 - index)
    );
    const loserSquads = [9, 9, 9, 9, 9].map((size, index) => makeSquad(`L${index}`, size, 2));
    const plan = decideSwap({
      winner: { squads: winnerSquads, playerCount: 45 },
      loser: { squads: loserSquads, playerCount: 45 },
      config
    });

    assert.ok(movedPlayers(plan.movesFromWinnerToLoser) >= 18);
    assert.deepStrictEqual(movedIDs(plan.movesFromWinnerToLoser).slice(0, 2), ['W0', 'W1']);
  });

  it('sends back as many loser players as the winner sends', () => {
    const plan = decideSwap({
      winner: {
        squads: [makeSquad('W1', 7, 5), makeSquad('W2', 9, 3), makeSquad('W3', 9, 3)],
        playerCount: 25
      },
      loser: {
        squads: [
          makeSquad('L1', 2, 1),
          makeSquad('L2', 5, 1.5),
          makeSquad('L3', 2, 2),
          makeSquad('L4', 9, 3)
        ],
        playerCount: 18
      },
      config
    });

    assert.strictEqual(movedPlayers(plan.movesFromWinnerToLoser), 7);
    assert.strictEqual(movedPlayers(plan.movesFromLoserToWinner), 7);
  });
});
