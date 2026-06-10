// render.js — 描画専用。game.js が組み立てた状態オブジェクト G を毎フレーム描く

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

function drawRoundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBubble(x, y, text) {
  ctx.font = "bold 22px sans-serif";
  const tw = ctx.measureText(text).width;
  const bw = tw + 28;
  const bh = 38;
  const bx = x - bw / 2;
  const by = y - bh;
  ctx.fillStyle = "#ffffff";
  drawRoundRect(bx, by, bw, bh, 10);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x - 7, by + bh);
  ctx.lineTo(x + 7, by + bh);
  ctx.lineTo(x, by + bh + 10);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#222";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, by + bh / 2 + 1);
}

// キャラ1体を描く。anim: {type, t(0-1経過), targets}
function drawChar(G, idx, now) {
  const c = G.chars[idx];
  const { x, y } = c.pos;
  const anim = c.anim;
  const isTurn = G.mode === "play" && G.turnActor === idx;
  const lost = G.mode === "gameover" && G.loser === idx;

  // 手番マーカー（足元のリング）
  if (isTurn) {
    const pulse = 1 + 0.12 * Math.sin(now * 6);
    ctx.strokeStyle = "#ffd95e";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(x, y + 62, 58 * pulse, 16 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 待機時はビートに合わせて軽く弾む
  let bob = 0;
  if (!lost && (G.mode === "play" || G.mode === "intro")) {
    bob = -4 * Math.abs(Math.sin(G.beatPhase * Math.PI));
  }
  const headY = y - 38 + bob;
  const bodyY = y - 10 + bob;

  const color = lost ? "#777" : c.color;

  // 体
  ctx.fillStyle = color;
  drawRoundRect(x - 26, bodyY, 52, 64, 16);
  ctx.fill();

  // 腕
  ctx.strokeStyle = color;
  ctx.lineWidth = 10;
  ctx.lineCap = "round";
  const shoulderY = bodyY + 14;

  if (anim && anim.type === "point") {
    // 指差し: 対象ごとに腕を伸ばし矢印を出す
    for (const tIdx of anim.targets) {
      const tp = G.chars[tIdx].pos;
      const dx = tp.x - x;
      const dy = tp.y - y;
      const len = Math.hypot(dx, dy);
      const ux = dx / len;
      const uy = dy / len;
      const ax = x + ux * 78;
      const ay = shoulderY + uy * 78;
      ctx.beginPath();
      ctx.moveTo(x, shoulderY);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      // 指先の矢印
      ctx.fillStyle = "#ffd95e";
      ctx.save();
      ctx.translate(ax + ux * 14, ay + uy * 14);
      ctx.rotate(Math.atan2(uy, ux));
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-6, -9);
      ctx.lineTo(-6, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    drawBubble(x, headY - 56, "三郎！");
  } else if (anim && anim.type === "haihai") {
    // ハイハイ: 拳を頭の高さで振る
    const sway = Math.sin(now * 18) * 10;
    ctx.beginPath();
    ctx.moveTo(x - 20, shoulderY);
    ctx.lineTo(x - 40, headY + sway);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 20, shoulderY);
    ctx.lineTo(x + 40, headY - sway);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x - 40, headY + sway, 11, 0, Math.PI * 2);
    ctx.arc(x + 40, headY - sway, 11, 0, Math.PI * 2);
    ctx.fill();
    drawBubble(x, headY - 56, "ハイハイ");
  } else {
    // 下ろした腕
    ctx.beginPath();
    ctx.moveTo(x - 20, shoulderY);
    ctx.lineTo(x - 30, bodyY + 50);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + 20, shoulderY);
    ctx.lineTo(x + 30, bodyY + 50);
    ctx.stroke();
  }

  // 頭
  ctx.fillStyle = lost ? "#999" : "#ffe3c2";
  ctx.beginPath();
  ctx.arc(x, headY, 30, 0, Math.PI * 2);
  ctx.fill();

  // 顔
  ctx.fillStyle = "#222";
  if (lost) {
    ctx.font = "bold 20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("×  ×", x, headY - 4);
    ctx.beginPath();
    ctx.arc(x, headY + 12, 6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.arc(x - 10, headY - 4, 3.5, 0, Math.PI * 2);
    ctx.arc(x + 10, headY - 4, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    const mouthOpen = anim && (anim.type === "point" || anim.type === "haihai");
    if (mouthOpen) {
      ctx.arc(x, headY + 10, 7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.arc(x, headY + 8, 8, 0.2 * Math.PI, 0.8 * Math.PI);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#222";
      ctx.stroke();
    }
  }

  // 名前
  ctx.fillStyle = lost ? "#aaa" : "#fff";
  ctx.font = "bold 16px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(c.name, x, y + 92);

  // プレイヤーのキー表示
  if (c.keyHint && G.mode !== "gameover") {
    ctx.fillStyle = "#ffd95e";
    ctx.font = "bold 14px sans-serif";
    ctx.fillText(c.keyHint, x, y - 96 + bob);
  }
}

function drawBeatRing(G) {
  // 画面中央のビートインジケーター
  const cx = W / 2;
  const cy = H / 2 - 20;
  const p = G.beatPhase; // 0=拍の瞬間
  const r = 22 + 26 * p;
  ctx.strokeStyle = `rgba(255, 217, 94, ${1 - p * 0.85})`;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "#ffd95e";
  ctx.beginPath();
  ctx.arc(cx, cy, 8, 0, Math.PI * 2);
  ctx.fill();
}

function drawHUD(G) {
  ctx.fillStyle = "#9aa3c0";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`難易度: ${G.diff.label}　BPM: ${G.diff.bpm}`, 16, 26);
  ctx.textAlign = "right";
  ctx.fillText(`${Math.max(0, G.survived)} 拍`, W - 16, 26);
  ctx.textAlign = "center";
  ctx.fillText("A: 左　W: 正面　D: 右　(2キー同時=同時指し / Space: ハイハイ)", W / 2, H - 14);
}

function drawTitle(G, now) {
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = "bold 72px sans-serif";
  ctx.fillText("三郎ゲーム", W / 2, 150);

  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#c5cce6";
  const lines = [
    "リズムに乗って「三郎」と指を差し合うゲーム。",
    "指されたら次の拍で A(左) / W(正面) / D(右) で誰かを指せ。",
    "2キー同時押しで2人同時指し（連続2回まで）。",
    "同時指しされたら Space で「ハイハイ」。",
    "リズムを外したら負け。",
  ];
  lines.forEach((t, i) => ctx.fillText(t, W / 2, 220 + i * 28));

  // 難易度選択
  const keys = Object.keys(DIFFICULTIES);
  keys.forEach((k, i) => {
    const d = DIFFICULTIES[k];
    const x = W / 2 + (i - 1) * 200;
    const y = 420;
    const sel = G.difficulty === k;
    ctx.fillStyle = sel ? "#ffd95e" : "#39405c";
    drawRoundRect(x - 80, y - 28, 160, 56, 12);
    ctx.fill();
    ctx.fillStyle = sel ? "#222" : "#c5cce6";
    ctx.font = "bold 20px sans-serif";
    ctx.fillText(`${i + 1}. ${d.label}`, x, y + 7);
  });

  ctx.fillStyle = `rgba(255,255,255,${0.6 + 0.4 * Math.sin(now * 3)})`;
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("1 / 2 / 3 で難易度を選んで、好きなキーでスタート", W / 2, 520);
}

function drawIntro(G) {
  ctx.fillStyle = "#ffd95e";
  ctx.font = "bold 36px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(G.introText || "", W / 2, H / 2 - 90);
}

function drawGameOver(G) {
  ctx.fillStyle = "rgba(20, 22, 32, 0.78)";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";
  const playerLost = G.loser === 0;
  ctx.fillStyle = playerLost ? "#e8554d" : "#6fe87a";
  ctx.font = "bold 56px sans-serif";
  ctx.fillText(playerLost ? "あなたの負け…" : "あなたの勝ち！", W / 2, 220);
  ctx.fillStyle = "#fff";
  ctx.font = "20px sans-serif";
  ctx.fillText(G.loseReason || "", W / 2, 280);
  ctx.fillStyle = "#c5cce6";
  ctx.fillText(`生き残った拍数: ${G.survived}`, W / 2, 330);
  ctx.font = "bold 22px sans-serif";
  ctx.fillStyle = "#ffd95e";
  ctx.fillText("R: もう一度　/　T: タイトルへ", W / 2, 410);
}

// メイン描画。game.js から毎フレーム呼ばれる
function render(G, now) {
  ctx.clearRect(0, 0, W, H);

  if (G.mode === "title") {
    drawTitle(G, now);
    return;
  }

  if (G.mode === "play" || G.mode === "intro" || G.mode === "gameover") {
    drawBeatRing(G);
    for (let i = 0; i < G.chars.length; i++) drawChar(G, i, now);
    drawHUD(G);
  }
  if (G.mode === "intro") drawIntro(G);
  if (G.mode === "gameover") drawGameOver(G);
}
