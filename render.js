// render.js — 描画専用。game.js が組み立てた状態オブジェクト G を毎フレーム描く
// 一人称視点の縦型UI: 向かいにCPU3人、画面下に自分の手だけが見える

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;   // 480
const H = canvas.height;  // 800

// リッチ化エフェクトのON/OFF。気に入らない項目は false にすれば個別に元へ戻せる
const FX = {
  font: true,       // 丸ゴシックWebフォント
  overshoot: true,  // 手のオーバーシュート（行き過ぎて戻る）
  beatBounce: true, // 拍に合わせて全員ピョンと跳ねる
  squash: true,     // 指す側が伸びる・指された側がビクッと縮む
  shake: false,     // 自分が指された瞬間の画面シェイク（強調しすぎて簡単になるためOFF）
  scorePopup: true, // +1/+2のポップアップ
  speedupFx: true,  // テンポアップの演出と効果音
};

const FONT_FAMILY = "'M PLUS Rounded 1c', sans-serif";
function F(size, weight = 700) {
  return `${weight} ${Math.round(size)}px ${FX.font ? FONT_FAMILY : "sans-serif"}`;
}

const IS_TOUCH = "ontouchstart" in window;

// キャッシュバスター(?v=N)からバージョンを拾ってタイトルに表示する。
// 「いま何が動いているか」を実機で確認できるようにするため
const GAME_VERSION = (document.currentScript && (document.currentScript.src.match(/v=(\d+)/) || [])[1]) || "?";

// CPUの座席（1=左 2=正面奥 3=右）。s は奥行きスケール
const CPU_POS = {
  1: { x: 100, y: 415, s: 1.18 },
  2: { x: 240, y: 355, s: 1.02 },
  3: { x: 380, y: 415, s: 1.18 },
};
// 指差しの矢印が向かう先（0=自分: 画面下中央）
const TARGET_POS = {
  0: { x: 240, y: 660 },
  1: { x: CPU_POS[1].x, y: CPU_POS[1].y },
  2: { x: CPU_POS[2].x, y: CPU_POS[2].y },
  3: { x: CPU_POS[3].x, y: CPU_POS[3].y },
};
const HAND_REST = { left: { x: 150, y: 728 }, right: { x: 330, y: 728 } };
const SKIN = "#ffd9b8";
const SKIN_DARK = "#e8b890";

function lerp(a, b, p) { return a + (b - a) * p; }
function easeOut(p) { return 1 - (1 - p) * (1 - p); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// 行き過ぎて戻るイージング
function easeOutBack(x) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}
function easePoint(x) { return FX.overshoot ? easeOutBack(x) : easeOut(x); }

// 拍頭でピョンと跳ねて着地する（OFF時は旧来の常時ゆらゆら）
function beatBob(phase, amp) {
  if (!FX.beatBounce) return -amp * Math.abs(Math.sin(phase * Math.PI));
  const k = Math.min(1, phase * 2.2);
  return -amp * 1.7 * Math.sin(k * Math.PI);
}

// idx が誰かに指された瞬間のビクッ度（0〜1）
function flinchAmount(G, idx) {
  let f = 0;
  for (let j = 0; j < 4; j++) {
    if (j === idx) continue;
    const a = G.chars[j].anim;
    if (a && a.type === "point" && a.targets.includes(idx)) {
      f = Math.max(f, 1 - clamp01(((G.now || 0) - animStart(a) - 0.04) / 0.3));
    }
  }
  return f;
}

// 動的な文字列（名前・人数・ミス理由など）のはみ出し防止の共通ヘルパー。
// maxWidth に収まるまでフォントサイズを自動で下げてから描く。
// 可変テキストを描くときは必ずこれを使うこと（直接 fillText しない）
function fillTextFit(text, x, y, baseSize, weight, maxWidth) {
  let size = baseSize;
  ctx.font = F(size, weight);
  while (size > 10 && ctx.measureText(text).width > maxWidth) {
    size -= 1;
    ctx.font = F(size, weight);
  }
  ctx.fillText(text, x, y);
}

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBubble(x, y, text, scale = 1) {
  ctx.font = F(20 * scale, 800);
  const tw = ctx.measureText(text).width;
  const bw = tw + 26 * scale;
  const bh = 34 * scale;
  const bx = x - bw / 2;
  const by = y - bh;
  ctx.fillStyle = "#fffdf5";
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  rrect(bx, by, bw, bh, 9 * scale);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 6 * scale, by + bh);
  ctx.lineTo(x + 6 * scale, by + bh);
  ctx.lineTo(x, by + bh + 9 * scale);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = "#2a2520";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, by + bh / 2 + 1);
}

// ---------- 背景・舞台 ----------

