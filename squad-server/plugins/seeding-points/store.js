import Sequelize from 'sequelize';

const { DataTypes, Op } = Sequelize;

export const SEEDING_DAY_TABLE = 'SeedingPoints_PlayerDay';

// One row per player and UTC day. Defined on the given Sequelize instance, so a plugin that reads the table
// (for example the stats command) can define it on its own connector.
export function defineSeedingDay(sequelize) {
  return sequelize.define(
    SEEDING_DAY_TABLE,
    {
      eosID: { type: DataTypes.STRING(32), primaryKey: true },
      day: { type: DataTypes.STRING(10), primaryKey: true },
      steamID: { type: DataTypes.STRING(17), allowNull: true },
      name: { type: DataTypes.STRING, allowNull: true },
      minutes: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 },
      points: { type: DataTypes.FLOAT, allowNull: false, defaultValue: 0 }
    },
    { timestamps: false, indexes: [{ fields: ['steamID'] }, { fields: ['day'] }] }
  );
}

// The saved row of one player and day, or null. No transaction: SQLite rejects a second transaction while
// another plugin on the same connector has one open.
export async function readDay(SeedingDay, eosID, day) {
  const row = await SeedingDay.findOne({ where: { eosID, day } });
  return row ? row.get({ plain: true }) : null;
}

// Writes the day totals as absolute values in one statement, so a retried write cannot count anything twice.
export async function writeDay(SeedingDay, total) {
  await SeedingDay.upsert({
    eosID: total.eosID,
    day: total.day,
    steamID: total.steamID,
    name: total.name,
    minutes: total.minutes,
    points: total.points
  });
}

// Players ranked by their points summed over the UTC days from `firstDay` to `lastDay`, both included. A week is
// a few hundred rows, so the sum is done here: in SQL, a grouped query would need a second query for the names.
// Each player keeps the name of their latest day.
export async function fetchSeedingLeaderboard(SeedingDay, firstDay, lastDay, size) {
  const rows = await SeedingDay.findAll({
    where: { day: { [Op.between]: [firstDay, lastDay] } },
    attributes: ['eosID', 'day', 'name', 'minutes', 'points'],
    order: [['day', 'ASC']],
    raw: true
  });
  const players = new Map();
  for (const row of rows) {
    let player = players.get(row.eosID);
    if (!player) {
      player = { eosID: row.eosID, name: null, minutes: 0, points: 0 };
      players.set(row.eosID, player);
    }
    player.name = row.name ?? player.name;
    player.minutes += row.minutes;
    player.points += row.points;
  }
  return [...players.values()]
    .sort(
      (first, second) =>
        second.points - first.points ||
        second.minutes - first.minutes ||
        first.eosID.localeCompare(second.eosID)
    )
    .slice(0, size);
}

// Minutes and points of one player over the last `days` UTC days (today included) and in total. `player` holds
// an eosID or a steamID.
export async function fetchSeedingSummary(SeedingDay, player, today, days = 30) {
  const where = player.eosID ? { eosID: player.eosID } : { steamID: player.steamID };
  const firstDay = new Date(`${today}T00:00:00Z`);
  firstDay.setUTCDate(firstDay.getUTCDate() - (days - 1));
  const recentFrom = firstDay.toISOString().slice(0, 10);

  const rows = await SeedingDay.findAll({ where, attributes: ['day', 'minutes', 'points'] });
  const summary = { recentMinutes: 0, recentPoints: 0, totalMinutes: 0, totalPoints: 0 };
  for (const row of rows) {
    summary.totalMinutes += row.minutes;
    summary.totalPoints += row.points;
    if (row.day >= recentFrom) {
      summary.recentMinutes += row.minutes;
      summary.recentPoints += row.points;
    }
  }
  return summary;
}
