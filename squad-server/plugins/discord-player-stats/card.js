import path from 'path';
import { fileURLToPath } from 'url';
import { createCanvas, loadImage, registerFont } from 'canvas';

import { RANKED_MEASURES, weaponLabel } from './stats-query.js';

// The fonts are bundled because the server container may have none installed. Characters Oswald
// lacks, such as symbols in clan tags, fall back to the registered DejaVu.
const fontFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts');
registerFont(path.join(fontFolder, 'Oswald-Medium.ttf'), { family: 'CardDisplay', weight: '500' });
registerFont(path.join(fontFolder, 'Oswald-Bold.ttf'), { family: 'CardDisplay', weight: 'bold' });
registerFont(path.join(fontFolder, 'DejaVuSans.ttf'), { family: 'CardSans' });
registerFont(path.join(fontFolder, 'DejaVuSans-Bold.ttf'), { family: 'CardSans', weight: 'bold' });

export const CARD_WIDTH = 1000;
export const CARD_HEIGHT = 560;
const PADDING = 36;
const COLORS = {
  backgroundTop: '#262724',
  backgroundBottom: '#121211',
  photoWash: 'rgba(14, 14, 13, 0.55)',
  photoWashEdge: 'rgba(14, 14, 13, 0.8)',
  panel: 'rgba(0, 0, 0, 0.45)',
  panelBorder: 'rgba(255, 255, 255, 0.09)',
  grid: 'rgba(255, 255, 255, 0.16)',
  ink: '#f0efec',
  inkSecondary: '#c3c2b7',
  muted: '#898781',
  accent: '#d95926',
  accentFill: 'rgba(217, 89, 38, 0.38)'
};

const AXIS_LABELS = {
  kills: ['Kills'],
  wounds: ['Downs'],
  woundsPerMatch: ['Downs', 'per match'],
  kd: ['K/D'],
  revivesPerMatch: ['Revives', 'per match'],
  revives: ['Revives']
};
const RADAR_AXES = RANKED_MEASURES.map((measure) => ({ measure, lines: AXIS_LABELS[measure] }));

const number = (value) => Math.round(value).toLocaleString('en-US');
const font = (weight, size) => `${weight} ${size}px CardDisplay`;

// Sets the largest font from `size` down to `minimumSize` that fits, then shortens the text if it still does not.
function fitText(context, text, maxWidth, size, minimumSize, weight = 'bold') {
  let fontSize = size;
  context.font = font(weight, fontSize);
  while (context.measureText(text).width > maxWidth && fontSize > minimumSize) {
    fontSize -= 2;
    context.font = font(weight, fontSize);
  }
  // Shortened by code points, so an emoji in a clan tag is never cut in half.
  const characters = Array.from(text);
  let fitted = text;
  while (context.measureText(fitted).width > maxWidth && characters.length > 1) {
    characters.splice(-2, 2);
    fitted = `${characters.join('').trimEnd()}…`;
  }
  return fitted;
}

function drawPanel(context, x, y, width, height) {
  context.fillStyle = COLORS.panel;
  context.strokeStyle = COLORS.panelBorder;
  context.lineWidth = 1.5;
  context.beginPath();
  context.roundRect(x, y, width, height, 14);
  context.fill();
  context.stroke();
}

function drawBackground(context, photo) {
  if (photo) {
    // The photo is already cropped to the card size. A dark wash keeps the text readable on bright photos,
    // darkest at the top and bottom where text sits outside the panels.
    context.drawImage(photo, 0, 0, CARD_WIDTH, CARD_HEIGHT);
    const wash = context.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    wash.addColorStop(0, COLORS.photoWashEdge);
    wash.addColorStop(0.32, COLORS.photoWash);
    wash.addColorStop(0.88, COLORS.photoWash);
    wash.addColorStop(1, COLORS.photoWashEdge);
    context.fillStyle = wash;
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  } else {
    const gradient = context.createLinearGradient(0, 0, 0, CARD_HEIGHT);
    gradient.addColorStop(0, COLORS.backgroundTop);
    gradient.addColorStop(1, COLORS.backgroundBottom);
    context.fillStyle = gradient;
    context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  }

  // A faint accent glow behind the radar.
  const glow = context.createRadialGradient(778, 300, 0, 778, 300, 420);
  glow.addColorStop(0, 'rgba(217, 89, 38, 0.16)');
  glow.addColorStop(1, 'rgba(217, 89, 38, 0)');
  context.fillStyle = glow;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = COLORS.accent;
  context.fillRect(0, 0, 8, CARD_HEIGHT);
}