function drawStage(now) {
  // 部屋
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#2e2540");
  bg.addColorStop(0.5, "#241f33");
  bg.addColorStop(1, "#171420");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 天井からの暖色ライト
  const light = ctx.createRadialGradient(240, 160, 30, 240, 200, 300);
  light.addColorStop(0, "rgba(255, 208, 140, 0.16)");
  light.addColorStop(1, "rgba(255, 208, 140, 0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, W, 520);

  // 床（ふんわり明るい円で奥行きを出す）
  const floor = ctx.createRadialGradient(240, 620, 40, 240, 620, 320);
  floor.addColorStop(0, "rgba(255, 214, 150, 0.06)");
  floor.addColorStop(1, "rgba(255, 214, 150, 0)");
  ctx.fillStyle = floor;
  ctx.fillRect(0, 380, W, 420);
}

function drawVignette(extraRed = 0) {
  const v = ctx.createRadialGradient(240, 400, 220, 240, 400, 560);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, `rgba(${40 * extraRed}, 0, 0, ${0.34 + 0.25 * extraRed})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

// ---------- CPUキャラ ----------

function drawCpu(G, idx, now) {
  const c = G.chars[idx];
  const { x, y, s } = CPU_POS[idx];
  const anim = c.anim;
  const isTurn = G.mode === "play" && G.turnActor === idx;

  // ビートで弾む
  const bob = beatBob(G.beatPhase, 4 * s);
  const headY = y + bob;
  const bodyTop = y + 26 * s + bob;

  // スクワッシュ&ストレッチ: 指す瞬間に伸び、指された瞬間にビクッと縮む
  let pop = 0;
  let flinch = 0;
  if (FX.squash) {
    if (anim && anim.type === "point") pop = 1 - clamp01(((G.now || 0) - animStart(anim)) / 0.3);
    flinch = flinchAmount(G, idx);
  }
  const base = y + 92 * s;
  ctx.save();
  ctx.translate(x, base);
  ctx.scale(1 + 0.12 * flinch - 0.05 * pop, 1 + 0.12 * pop - 0.18 * flinch);
  ctx.translate(-x, -base);

  // 手番の光
  if (isTurn) {
    const glow = ctx.createRadialGradient(x, y + 10, 10, x, y + 10, 95 * s);
    glow.addColorStop(0, "rgba(255, 214, 90, 0.28)");
    glow.addColorStop(1, "rgba(255, 214, 90, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(x - 100, y - 90, 200, 200);
  }

  // 影
  ctx.fillStyle = "rgba(0,0,0,0.30)";
  ctx.beginPath();
  ctx.ellipse(x, y + 92 * s, 52 * s, 12 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // 体（グラデーション）
  const bw = 62 * s;
  const bh = 66 * s;
  const grad = ctx.createLinearGradient(x, bodyTop, x, bodyTop + bh);
  grad.addColorStop(0, c.color);
  grad.addColorStop(1, shade(c.color, -0.35));
  ctx.fillStyle = grad;
  rrect(x - bw / 2, bodyTop, bw, bh, 18 * s);
  ctx.fill();
  // 襟
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.arc(x, bodyTop + 4 * s, 12 * s, 0, Math.PI);
  ctx.fill();

  // 手と吹き出しは drawCpuOverlay で全員の体の上に描く（他キャラの後ろに隠れないように）

  // 頭
  const hr = 27 * s;
  const hg = ctx.createRadialGradient(x - 8 * s, headY - 8 * s, 4, x, headY, hr * 1.3);
  hg.addColorStop(0, "#ffe8cf");
  hg.addColorStop(1, SKIN_DARK);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.arc(x, headY, hr, 0, Math.PI * 2);
  ctx.fill();

  // 左右の席は中央（こちら側）を向いた斜め顔にする: 顔パーツを中央寄りにずらす
  const fdir = idx === 1 ? 1 : idx === 3 ? -1 : 0;
  const fs = fdir * 8 * s;

  // 髪（頭の中心に揃える。顔パーツのみずらして向きを出す）
  ctx.fillStyle = shade(c.color, -0.5);
  ctx.beginPath();
  ctx.arc(x, headY - 2 * s, hr, Math.PI * 1.05, Math.PI * 1.95);
  ctx.quadraticCurveTo(x + hr, headY - hr * 0.6, x + hr * 0.8, headY - hr * 0.3);
  ctx.fill();

  // 顔
  const blink = ((now + idx * 0.93) % 3.4) < 0.13;
  ctx.fillStyle = "#2a2520";
  if (blink) {
    ctx.lineWidth = 2 * s;
    ctx.strokeStyle = "#2a2520";
    ctx.beginPath();
    ctx.moveTo(x - 13 * s + fs, headY - 2 * s);
    ctx.lineTo(x - 6 * s + fs, headY - 2 * s);
    ctx.moveTo(x + 6 * s + fs, headY - 2 * s);
    ctx.lineTo(x + 13 * s + fs, headY - 2 * s);
    ctx.stroke();
  } else {
    // 両目は同じ大きさ（外側を小さくする表現は不揃いに見えるためやめた）
    ctx.beginPath();
    ctx.arc(x - 9 * s + fs, headY - 2 * s, 3.2 * s, 0, Math.PI * 2);
    ctx.arc(x + 9 * s + fs, headY - 2 * s, 3.2 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  // ほっぺ
  ctx.fillStyle = "rgba(255, 120, 120, 0.18)";
  ctx.beginPath();
  ctx.arc(x - 16 * s + fs, headY + 7 * s, 5 * s, 0, Math.PI * 2);
  ctx.arc(x + 16 * s + fs, headY + 7 * s, 5 * s, 0, Math.PI * 2);
  ctx.fill();
  // 口
  ctx.fillStyle = "#2a2520";
  const talking = anim && (anim.type === "point" || anim.type === "haihai");
  ctx.beginPath();
  if (talking) {
    ctx.arc(x + fs, headY + 11 * s, 6 * s, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = "#2a2520";
    ctx.lineWidth = 2.5 * s;
    ctx.arc(x + fs, headY + 8 * s, 7 * s, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();
  }

  // 名前プレート
  ctx.font = F(14 * s, 800);
  const nw = ctx.measureText(c.name).width + 18 * s;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  rrect(x - nw / 2, y + 100 * s, nw, 22 * s, 11 * s);
  ctx.fill();
  ctx.fillStyle = isTurn ? "#ffd95e" : "#e8e4f5";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(c.name, x, y + 111 * s);

  ctx.restore(); // スクワッシュ変形を解除
}

function animStart(anim) {
  return anim.start !== undefined ? anim.start : anim.until - 0.4;
}

// CPUの手と吹き出し（最前面パス）。体の描画とbobの計算を揃えること
function drawCpuOverlay(G, idx, now) {
  const c = G.chars[idx];
  const anim = c.anim;
  if (!anim) return;
  const { x, y, s } = CPU_POS[idx];
  const bob = beatBob(G.beatPhase, 4 * s);
  const headY = y + bob;
  const bodyTop = y + 26 * s + bob;

  ctx.lineCap = "round";
  if (anim.type === "point") {
    const p = easePoint(clamp01(((G.now || 0) - animStart(anim)) / 0.16));
    for (const tIdx of anim.targets) {
      drawCpuPointGlove(G, idx, tIdx, p, bodyTop);
    }
    drawBubble(x, headY - 44 * s, "三郎！", s);
  } else if (anim.type === "haihai") {
    const sway = Math.sin(now * 18) * 9 * s;
    drawFistGlove(x - 42 * s, headY - 2 * s + sway, 12 * s, c.color);
    drawFistGlove(x + 42 * s, headY - 2 * s - sway, 12 * s, c.color);
    drawBubble(x, headY - 44 * s, "ハイハイ", s);
  }
}

// CPUの指差し: プレイヤーと同じ浮き手袋。カメラ（プレイヤー）に向かう時だけ
// 手前に近づくぶん大きくなる。それ以外の形は完全に共通
function drawCpuPointGlove(G, idx, targetIdx, p, bodyTop) {
  const { x, s } = CPU_POS[idx];
  const c = G.chars[idx];
  const tp = TARGET_POS[targetIdx];
  const side = tp.x >= x ? 1 : -1;
  const rest = { x: x + side * 42 * s, y: bodyTop + 6 * s };
  const hx = lerp(rest.x, tp.x, 0.35 * p);
  const hy = lerp(rest.y, tp.y, 0.35 * p);
  const grow = targetIdx === 0 ? 1 + 1.1 * p : 1;
  const r = 13 * s * grow;
  const dx = tp.x - hx;
  const dy = tp.y - hy;
  const len = Math.hypot(dx, dy) || 1;
  drawPointingGlove(hx, hy, dx / len, dy / len, r, c.color);
}

// ---------- 自分の手（一人称） ----------

function drawPlayerHands(G, now) {
  const anim = G.chars[0].anim;
  const bob = beatBob(G.beatPhase, 3);

  if (anim && anim.type === "point") {
    // 指差し: 手袋が対象の方へ少しだけ進んで指す（伸ばしすぎない）
    const p = easePoint(clamp01(((G.now || 0) - animStart(anim)) / 0.14));
    const targets = anim.targets.slice().sort((a, b) => TARGET_POS[a].x - TARGET_POS[b].x);
    const hands = targets.length === 2 ? ["left", "right"] : [targets[0] === 1 ? "left" : "right"];
    for (let i = 0; i < targets.length; i++) {
      drawPointGlove(HAND_REST[hands[i]], TARGET_POS[targets[i]], p);
    }
    drawBubble(240, 660, "三郎！", 1.15);
  } else if (anim && anim.type === "haihai") {
    // ハイハイ: 両拳を持ち上げて振る
    const sway = Math.sin(now * 18) * 12;
    drawFistGlove(192, 688 + sway);
    drawFistGlove(288, 688 - sway);
    drawBubble(240, 640, "ハイハイ", 1.15);
  } else {
    // 待機: 浮いている両手
    drawRestGlove(HAND_REST.left.x, HAND_REST.left.y + bob);
    drawRestGlove(HAND_REST.right.x, HAND_REST.right.y + bob);
  }

  // 自分の番の合図
  if (G.mode === "play" && G.turnActor === 0 && (!anim || anim.type !== "point")) {
    const a = 0.65 + 0.35 * Math.sin(now * 8);
    ctx.fillStyle = `rgba(255, 217, 94, ${a})`;
    ctx.font = F(26, 800);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText("きみの番！", 240, 660);
  }
}

// デフォルメした浮き手袋（胴体・腕なし）。白手袋+赤いカフス
const GLOVE_OUTLINE = "#332b3d";

// 手袋のグラデーションを作る（ローカル座標で使う）
function gloveGrad(r) {
  const g = ctx.createRadialGradient(-r * 0.3, -r * 0.5, r * 0.2, 0, 0, r * 2.3);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#d4cede");
  return g;
}

// 複数パーツを「ひとつのシルエット」として描く: 先に太い輪郭で全パーツを
// なぞり、上から塗りつぶすと内側の線が消えて外周だけが残る
function unionFill(parts, fill, lw) {
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw * 2;
  for (const p of parts) { p(); ctx.stroke(); }
  ctx.fillStyle = fill;
  for (const p of parts) { p(); ctx.fill(); }
}

// 指差し手袋（マスターハンド風デフォルメ: 太い人差し指＋丸い拳）。
// プレイヤーもCPUもこれを使う。+x方向を指すローカル座標で描いて回転させる
function drawPointingGlove(hx, hy, ux, uy, r, cuffColor) {
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(Math.atan2(uy, ux));
  const lw = Math.max(2, r * 0.12);
  const g = gloveGrad(r);

  // カフス（手首側、手の後ろに敷く）
  ctx.fillStyle = cuffColor;
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw;
  rrect(-r * 1.7, -r * 0.62, r * 0.85, r * 1.24, r * 0.25);
  ctx.fill();
  ctx.stroke();

  // 手の本体（丸い拳＋太い人差し指＋親指のこぶ）を1シルエットで
  unionFill([
    () => rrect(-r * 1.1, -r * 0.85, r * 1.8, r * 1.7, r * 0.6),
    () => rrect(r * 0.1, -r * 0.72, r * 2.0, r * 0.62, r * 0.31),
    () => { ctx.beginPath(); ctx.arc(-r * 0.15, -r * 0.92, r * 0.34, 0, Math.PI * 2); },
  ], g, lw);

  // 指の付け根の溝（1本だけ、控えめに）
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw * 0.8;
  ctx.beginPath();
  ctx.moveTo(r * 0.42, -r * 0.1);
  ctx.quadraticCurveTo(r * 0.62, r * 0.25, r * 0.42, r * 0.6);
  ctx.stroke();

  ctx.restore();
}

// 待機の手（ミトン風デフォルメ: 丸い甲＋指4本は溝線だけで表現、親指は内側）
function drawRestGlove(x, y) {
  const r = 24;
  const m = x < 240 ? 1 : -1; // 親指を画面中央側に向けるための左右反転
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(m, 1);
  const lw = Math.max(2, r * 0.12);
  const g = gloveGrad(r);

  // カフス
  ctx.fillStyle = "#e8554d";
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw;
  rrect(-r * 0.95, r * 0.55, r * 1.9, r * 0.85, r * 0.3);
  ctx.fill();
  ctx.stroke();

  // 甲＋指先のふくらみ＋親指を1シルエットで（指は長く出さない）
  unionFill([
    () => rrect(-r * 1.0, -r * 0.7, r * 2.0, r * 1.45, r * 0.5),
    () => rrect(-r * 0.95, -r * 1.15, r * 1.9, r * 1.0, r * 0.48),
    () => { ctx.beginPath(); ctx.arc(r * 0.95, r * 0.25, r * 0.36, 0, Math.PI * 2); },
  ], g, lw);

  // 指の溝線3本（上端から短く）
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw * 0.8;
  for (const fx of [-0.48, 0, 0.48]) {
    ctx.beginPath();
    ctx.moveTo(fx * r, -r * 1.13);
    ctx.lineTo(fx * r, -r * 0.6);
    ctx.stroke();
  }

  ctx.restore();
}

function drawPointGlove(rest, target, p) {
  // 控えめに対象へ寄る（最大30%）。奥に行くぶん少しだけ小さく
  const hx = lerp(rest.x, target.x, 0.3 * p);
  const hy = lerp(rest.y, target.y, 0.32 * p);
  const r = 24 * (1 - 0.2 * p);
  const dx = target.x - hx;
  const dy = target.y - hy;
  const len = Math.hypot(dx, dy) || 1;
  drawPointingGlove(hx, hy, dx / len, dy / len, r, "#e8554d");
}

// 拳（丸いげんこつ＋こぶし山は上端の波で表現）
function drawFistGlove(x, y, r = 24, color = "#e8554d") {
  ctx.save();
  ctx.translate(x, y);
  const lw = Math.max(2, r * 0.12);
  const g = gloveGrad(r);

  // カフス
  ctx.fillStyle = color;
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw;
  rrect(-r * 0.9, r * 0.55, r * 1.8, r * 0.85, r * 0.3);
  ctx.fill();
  ctx.stroke();

  // 拳本体（丸ごと1シルエット。こぶし山は上端の波で表現）
  unionFill([
    () => rrect(-r * 1.0, -r * 0.85, r * 2.0, r * 1.65, r * 0.55),
    () => { ctx.beginPath(); ctx.arc(-r * 0.5, -r * 0.78, r * 0.3, 0, Math.PI * 2); },
    () => { ctx.beginPath(); ctx.arc(0, -r * 0.84, r * 0.3, 0, Math.PI * 2); },
    () => { ctx.beginPath(); ctx.arc(r * 0.5, -r * 0.78, r * 0.3, 0, Math.PI * 2); },
  ], g, lw);

  // こぶしの溝線
  ctx.strokeStyle = GLOVE_OUTLINE;
  ctx.lineWidth = lw * 0.8;
  for (const fx of [-0.27, 0.27]) {
    ctx.beginPath();
    ctx.moveTo(fx * r, -r * 0.95);
    ctx.lineTo(fx * r, -r * 0.55);
    ctx.stroke();
  }

  ctx.restore();
}

// 自分が指されている瞬間の警告表示
function playerIsTargeted(G) {
  for (let i = 1; i <= 3; i++) {
    const a = G.chars[i].anim;
    if (a && a.type === "point" && a.targets.includes(0)) return true;
  }
  return false;
}

// ---------- ビート・HUD ----------

function drawBeatRing(G) {
  const cx = 240;
  const cy = 597;
  const p = G.beatPhase;
  ctx.strokeStyle = `rgba(255, 217, 94, ${1 - p * 0.85})`;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(cx, cy, (20 + 30 * p) * 1.4, 20 + 30 * p, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#ffd95e";
  ctx.shadowColor = "#ffd95e";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 11, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
}

function drawHUD(G) {
  ctx.textBaseline = "alphabetic";
  // 点数はオンライン対戦では出さない（勝ち負けで決まるルール・2026-07-06）
  if (!G.online) {
    // スコア（上部の空白を使って大きく）
    ctx.textAlign = "left";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "#fff";
    ctx.font = F(68, 800);
    const numText = String(G.score);
    const numW = ctx.measureText(numText).width;
    ctx.font = F(26, 800);
    const unitW = ctx.measureText("点").width;
    const x0 = 240 - (numW + 10 + unitW) / 2;
    ctx.font = F(68, 800);
    ctx.fillText(numText, x0, 96);
    ctx.font = F(26, 800);
    ctx.fillStyle = "#c5cce6";
    ctx.fillText("点", x0 + numW + 10, 96);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  // リモート人間の入力待ちが長引いた時の表示（無言のフリーズに見せない）
  if (G.online && G.waitNote && G.mode === "play") {
    ctx.textAlign = "center";
    ctx.fillStyle = "#9aa3c0";
    fillTextFit(G.waitNote, 240, 96, 17, 700, 440);
  }

  ctx.font = F(13);
  ctx.fillStyle = "#9aa3c0";
  ctx.textAlign = "left";
  ctx.fillText(`${G.diff.label}　BPM ${G.bpmNow}`, 14, 24);
  if (!G.online) {
    ctx.textAlign = "right";
    ctx.fillText(`ベスト ${G.bests[G.difficulty]} 点`, W - 14, 24);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(154, 163, 192, 0.85)";
  ctx.font = F(12);
  ctx.fillText(
    IS_TOUCH
      ? "タップ: 指さし　2本同時: 同時さし　手元タップ: ハイハイ"
      : "A:左　W:正面　D:右　2キー同時=同時さし　Space:ハイハイ",
    240, 793
  );
}

// ---------- 画面 ----------

// タイトル画面のUI当たり判定。game.js のタップ判定もこれを参照する（二重定義によるズレ防止）
const TITLE_UI = {
  pills: [
    { x: 32, y: 468, w: 132, h: 54 },
    { x: 174, y: 468, w: 132, h: 54 },
    { x: 316, y: 468, w: 132, h: 54 },
  ],
  start: { x: 110, y: 584, w: 260, h: 62 },
  howto: { x: 150, y: 682, w: 180, h: 40 },
};

function drawTitle(G, now) {
  drawStage(now);
  drawVignette();

  // オンライン（WS）時: 部屋の在室数を常時表示（rosterで即時更新される）
  if (G.online && NET.wsMode) {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 8;
    ctx.fillStyle = "rgba(38, 43, 61, 0.92)";
    rrect(150, 22, 180, 34, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#8ec9ff";
    const label = NET.connected
      ? "部屋にいる人: " + (NET.lastPlayers ? NET.lastPlayers.length : 1) + "/4"
      : "接続中…";
    fillTextFit(label, 240, 40, 15, 800, 170);
    // 在室者の名前一覧（長い名前は切り詰め＋全体は自動縮小ではみ出さない）
    if (NET.connected && NET.lastPlayers && NET.lastPlayers.length) {
      const names = NET.lastPlayers.map(function(p) {
        const n = p.name || "?";
        return n.length > 8 ? n.slice(0, 8) + "…" : n;
      }).join("・");
      ctx.fillStyle = "#9aa3c0";
      fillTextFit(names, 240, 72, 14, 700, 440);
    }
    ctx.textBaseline = "alphabetic";
  }

  // ロゴ: でかい指さし手（ふわふわ浮かせる）。
  // 真上向きは中指を立てているように見えるため、斜め上をさす
  const handX = 220;
  const handY = 172 + Math.sin(now * 1.6) * 6;
  const glow = ctx.createRadialGradient(handX, handY, 10, handX, handY, 150);
  glow.addColorStop(0, "rgba(255, 215, 110, 0.22)");
  glow.addColorStop(1, "rgba(255, 215, 110, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(handX, handY, 150, 0, Math.PI * 2);
  ctx.fill();
  drawPointingGlove(handX, handY, 0.85, -1, 52, "#e8554d");

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd95e";
  ctx.shadowColor = "rgba(255, 180, 60, 0.6)";
  ctx.shadowBlur = 24;
  ctx.font = F(82, 800);
  ctx.fillText("三郎", 240, 348);
  ctx.font = F(32, 800);
  // オンライン版はタイトルを「三郎オンライン」にする
  ctx.fillText(G.online ? "オンライン" : "ゲーム", 240, 394);
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  // キャッチコピー1行だけ。ルールはあそびかた画面へ
  ctx.fillStyle = "#c5cce6";
  ctx.font = F(17);
  ctx.fillText("リズムに乗って、さし合え。", 240, 436);

  // 難易度ピル（横並び）
  const keys = Object.keys(DIFFICULTIES);
  keys.forEach((k, i) => {
    const d = DIFFICULTIES[k];
    const r = TITLE_UI.pills[i];
    const sel = G.difficulty === k;
    ctx.fillStyle = sel ? "#ffd95e" : "rgba(57, 64, 92, 0.85)";
    ctx.shadowColor = sel ? "rgba(255, 200, 80, 0.5)" : "rgba(0,0,0,0.4)";
    ctx.shadowBlur = sel ? 16 : 6;
    rrect(r.x, r.y, r.w, r.h, r.h / 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.fillStyle = sel ? "#222" : "#e8e4f5";
    ctx.font = F(19, 800);
    ctx.fillText(IS_TOUCH ? d.label : `${i + 1} ${d.label}`, r.x + r.w / 2, r.y + 35);
  });

  // 選択中の難易度のベストだけを1行で
  ctx.fillStyle = "#9aa3c0";
  ctx.font = F(15);
  ctx.fillText(
    `BPM ${DIFFICULTIES[G.difficulty].bpm}〜　ベスト ${G.bests[G.difficulty]} 点`,
    240, 556
  );

  // スタートボタン
  const s = TITLE_UI.start;
  const pulse = 1 + 0.02 * Math.sin(now * 3);
  ctx.save();
  ctx.translate(s.x + s.w / 2, s.y + s.h / 2);
  ctx.scale(pulse, pulse);
  ctx.fillStyle = "#ffd95e";
  ctx.shadowColor = "rgba(255, 200, 80, 0.55)";
  ctx.shadowBlur = 22;
  rrect(-s.w / 2, -s.h / 2, s.w, s.h, s.h / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#2a2520";
  ctx.font = F(24, 800);
  ctx.fillText("▶ スタート", 0, 9);
  ctx.restore();
  if (!IS_TOUCH) {
    ctx.fillStyle = "#9aa3c0";
    ctx.font = F(13);
    ctx.fillText("Space でもスタート", 240, s.y + s.h + 24);
  }

  // あそびかた（小さく）
  const h = TITLE_UI.howto;
  ctx.fillStyle = "rgba(57, 64, 92, 0.6)";
  rrect(h.x, h.y, h.w, h.h, h.h / 2);
  ctx.fill();
  ctx.fillStyle = "#c5cce6";
  ctx.font = F(16, 800);
  ctx.fillText(IS_TOUCH ? "？ あそびかた" : "？ あそびかた (H)", h.x + h.w / 2, h.y + 26);

  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(154, 163, 192, 0.5)";
  ctx.font = F(11);
  ctx.fillText("v" + GAME_VERSION, 468, 790);
}

// あそびかた画面。タイトルの「？」から開く
function drawHowto(G, now) {
  drawStage(now);
  drawVignette();

  ctx.fillStyle = "rgba(15, 13, 22, 0.72)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(38, 43, 61, 0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 30;
  rrect(36, 76, 408, 648, 20);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffd95e";
  ctx.font = F(28, 800);
  ctx.fillText("あそびかた", 240, 126);

  const section = (title, y) => {
    ctx.fillStyle = "#ffd95e";
    ctx.font = F(16, 800);
    ctx.textAlign = "left";
    ctx.fillText(title, 64, y);
  };
  const body = (lines, y) => {
    ctx.fillStyle = "#e8e4f5";
    ctx.font = F(14);
    ctx.textAlign = "left";
    lines.forEach((t, i) => ctx.fillText(t, 64, y + i * 22));
  };

  section("ルール", 164);
  body([
    "リズムに乗って「三郎」と指をさし合う。",
    "最初は自分の番。誰かをさしてスタート。",
    "さされたら、次の拍で誰かをさし返す。",
    "2人同時にさされたら「ハイハイ」で応える。",
    "リズムを外したら負け。CPUはミスしない。",
  ], 192);

  section("同時さし", 318);
  body([
    "自分も2人を同時にさせる。",
    "そのあとは、もう一度自分の番。",
    "使えるのは連続2回まで。",
  ], 346);

  section("そうさ", 428);
  body(
    IS_TOUCH
      ? [
          "さす ……… CPUをタップ",
          "同時さし … 2本指で2人を同時タップ",
          "ハイハイ … 画面下の手元をタップ",
        ]
      : [
          "さす ……… A（左）/ W（正面）/ D（右）",
          "同時さし … 2キー同時押し",
          "ハイハイ … Space",
        ],
    456
  );

  section("とくてん", 538);
  body([
    "1拍ごとに 1点。",
    "同時さしは +2点（連続2回目は +1点）。",
    "8拍ごとにどんどん速くなる。",
  ], 566);

  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(255,255,255,${0.55 + 0.45 * Math.sin(now * 3)})`;
  ctx.font = F(16, 800);
  ctx.fillText(IS_TOUCH ? "タップでもどる" : "好きなキーでもどる", 240, 684);
}

function drawGameOver(G) {
  ctx.fillStyle = "rgba(15, 13, 22, 0.78)";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "rgba(38, 43, 61, 0.95)";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 30;
  rrect(50, 225, 380, 350, 20);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  if (G.online) {
    // オンライン対戦: 勝敗のみ（点数なし）
    ctx.fillStyle = "#ffd95e";
    ctx.font = F(32, 800);
    ctx.fillText("試合終了！", 240, 284);
    ctx.fillStyle = "#fff";
    fillTextFit(G.loseReason, 240, 398, 26, 800, 340);
  } else {
    ctx.fillStyle = "#e8554d";
    ctx.font = F(32, 800);
    ctx.fillText("リズムが止まった！", 240, 284);
    ctx.fillStyle = "#c5cce6";
    fillTextFit(G.loseReason, 240, 316, 15, 700, 340);

    ctx.fillStyle = "#fff";
    ctx.font = F(60, 800);
    ctx.fillText(`${G.score} 点`, 240, 398);

    if (G.newBest) {
      ctx.fillStyle = "#ffd95e";
      ctx.font = F(22, 800);
      ctx.fillText("ベスト更新！", 240, 438);
    } else {
      ctx.fillStyle = "#9aa3c0";
      ctx.font = F(15);
      ctx.fillText(`ベスト ${G.bests[G.difficulty]} 点`, 240, 438);
    }
  }

  // もう一度（タップ/Rキー）。当たり判定は game.js の handleTapUI と揃えること
  ctx.fillStyle = "#ffd95e";
  rrect(120, 462, 240, 52, 16);
  ctx.fill();
  ctx.fillStyle = "#2a2520";
  ctx.font = F(21, 800);
  ctx.fillText(IS_TOUCH ? "もう一度" : "もう一度 (R)", 240, 496);

  ctx.fillStyle = "#9aa3c0";
  ctx.font = F(15);
  ctx.fillText(IS_TOUCH ? "タイトルへ" : "タイトルへ (T)", 240, 546);

  // 1人用: みんなのベスト（ランキング上位5件。fetch完了後に表示）
  if (!G.online && G.rankingList && G.rankingList.length > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    rrect(60, 558, 360, 14 + G.rankingList.length * 20 + 10, 8);
    ctx.fill();
    ctx.font = F(12, 800);
    ctx.fillStyle = "#ffd95e";
    ctx.textAlign = "center";
    ctx.fillText("みんなのベスト（" + G.difficulty + "）", 240, 576);
    ctx.font = F(12);
    ctx.fillStyle = "#c5cce6";
    for (let ri = 0; ri < G.rankingList.length; ri++) {
      const entry = G.rankingList[ri];
      const label = (ri + 1) + ". " + (entry.name || "？") + " — " + entry.score + " 点";
      ctx.fillText(label, 240, 594 + ri * 20);
    }
  }
}

// オンライン: ミス後の一時停止画面。ミスした本人だけが再開ボタンを押せる
function drawInterlude(G) {
  ctx.fillStyle = "rgba(15, 13, 22, 0.72)";
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // ミスの種類（大）＋ 誰が・のこりライフ（小）の2行
  ctx.fillStyle = "#ff8a80";
  fillTextFit(G.missReason || "ミス！", 240, 282, 27, 800, 440);
  ctx.fillStyle = "#e8c9c9";
  fillTextFit(G.missInfo || "", 240, 318, 17, 700, 440);

  const isMe = G.resumeSeat === 0;
  if (isMe) {
    // 再開ボタン（当たり判定は画面全体: game.js の handleTapUI と対応）
    // ボタンはラベル幅から余白を取って描く（文字に対して背景が窮屈にならないように）
    const label = IS_TOUCH ? "スタート" : "スタート（Space）";
    ctx.font = F(24, 800);
    const labelW = ctx.measureText(label).width;
    const btnW = labelW + 88; // 左右余白 44px ずつ
    const btnH = 72;
    ctx.fillStyle = "#ffd95e";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 16;
    rrect(240 - btnW / 2, 372, btnW, btnH, 18);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#2a2520";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 240, 372 + btnH / 2);
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#c5cce6";
    ctx.font = F(15);
    ctx.fillText("あなたからリスタート", 240, 486);
  } else {
    ctx.fillStyle = "#c5cce6";
    ctx.font = F(18, 700);
    ctx.fillText((G.starterName || "相手") + " のスタート待ち…", 240, 410);
  }
}

function drawIntro(G) {
  ctx.textAlign = "center";
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 8;
  // オンライン: 直前のミス内容と開始者をイントロ中に表示する
  if (G.online) {
    if (G.missInfo) {
      ctx.fillStyle = "#ff8a80";
      fillTextFit(G.missInfo, 240, 110, 18, 800, 440);
    }
    if (G.starterName) {
      ctx.fillStyle = "#8ec9ff";
      fillTextFit(G.starterName + " からスタート！", 240, 140, 22, 800, 440);
    }
  }
  ctx.fillStyle = "#ffd95e";
  fillTextFit(G.introText || "", 240, 170, 32, 800, 440);
  if (G.introSub) {
    ctx.fillStyle = "#c5cce6";
    fillTextFit(G.introSub, 240, 206, 15, 700, 440);
  }
  // 待ち合わせ中は戻り方も示す（相手が来ないと抜けられない画面にしない）
  // タップ用ボタンの当たり判定は game.js の handleTapUI と座標を揃えること（170,678,140,44）
  if (G.onlineWaiting) {
    ctx.fillStyle = "rgba(38, 43, 61, 0.95)";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 10;
    rrect(170, 678, 140, 44, 12);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#c5cce6";
    ctx.font = F(17, 800);
    ctx.textBaseline = "middle";
    ctx.fillText("タイトルへ", 240, 700);
    ctx.textBaseline = "alphabetic";
    if (!IS_TOUCH) {
      ctx.fillStyle = "#9aa3c0";
      ctx.font = F(13);
      ctx.fillText("（T キーでも戻れる）", 240, 740);
    }
  }
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
}

// 色を明るく/暗くする（amt: -1〜1）
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt < 0) {
    r = Math.round(r * (1 + amt));
    g = Math.round(g * (1 + amt));
    b = Math.round(b * (1 + amt));
  } else {
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
  }
  return `rgb(${r},${g},${b})`;
}

