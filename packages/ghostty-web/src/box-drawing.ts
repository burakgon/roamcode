type StrokeWeight = 0 | 1 | 2;

interface BoxSegments {
  left: StrokeWeight;
  right: StrokeWeight;
  up: StrokeWeight;
  down: StrokeWeight;
  rounded?: true;
}

const segments = (
  left: StrokeWeight,
  right: StrokeWeight,
  up: StrokeWeight,
  down: StrokeWeight,
  rounded?: true,
): BoxSegments => ({ left, right, up, down, rounded });

/**
 * Box-drawing glyphs are connectivity, not ordinary text. Rendering them with `fillText` leaves a fractional
 * font side-bearing at every cell edge on WebKit, so adjacent `─` / `│` glyphs visibly split apart. Keep the
 * terminal's font for normal text, but draw the connected single/heavy box alphabet directly to the exact cell
 * boundaries. The map covers the primitives used by TUIs plus their heavy/mixed corner and end-cap forms.
 */
const BOX_SEGMENTS: Readonly<Record<string, BoxSegments>> = {
  "─": segments(1, 1, 0, 0),
  "━": segments(2, 2, 0, 0),
  "│": segments(0, 0, 1, 1),
  "┃": segments(0, 0, 2, 2),

  "┌": segments(0, 1, 0, 1),
  "┍": segments(0, 2, 0, 1),
  "┎": segments(0, 1, 0, 2),
  "┏": segments(0, 2, 0, 2),
  "┐": segments(1, 0, 0, 1),
  "┑": segments(2, 0, 0, 1),
  "┒": segments(1, 0, 0, 2),
  "┓": segments(2, 0, 0, 2),
  "└": segments(0, 1, 1, 0),
  "┕": segments(0, 2, 1, 0),
  "┖": segments(0, 1, 2, 0),
  "┗": segments(0, 2, 2, 0),
  "┘": segments(1, 0, 1, 0),
  "┙": segments(2, 0, 1, 0),
  "┚": segments(1, 0, 2, 0),
  "┛": segments(2, 0, 2, 0),

  "├": segments(0, 1, 1, 1),
  "┣": segments(0, 2, 2, 2),
  "┤": segments(1, 0, 1, 1),
  "┫": segments(2, 0, 2, 2),
  "┬": segments(1, 1, 0, 1),
  "┳": segments(2, 2, 0, 2),
  "┴": segments(1, 1, 1, 0),
  "┻": segments(2, 2, 2, 0),
  "┼": segments(1, 1, 1, 1),
  "╋": segments(2, 2, 2, 2),

  "╭": segments(0, 1, 0, 1, true),
  "╮": segments(1, 0, 0, 1, true),
  "╯": segments(1, 0, 1, 0, true),
  "╰": segments(0, 1, 1, 0, true),

  "╴": segments(1, 0, 0, 0),
  "╵": segments(0, 0, 1, 0),
  "╶": segments(0, 1, 0, 0),
  "╷": segments(0, 0, 0, 1),
  "╸": segments(2, 0, 0, 0),
  "╹": segments(0, 0, 2, 0),
  "╺": segments(0, 2, 0, 0),
  "╻": segments(0, 0, 0, 2),
  "╼": segments(1, 2, 0, 0),
  "╽": segments(0, 0, 1, 2),
  "╾": segments(2, 1, 0, 0),
  "╿": segments(0, 0, 2, 1),
};

function strokeThickness(weight: StrokeWeight): number {
  return weight === 2 ? 2 : 1;
}

function drawHorizontal(
  context: CanvasRenderingContext2D,
  from: number,
  to: number,
  centerY: number,
  weight: StrokeWeight,
): void {
  if (!weight) return;
  const thickness = strokeThickness(weight);
  context.fillRect(from, centerY - thickness / 2, to - from, thickness);
}

function drawVertical(
  context: CanvasRenderingContext2D,
  centerX: number,
  from: number,
  to: number,
  weight: StrokeWeight,
): void {
  if (!weight) return;
  const thickness = strokeThickness(weight);
  context.fillRect(centerX - thickness / 2, from, thickness, to - from);
}

function drawRoundedCorner(
  context: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const horizontalEnd = glyph === "╭" || glyph === "╰" ? x + width : x;
  const verticalEnd = glyph === "╭" || glyph === "╮" ? y + height : y;
  const horizontalSign = horizontalEnd > centerX ? 1 : -1;
  const verticalSign = verticalEnd > centerY ? 1 : -1;
  const radius = Math.min(width, height) * 0.32;

  context.beginPath();
  context.moveTo(centerX, verticalEnd);
  context.lineTo(centerX, centerY + verticalSign * radius);
  context.quadraticCurveTo(centerX, centerY, centerX + horizontalSign * radius, centerY);
  context.lineTo(horizontalEnd, centerY);
  context.stroke();
}

export function drawBoxDrawingGlyph(
  context: CanvasRenderingContext2D,
  glyph: string,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): boolean {
  const box = BOX_SEGMENTS[glyph];
  if (!box) return false;

  context.fillStyle = color;
  if (box.rounded) {
    context.strokeStyle = color;
    context.lineWidth = 1;
    context.lineCap = "butt";
    context.lineJoin = "round";
    drawRoundedCorner(context, glyph, x, y, width, height);
    return true;
  }

  const centerX = x + width / 2;
  const centerY = y + height / 2;
  drawHorizontal(context, x, centerX, centerY, box.left);
  drawHorizontal(context, centerX, x + width, centerY, box.right);
  drawVertical(context, centerX, y, centerY, box.up);
  drawVertical(context, centerX, centerY, y + height, box.down);
  return true;
}