function drawStatGrid(context, x, y, width, height, stats) {
  drawPanel(context, x, y, width, height);
  const columns = [
    [
      ['Kills', number(stats.kills)],
      ['Deaths', number(stats.deaths)],
      ['K/D', stats.kd.toFixed(2)],
      ['Kills per match', stats.matches ? (stats.kills / stats.matches).toFixed(1) : '0.0']
    ],
    [
      ['Downs', number(stats.wounds)],
      ['Revives', number(stats.revives)],
      ['Revived', number(stats.revived)],
      ['Teamkills', number(stats.teamkills)]
    ]
  ];
  const inset = 22;
  const gap = 36;
  const columnWidth = (width - 2 * inset - gap) / 2;
  const rowHeight = (height - 24) / 4;
  columns.forEach((rows, column) => {
    const left = x + inset + column * (columnWidth + gap);
    rows.forEach(([label, value], row) => {
      const baseline = y + 12 + rowHeight * row + rowHeight / 2 + 11;
      context.textAlign = 'left';
      context.fillStyle = COLORS.inkSecondary;
      context.font = font('500', 24);
      context.fillText(label, left, baseline);
      context.textAlign = 'right';
      context.fillStyle = COLORS.ink;
      context.font = font('bold', 32);
      context.fillText(value, left + columnWidth, baseline + 1);
    });
  });
  context.textAlign = 'left';
}

function drawWeapons(context, x, y, width, height, weapons) {
  drawPanel(context, x, y, width, height);
  context.fillStyle = COLORS.muted;
  context.font = font('500', 18);
  context.fillText('TOP WEAPONS BY DOWNS', x + 22, y + 32);

  if (weapons.length === 0) {
    context.fillStyle = COLORS.inkSecondary;
    context.font = font('500', 24);
    context.fillText('None yet', x + 22, y + 74);
    return;
  }
  const slotWidth = (width - 44) / 3;
  weapons.forEach(({ weapon, wounds }, index) => {
    const left = x + 22 + index * slotWidth;
    context.fillStyle = COLORS.ink;
    context.fillText(fitText(context, weaponLabel(weapon), slotWidth - 16, 24, 18), left, y + 70);
    context.fillStyle = COLORS.inkSecondary;
    context.font = font('500', 20);
    context.fillText(`${number(wounds)} ${wounds === 1 ? 'down' : 'downs'}`, left, y + 98);
  });
}

function radarPoint(centerX, centerY, radius, index, share) {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / RADAR_AXES.length;
  return [centerX + Math.cos(angle) * radius * share, centerY + Math.sin(angle) * radius * share];
}

function tracePolygon(context, points) {
  context.beginPath();
  points.forEach(([pointX, pointY], index) =>
    index === 0 ? context.moveTo(pointX, pointY) : context.lineTo(pointX, pointY)
  );
  context.closePath();
}

function drawRadarGrid(context, centerX, centerY, radius) {
  // Rings at 25, 50, 75 and 100. The dashed 50 ring is the median player.
  context.lineWidth = 1.5;
  context.strokeStyle = COLORS.grid;
  for (const share of [0.25, 0.5, 0.75, 1]) {
    context.setLineDash(share === 0.5 ? [5, 5] : []);
    tracePolygon(
      context,
      RADAR_AXES.map((axis, index) => radarPoint(centerX, centerY, radius, index, share))
    );
    context.stroke();
  }
  context.setLineDash([]);
  context.beginPath();
  RADAR_AXES.forEach((axis, index) => {
    context.moveTo(centerX, centerY);
    context.lineTo(...radarPoint(centerX, centerY, radius, index, 1));
  });
  context.stroke();
}

function drawRadarShape(context, centerX, centerY, radius, ranks) {
  // "Top 9%" plots at 91, so the shape and the labels say the same thing.
  const points = RADAR_AXES.map((axis, index) =>
    radarPoint(centerX, centerY, radius, index, (100 - ranks[axis.measure]) / 100)
  );
  tracePolygon(context, points);
  context.fillStyle = COLORS.accentFill;
  context.fill();
  context.strokeStyle = COLORS.accent;
  context.lineWidth = 2.5;
  context.lineJoin = 'round';
  context.stroke();
  for (const [pointX, pointY] of points) {
    context.beginPath();
    context.arc(pointX, pointY, 5, 0, 2 * Math.PI);
    context.fillStyle = COLORS.accent;
    context.fill();
    context.strokeStyle = COLORS.backgroundBottom;
    context.lineWidth = 2;
    context.stroke();
  }
}

// Each label is the measure's name, then "Top X%" when ranked, placed outside its spoke.
function drawRadarLabels(context, centerX, centerY, radius, ranks, ranked) {
  const lineHeight = 21;
  RADAR_AXES.forEach((axis, index) => {
    const [anchorX, anchorY] = radarPoint(centerX, centerY, radius + 12, index, 1);
    const lines = axis.lines.map((text) => ({ text, size: 17, weight: '500' }));
    if (ranked) lines.push({ text: `Top ${ranks[axis.measure]}%`, size: 21, weight: 'bold' });
    const blockHeight = lines.length * lineHeight;
    if (anchorX > centerX + 1) context.textAlign = 'left';
    else if (anchorX < centerX - 1) context.textAlign = 'right';
    else context.textAlign = 'center';
    let top = anchorY - blockHeight / 2;
    if (anchorY < centerY - radius) top = anchorY - blockHeight;
    else if (anchorY > centerY + radius) top = anchorY;
    lines.forEach(({ text, size, weight }, line) => {
      context.fillStyle = weight === 'bold' ? COLORS.ink : COLORS.inkSecondary;
      context.font = font(weight, size);
      context.fillText(text, anchorX, top + (line + 1) * lineHeight - 4);
    });
  });
  context.textAlign = 'left';
}