// +1/+2のポップアップ
function drawPopups(G) {
  if (!FX.scorePopup || !G.popups) return;
  ctx.textAlign = "center";
  for (const p of G.popups) {
    const age = (G.now || 0) - p.t0;
    if (age < 0 || age > 0.8) continue;
    const k = clamp01(age / 0.8);
    const sc = age < 0.12 ? easeOutBack(age / 0.12) : 1;
    ctx.globalAlpha = 1 - k * k;
    ctx.font = F(26 * sc + 2, 800);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, p.x, p.y - 46 * k);
  }
  ctx.globalAlpha = 1;
}

// テンポアップの演出
function drawSpeedup(G) {
  if (!FX.speedupFx || !G.speedupAt || !G.now) return;
  const age = G.now - G.speedupAt;
  if (age < 0 || age > 0.9) return;
  const inP = easeOutBack(clamp01(age / 0.15));
  const fade = age > 0.6 ? 1 - (age - 0.6) / 0.3 : 1;
  ctx.save();
  ctx.globalAlpha = Math.max(0, fade);
  ctx.translate(240, 215);
  ctx.scale(inP, inP);
  ctx.textAlign = "center";
  ctx.font = F(34, 800);
  ctx.fillStyle = "#ffd95e";
  ctx.shadowColor = "rgba(255,170,40,0.8)";
  ctx.shadowBlur = 18;
  ctx.fillText("スピードアップ！", 0, 0);
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.font = F(16, 800);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`BPM ${G.bpmNow}`, 0, 30);
  ctx.restore();
}

