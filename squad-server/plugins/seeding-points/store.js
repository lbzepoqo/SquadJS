import Sequelize from 'sequelize';

const { DataTypes } = Sequelize;

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

export async function fetchDayLeaderboard(SeedingDay, day, size) {
  const rows = await SeedingDay.findAll({
    where: { day },
    order: [['points', 'DESC']],
    limit: size
  });
  return rows.map((row) => row.get({ plain: true }));
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