function drawRadar(context, x, y, width, height, { ranks, rankedPlayers, unrankedNote }) {
  // An empty ranking (no regulars yet) gives null ranks, drawn like no ranking.
  const ranked = RADAR_AXES.every((axis) => ranks[axis.measure] != null);
  drawPanel(context, x, y, width, height);
  context.fillStyle = COLORS.muted;
  context.font = font('500', 18);
  context.fillText('SERVER RANK', x + 22, y + 32);
  context.fillStyle = COLORS.inkSecondary;
  context.font = font('500', 17);
  const subtitle = ranked ? `Among ${number(rankedPlayers)} regulars` : 'Among regular players';
  context.fillText(subtitle, x + 22, y + 56);

  const centerX = x + width / 2;
  const centerY = y + 268;
  const radius = 104;
  drawRadarGrid(context, centerX, centerY, radius);
  drawRadarLabels(context, centerX, centerY, radius, ranks, ranked);
  if (ranked) {
    drawRadarShape(context, centerX, centerY, radius, ranks);
    return;
  }
  context.textAlign = 'center';
  context.fillStyle = COLORS.ink;
  context.font = font('bold', 24);
  context.fillText('Not ranked yet', centerX, centerY - 4);
  if (unrankedNote) {
    context.fillStyle = COLORS.inkSecondary;
    context.font = font('500', 18);
    context.fillText(unrankedNote, centerX, centerY + 22);
  }
  context.textAlign = 'left';
}

/**
 * A photo scaled to cover the whole card, with the overflow cropped evenly from both sides, as a JPEG
 * buffer ready to be drawn by `renderCard`.
 */
export async function cropToCard(imageBuffer) {
  const image = await loadImage(imageBuffer);
  const scale = Math.max(CARD_WIDTH / image.width, CARD_HEIGHT / image.height);
  const sourceWidth = CARD_WIDTH / scale;
  const sourceHeight = CARD_HEIGHT / scale;
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  canvas
    .getContext('2d')
    .drawImage(
      image,
      (image.width - sourceWidth) / 2,
      (image.height - sourceHeight) / 2,
      sourceWidth,
      sourceHeight,
      0,
      0,
      CARD_WIDTH,
      CARD_HEIGHT
    );
  return canvas.toBuffer('image/jpeg', { quality: 0.9 });
}

/**
 * Renders the stats card as a PNG buffer.
 * `ranks` holds the "Top X%" value of each ranked measure, empty when the player has no ranking;
 * `unrankedNote` then says why. `background` is an optional `{ image, credit }` photo already cropped to
 * the card size.
 */
export function renderCard(
  stats,
  { title, since, ranks = {}, rankedPlayers = 0, unrankedNote, background }
) {
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
  const context = canvas.getContext('2d');
  drawBackground(context, background?.image);

  const leftWidth = 540;
  context.fillStyle = COLORS.muted;
  context.font = font('500', 20);
  context.fillText(title.toUpperCase(), PADDING, 50);

  context.fillStyle = COLORS.ink;
  const name = stats.name?.trim() || stats.steamID;
  context.fillText(fitText(context, name, leftWidth, 60, 32), PADDING, 118);

  context.fillStyle = COLORS.inkSecondary;
  context.font = font('500', 22);
  context.fillText(`${number(stats.matches)} matches on this server since ${since}`, PADDING, 154);

  drawStatGrid(context, PADDING, 176, leftWidth, 214, stats);
  drawWeapons(context, PADDING, 404, leftWidth, 120, stats.topWeapons);
  drawRadar(context, PADDING + leftWidth + 16, 36, CARD_WIDTH - 2 * PADDING - leftWidth - 16, 488, {
    ranks,
    rankedPlayers,
    unrankedNote
  });

  context.fillStyle = COLORS.muted;
  context.font = font('500', 16);
  context.fillText(
    'Downs: enemies knocked down. Kills: deaths caused. Teamkills and suicides not counted.',
    PADDING,
    548
  );
  if (background?.credit) {
    const creditLeft = PADDING + leftWidth + 16;
    context.textAlign = 'right';
    context.fillText(
      fitText(
        context,
        `Photo: ${background.credit}`,
        CARD_WIDTH - PADDING - creditLeft,
        16,
        16,
        '500'
      ),
      CARD_WIDTH - PADDING,
      548
    );
    context.textAlign = 'left';
  }

  return canvas.toBuffer('image/png');
}