// ---------- オンライン: 名前ラベル＋ライフ表示 ----------
// 各キャラの頭上に名前（将来はDiscord名が入る）とライフ（残り数ぶんの点）を描く

function drawSeatLabel(G, local, x, y, s) {
  const ch = G.chars[local];
  if (!ch) return;
  const isHuman = ch.kind === "human";
  // 名前プレート
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 6;
  ctx.fillStyle = isHuman ? "rgba(35,48,92,0.92)" : "rgba(40,40,52,0.75)";
  const w = Math.max(56, ch.name.length * 13 + 18);
  rrect(x - w / 2, y - 12, w, 22, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
  ctx.fillStyle = isHuman ? "#ffffff" : "#b8bdd0";
  ctx.font = F(12, 800);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ch.name, x, y - 1);
  // ライフ（人間のみ・残り数ぶんの点。死亡は「代走中」）
  if (G.lives && isHuman) {
    const lives = G.lives[local];
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(x - 14 + k * 14, y + 17, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = k < lives ? "#ff6f7d" : "rgba(255,255,255,0.18)";
      ctx.fill();
    }
  } else if (G.lives && !isHuman && G.lives[local] === 0) {
    ctx.fillStyle = "#8a90a8";
    ctx.font = F(11, 700);
    ctx.fillText("代走中", x, y + 18);
  }
  ctx.textBaseline = "alphabetic";
}

