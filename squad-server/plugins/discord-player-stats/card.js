import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, registerFont } from 'canvas';

import { weaponLabel } from './stats-query.js';

// The fonts are bundled because the server container may have none installed.
const fontFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
registerFont(path.join(fontFolder, 'DejaVuSans.ttf'), { family: 'CardSans' });
registerFont(path.join(fontFolder, 'DejaVuSans-Bold.ttf'), { family: 'CardSans', weight: 'bold' });

const WIDTH = 1000;
const HEIGHT = 560;
const PADDING = 40;
const COLORS = {
  surface: '#1a1a19',
  tile: '#242422',
  tileBorder: '#383835',
  ink: '#f0efec',
  inkSecondary: '#c3c2b7',
  muted: '#898781',
  accent: '#3987e5',
  highlight: '#199e70'
};

const number = (value) => Math.round(value).toLocaleString('en-US');

function fitText(context, text, maxWidth, size, weight = 'bold') {
  let fontSize = size;
  do {
    context.font = `${weight} ${fontSize}px CardSans`;
    fontSize -= 2;
  } while (context.measureText(text).width > maxWidth && fontSize > 12);
  return text;
}

function drawTile(context, x, y, width, height, { label, value, note }) {
  context.fillStyle = COLORS.tile;
  context.strokeStyle = COLORS.tileBorder;
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(x, y, width, height, 12);
  context.fill();
  context.stroke();

  context.fillStyle = COLORS.inkSecondary;
  context.font = '20px CardSans';
  context.fillText(label, x + 20, y + 36);

  context.fillStyle = COLORS.ink;
  fitText(context, value, width - 40, 38);
  context.fillText(value, x + 20, y + 84);

  if (note) {
    context.fillStyle = COLORS.highlight;
    context.font = 'bold 17px CardSans';
    context.fillText(note, x + 20, y + 112);
  }
}

/**
 * Renders the stats card as a PNG buffer.
 * `ranks` holds "top X%" values for kills, kd and revives (null when no ranking is available).
 */
export function renderCard(stats, { title, since, ranks = {} }) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d');

  context.fillStyle = COLORS.surface;
  context.fillRect(0, 0, WIDTH, HEIGHT);
  context.fillStyle = COLORS.accent;
  context.fillRect(0, 0, 8, HEIGHT);

  context.fillStyle = COLORS.muted;
  context.font = 'bold 18px CardSans';
  context.fillText(title.toUpperCase(), PADDING, 48);

  context.fillStyle = COLORS.ink;
  const name = stats.name || stats.steamID;
  fitText(context, name, WIDTH - 2 * PADDING, 44);
  context.fillText(name, PADDING, 100);

  context.fillStyle = COLORS.inkSecondary;
  context.font = '20px CardSans';
  context.fillText(`${number(stats.matches)} matches on this server since ${since}`, PADDING, 136);

  const rankNote = (rank) => (rank ? `Top ${rank}%` : null);
  const tiles = [
    { label: 'Kills', value: number(stats.kills), note: rankNote(ranks.kills) },
    { label: 'Deaths', value: number(stats.deaths) },
    { label: 'K/D', value: stats.kd.toFixed(2), note: rankNote(ranks.kd) },
    { label: 'Downs', value: number(stats.wounds) },
    { label: 'Revives', value: number(stats.revives), note: rankNote(ranks.revives) },
    { label: 'Revived', value: number(stats.revived) },
    { label: 'Teamkills', value: number(stats.teamkills) },
    {
      label: 'Kills per match',
      value: stats.matches ? (stats.kills / stats.matches).toFixed(1) : '0.0'
    }
  ];
  const columns = 4;
  const gap = 16;
  const tileWidth = (WIDTH - 2 * PADDING - (columns - 1) * gap) / columns;
  const tileHeight = 128;
  tiles.forEach((tile, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    drawTile(
      context,
      PADDING + column * (tileWidth + gap),
      164 + row * (tileHeight + gap),
      tileWidth,
      tileHeight,
      tile
    );
  });

  const weapon = stats.topWeapon
    ? `${weaponLabel(stats.topWeapon.weapon)} · ${number(stats.topWeapon.wounds)} downs`
    : 'none yet';
  context.fillStyle = COLORS.inkSecondary;
  context.font = '20px CardSans';
  context.fillText('Favorite weapon', PADDING, 494);
  context.fillStyle = COLORS.ink;
  fitText(context, weapon, WIDTH - 2 * PADDING - 180, 22);
  context.fillText(weapon, PADDING + 180, 494);

  context.fillStyle = COLORS.muted;
  context.font = '15px CardSans';
  context.fillText(
    'Downs = enemies knocked down. Kills = deaths caused. Teamkills and suicides not counted.',
    PADDING,
    532
  );

  return canvas.toBuffer('image/png');
}