function drawOnlineBadges(G) {
  if (!G.online || !G.chars) return;
  // 向かいの3席: キャラ頭上
  for (let local = 1; local <= 3; local++) {
    const pos = CPU_POS[local];
    drawSeatLabel(G, local, pos.x + 20 * pos.s, pos.y - 74 * pos.s, pos.s);
  }
  // 自分（席0）: 画面下部の手元の上
  drawSeatLabel(G, 0, 240, 590, 1);
}

// メイン描画。game.js から毎フレーム呼ばれる
function render(G, now) {
  if (G.mode === "title") {
    drawTitle(G, now);
    return;
  }
  if (G.mode === "howto") {
    drawHowto(G, now);
    return;
  }

  // 自分が指された瞬間の画面シェイク
  let shx = 0;
  let shy = 0;
  if (FX.shake && G.now && G.mode !== "gameover") {
    let f = 0;
    for (let i = 1; i <= 3; i++) {
      const a = G.chars[i].anim;
      if (a && a.type === "point" && a.targets.includes(0)) {
        f = Math.max(f, 1 - clamp01((G.now - animStart(a)) / 0.35));
      }
    }
    const amp = 7 * f * f;
    shx = Math.sin(now * 67) * amp;
    shy = Math.cos(now * 51) * amp;
  }

  ctx.save();
  ctx.translate(shx, shy);
  drawStage(now);
  drawBeatRing(G);
  for (let i = 1; i <= 3; i++) drawCpu(G, i, now);
  for (let i = 1; i <= 3; i++) drawCpuOverlay(G, i, now);
  drawOnlineBadges(G);
  drawVignette(); // 指された強調はしない（手袋が迫ってくるのを見て反応するゲーム性を保つ）
  drawPlayerHands(G, now);
  ctx.restore();

  drawPopups(G);
  drawSpeedup(G);
  drawHUD(G);

  if (G.mode === "intro") drawIntro(G);
  if (G.mode === "interlude") drawInterlude(G);
  if (G.mode === "gameover") drawGameOver(G);

  // 音声時計が止まっている（iOSのsuspended）ときはタップを促す
  if (G.audioStalled && G.mode !== "gameover") {
    ctx.fillStyle = "rgba(15, 13, 22, 0.6)";
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffd95e";
    ctx.font = F(26, 800);
    ctx.fillText("音が止まっています", 240, 380);
    ctx.fillStyle = "#ffffff";
    ctx.font = F(18);
    ctx.fillText("画面をタップしてね", 240, 420);
  }
}
