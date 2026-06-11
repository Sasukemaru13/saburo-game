// game.js — 三郎ゲーム本体（拍エンジン・ターン管理・CPU・入力判定・音声）
// スコアアタック型: CPUはミスしない。自分がリズムを外すまで何拍続くかを競う。

const DIFFICULTIES = {
  easy:   { label: "やさしい",   bpm: 75,  window: 0.22, cpuDouble: 0.15 },
  normal: { label: "ふつう",     bpm: 100, window: 0.16, cpuDouble: 0.25 },
  hard:   { label: "むずかしい", bpm: 130, window: 0.11, cpuDouble: 0.33 },
};
const RAMP_EVERY = 8;    // この拍数ごとにテンポが上がる
const RAMP_FACTOR = 0.96;

// 0=プレイヤー(手前) 1=左 2=正面 3=右
function makeChars() {
  return [
    { name: "あなた", color: "#e8554d", pitch: 1.0,  anim: null },
    { name: "一郎",   color: "#4d7de8", pitch: 0.82, anim: null },
    { name: "二郎",   color: "#4db35e", pitch: 1.22, anim: null },
    { name: "四郎",   color: "#c78b2e", pitch: 1.45, anim: null },
  ];
}

const KEY_TARGET = { a: 1, w: 2, d: 3 };
const INTRO_CLAPS = [0, 1, 2, 2.5, 3]; // タン タン タタ タン
const FIRST_BEAT = 4;

function loadBests() {
  const b = {};
  for (const k of Object.keys(DIFFICULTIES)) {
    b[k] = Number(localStorage.getItem("saburo_best_" + k) || 0);
  }
  return b;
}

const G = {
  mode: "title",
  difficulty: "normal",
  diff: DIFFICULTIES.normal,
  chars: makeChars(),
  beatPhase: 0,
  turnActor: null,
  score: 0,
  bests: loadBests(),
  newBest: false,
  loseReason: "",
  introText: "",
  bpmNow: 100,
  now: 0,        // 音声クロック（render側のアニメ進行に使う）
  popups: [],    // +1/+2ポップアップ
  speedupAt: 0,  // 直近のテンポアップ時刻
};

// ---------- 音声 ----------

let audioCtx = null;
const buffers = {};
let clapBuffer = null;
let tickBuffer = null;

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// AudioContextの生成とiOSアンロックだけを行う（ジェスチャー内で呼ぶこと）。
// タイトルのUI効果音はボイスのデコードを待たずにこれだけで鳴らせる
function ensureAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // iOS Safariはsuspended状態で生成されることがあり、resumeしないと
    // currentTimeが進まず進行が止まる
    if (audioCtx.state === "suspended") audioCtx.resume();
    // ジェスチャー内で無音を即再生してiOSの音声を確実にアンロックする
    const unlock = audioCtx.createBufferSource();
    unlock.buffer = audioCtx.createBuffer(1, 1, audioCtx.sampleRate);
    unlock.connect(audioCtx.destination);
    unlock.start(0);
  } else if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

async function initAudio() {
  ensureAudioCtx();
  if (buffers.saburo) return; // デコード済み（UI効果音が先にctxを作っていても通る）
  for (const name of ["saburo", "haihai"]) {
    buffers[name] = await audioCtx.decodeAudioData(base64ToArrayBuffer(AUDIO_DATA[name]));
  }
  clapBuffer = makeClapBuffer();
  tickBuffer = makeTickBuffer();
}

// ---------- UI効果音（メニュー操作のポップ音） ----------

// 短く上に跳ねる「ピョッ」。freqで音程を変えられる
function playUiPop(freq = 760, vol = 0.16) {
  ensureAudioCtx();
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, t);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.6, t + 0.06);
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

// スタート用の2音「ピポッ↑」
function playUiStart() {
  ensureAudioCtx();
  const t = audioCtx.currentTime;
  [[660, 0], [990, 0.07]].forEach(([freq, dt]) => {
    const osc = audioCtx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.2, t + dt + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.11);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(t + dt);
    osc.stop(t + dt + 0.13);
  });
}

// 難易度ごとに音程を変える（やさしい→むずかしいで高くなる）
function playUiSelect(difficultyKey) {
  const i = Object.keys(DIFFICULTIES).indexOf(difficultyKey);
  playUiPop(620 * Math.pow(1.22, Math.max(0, i)));
}

// 手拍子は毎回生成すると音量がばらつくので、1回だけ作ってピークを揃えて使い回す
function makeClapBuffer() {
  const len = 0.08;
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
  }
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < d.length; i++) d[i] /= peak;
  return buf;
}

// メトロノーム音も波形を事前生成して使い回す（毎回組み立てると鳴り方がばらつく）
function makeTickBuffer() {
  const len = 0.06;
  const sr = audioCtx.sampleRate;
  const buf = audioCtx.createBuffer(1, sr * len, sr);
  const d = buf.getChannelData(0);
  const attack = sr * 0.002; // 2msの立ち上がりでクリックnoise防止
  for (let i = 0; i < d.length; i++) {
    const env = (i < attack ? i / attack : 1) * Math.exp(-i / (sr * 0.012));
    d[i] = Math.sin((2 * Math.PI * 1600 * i) / sr) * env;
  }
  return buf;
}

function playVoice(name, pitch, when = 0, vol = 1.0) {
  const src = audioCtx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = pitch;
  const g = audioCtx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(audioCtx.destination);
  src.start(Math.max(when, audioCtx.currentTime));
}

function playClap(when, vol = 0.5) {
  const src = audioCtx.createBufferSource();
  src.buffer = clapBuffer;
  const bp = audioCtx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = 1100;
  bp.Q.value = 0.8;
  const g = audioCtx.createGain();
  g.gain.value = vol;
  src.connect(bp).connect(g).connect(audioCtx.destination);
  src.start(Math.max(when, audioCtx.currentTime));
}

function playTick(when) {
  const src = audioCtx.createBufferSource();
  src.buffer = tickBuffer;
  const g = audioCtx.createGain();
  g.gain.value = 0.12;
  src.connect(g).connect(audioCtx.destination);
  src.start(Math.max(when, audioCtx.currentTime));
}

function playBuzzer() {
  const osc = audioCtx.createOscillator();
  osc.type = "square";
  osc.frequency.value = 110;
  const g = audioCtx.createGain();
  const t = audioCtx.currentTime;
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.6);
}

// ---------- ラウンド進行 ----------
// イベントは絶対時刻 t を持つ。テンポが上がっても次イベントは「前イベント + 今のinterval」。

let round = null;

let startingRound = false;

async function startRound() {
  if (startingRound) return; // 連打・タップとキーの二重スタート防止
  startingRound = true;
  playUiStart(); // デコード待ちの間も即フィードバック
  try {
    await initAudio();
  } finally {
    startingRound = false;
  }
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});

  G.diff = DIFFICULTIES[G.difficulty];
  G.chars = makeChars();
  G.mode = "intro";
  G.turnActor = null;
  G.score = 0;
  G.newBest = false;
  G.loseReason = "";
  G.bpmNow = G.diff.bpm;
  G.popups = [];
  G.speedupAt = 0;

  round = {
    t0: 0,
    interval: 60 / G.diff.bpm,
    beats: 0,            // テンポアップ判定用の通し拍数
    consec: [0, 0, 0, 0], // 同時さしの連続回数
    phaseT: 0,           // 描画用ビート位相の基準時刻
    pendingKeys: null,   // プレイヤーの指差し入力収集 {keys:[], t}
    event: null,
    awaitingClock: true, // 音声時計が動き出した瞬間にarmRoundで開始時刻を確定する
  };
  if (audioCtx.state === "running") armRound();
}

// 開始時刻を「音声時計が動いている今」基準で確定してイントロをスケジュールする。
// iOSでresumeの完了が遅れても、完了した時点からきれいに始まり、宙ぶらりんにならない
function armRound() {
  const t0 = audioCtx.currentTime + 0.5;
  round.t0 = t0;
  round.phaseT = t0;
  round.event = { type: "point", t: t0 + FIRST_BEAT * round.interval, actor: 0 };
  round.awaitingClock = false;
  for (const b of INTRO_CLAPS) playClap(t0 + b * round.interval, 0.6);
  playTick(round.event.t);
}

function gameOver(reason) {
  G.mode = "gameover";
  G.loseReason = reason;
  G.turnActor = null;
  if (G.score > G.bests[G.difficulty]) {
    G.bests[G.difficulty] = G.score;
    G.newBest = true;
    localStorage.setItem("saburo_best_" + G.difficulty, String(G.score));
  }
  playBuzzer();
}

// 拍が進むごとに呼ぶ。RAMP_EVERY拍ごとにテンポを上げる（上限なし）
function maybeRamp() {
  round.beats++;
  if (round.beats % RAMP_EVERY === 0) {
    round.interval *= RAMP_FACTOR;
    G.bpmNow = Math.round(60 / round.interval);
    G.speedupAt = audioCtx.currentTime;
    if (FX.speedupFx) playSpeedup(audioCtx.currentTime);
  }
}

// テンポアップのジングル（上昇2音）
function playSpeedup(t) {
  for (let i = 0; i < 2; i++) {
    const osc = audioCtx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = i === 0 ? 880 : 1318;
    const g = audioCtx.createGain();
    const s = t + i * 0.09;
    g.gain.setValueAtTime(0.16, s);
    g.gain.exponentialRampToValueAtTime(0.001, s + 0.12);
    osc.connect(g).connect(audioCtx.destination);
    osc.start(s);
    osc.stop(s + 0.14);
  }
}

// +1/+2ポップアップを積む（actor の近くに出す）
function addPopup(actor, gain) {
  if (!FX.scorePopup) return;
  const pos = actor === 0
    ? { x: 240, y: 612 }
    : { x: CPU_POS[actor].x, y: CPU_POS[actor].y - 84 };
  G.popups.push({
    text: `+${gain}`,
    color: gain >= 2 ? "#ffd95e" : "#ffffff",
    x: pos.x,
    y: pos.y,
    t0: audioCtx.currentTime,
  });
  if (G.popups.length > 12) G.popups.shift();
}

// 実効判定窓: 高速域では拍間隔の40%まで自動で締まる（窓が拍より広いと壊れるため）
function winNow() {
  return Math.min(G.diff.window, round.interval * 0.4);
}

function advanceEvent(nextEvent) {
  round.phaseT = nextEvent.t - round.interval;
  round.event = nextEvent;
  playTick(nextEvent.t);
}

// actor が targets を指差す（入力検証は済んでいる前提）
function doPoint(actor, targets) {
  const ev = round.event;
  const now = audioCtx.currentTime;
  playVoice("saburo", G.chars[actor].pitch);
  G.chars[actor].anim = { type: "point", targets, start: now, until: now + round.interval * 0.8 };

  // 同時さしボーナス: 連続の1回目だけ+2点。連続2回目は+1点、間をあければまた+2点
  // （consecは単独さしで0に戻るので「連続の何回目か」がそのまま分かる）
  let gain = 1;
  if (actor === 0 && targets.length === 2 && round.consec[0] === 0) gain = 2;
  G.score += gain;
  addPopup(actor, gain);
  maybeRamp();

  if (targets.length === 2) {
    round.consec[actor]++;
    advanceEvent({
      type: "haihai",
      t: ev.t + round.interval,
      actors: targets.slice(),
      returnTo: actor,
      cpuDone: false,
      playerDone: !targets.includes(0),
    });
  } else {
    round.consec[actor] = 0;
    round.consec[targets[0]] = 0;
    advanceEvent({ type: "point", t: ev.t + round.interval, actor: targets[0] });
  }
  prepareCpu();
}

// 次イベントがCPUの指差しなら実行タイミング(ジッター)を決めておく。CPUはミスしない
function prepareCpu() {
  const ev = round.event;
  if (ev.type === "point" && ev.actor !== 0) {
    ev.cpuActAt = ev.t + (Math.random() - 0.5) * 0.05;
    ev.cpuDone = false;
  }
}

function cpuChooseTargets(actor) {
  const others = [0, 1, 2, 3].filter((i) => i !== actor);
  const canDouble = round.consec[actor] < 2;
  if (canDouble && Math.random() < G.diff.cpuDouble) {
    const i = Math.floor(Math.random() * 3);
    let j = Math.floor(Math.random() * 2);
    if (j >= i) j++;
    return [others[i], others[j]];
  }
  return [others[Math.floor(Math.random() * 3)]];
}

// プレイヤーの指差し入力を確定する（同時押し収集後に呼ばれる）
function resolvePlayerPoint() {
  if (G.mode === "gameover" || !round.pendingKeys) return;
  const { keys, t } = round.pendingKeys;
  round.pendingKeys = null;
  const ev = round.event;
  if (ev.type !== "point" || ev.actor !== 0) return;

  if (Math.abs(t - ev.t) > winNow()) {
    gameOver(t < ev.t ? "早すぎた！" : "遅すぎた！");
    return;
  }
  if (keys.length === 2 && round.consec[0] >= 2) {
    gameOver("同時さしは連続2回まで！");
    return;
  }
  doPoint(0, keys);
}

function resolvePlayerHaihai(t) {
  const ev = round.event;
  if (Math.abs(t - ev.t) > winNow()) {
    gameOver(t < ev.t ? "ハイハイが早すぎた！" : "ハイハイが遅すぎた！");
    return;
  }
  playVoice("haihai", G.chars[0].pitch);
  G.chars[0].anim = { type: "haihai", start: audioCtx.currentTime, until: ev.t + round.interval * 0.9 };
  ev.playerDone = true;
}

// ---------- メインループ ----------

function update() {
  // 進行はゲーム中のみ（ホワイトリスト方式）。除外リスト方式だと新しい画面モードを
  // 追加したときにすり抜けて、残っている古いroundが時間切れ→gameOverを誤発動する
  // （例: howto画面を開いた瞬間に失敗音が鳴ってゲームオーバー画面に飛ぶバグ）
  if (!round || !audioCtx || (G.mode !== "intro" && G.mode !== "play")) return;
  // 音声時計がまだ動いていなければ、動き出した瞬間に開始時刻を確定する
  if (round.awaitingClock) {
    if (audioCtx.state === "running") armRound();
    else return;
  }
  const now = audioCtx.currentTime;
  const ev = round.event;
  const win = winNow();

  // ビート位相（描画用）
  while (now >= round.phaseT + round.interval) round.phaseT += round.interval;
  G.beatPhase = Math.max(0, (now - round.phaseT) / round.interval);

  // イントロ表示と play への移行
  if (G.mode === "intro") {
    const raw = (now - round.t0) / round.interval;
    const claps = INTRO_CLAPS.filter((b) => raw >= b).length;
    G.introText = ["", "タン", "タン　タン", "タン　タン　タ", "タン　タン　タタ", "タン　タン　タタ　タン"][claps];
    if (raw >= 3.5) G.mode = "play";
  }

  // アニメーションの期限切れ
  for (const c of G.chars) {
    if (c.anim && now > c.anim.until) c.anim = null;
  }
  // 消えたポップアップの掃除
  if (G.popups.length) G.popups = G.popups.filter((p) => now - p.t0 < 0.9);

  G.turnActor = ev.type === "point" ? ev.actor : null;

  if (ev.type === "point") {
    if (ev.actor === 0) {
      // プレイヤーの番: 時間切れ判定
      if (now > ev.t + win && !round.pendingKeys) {
        gameOver("反応できなかった…");
      }
    } else if (!ev.cpuDone && now >= ev.cpuActAt) {
      ev.cpuDone = true;
      doPoint(ev.actor, cpuChooseTargets(ev.actor));
    }
  } else if (ev.type === "haihai") {
    // CPU側のハイハイは拍ちょうどに実行
    if (!ev.cpuDone && now >= ev.t) {
      ev.cpuDone = true;
      let delay = 0;
      for (const a of ev.actors) {
        if (a === 0) continue;
        playVoice("haihai", G.chars[a].pitch, ev.t + delay);
        G.chars[a].anim = { type: "haihai", start: ev.t, until: ev.t + round.interval * 0.9 };
        delay += 0.03;
      }
    }
    // プレイヤーが含まれる場合の時間切れ
    if (!ev.playerDone && now > ev.t + win) {
      gameOver("ハイハイできなかった…");
      return;
    }
    // 全員完了したら手番が同時指しした人に戻る
    if (ev.cpuDone && ev.playerDone && now >= ev.t) {
      G.score++;
      addPopup(ev.returnTo, 1);
      maybeRamp();
      advanceEvent({ type: "point", t: ev.t + round.interval, actor: ev.returnTo });
      prepareCpu();
    }
  }
}

let lastClockValue = -1;
let lastClockMoveTs = 0;

function loop(ts) {
  // 監視はゲーム進行中だけ。title/howto/gameoverで有効にすると、
  // 止まった時計を検知した次のタップがhardResetAudio→startRoundになり
  // メニュー操作のつもりが勝手にゲームが始まってしまう
  const inGame = G.mode === "intro" || G.mode === "play";
  if (audioCtx) {
    G.now = audioCtx.currentTime; // アニメ進行は音声クロック基準で統一
    // iOS既知バグの見張り: stateがrunningのまま時計が0.4秒以上進まないなら壊れている
    if (inGame) {
      if (G.now !== lastClockValue) {
        lastClockValue = G.now;
        lastClockMoveTs = ts;
        G.clockStuck = false;
      } else if (audioCtx.state === "running" && ts - lastClockMoveTs > 400) {
        G.clockStuck = true;
      }
    } else {
      G.clockStuck = false;
    }
  }
  // 音声時計が止まっていたら進行も止まる。タップ促しを表示して復帰させる
  G.audioStalled = !!(audioCtx && inGame && (audioCtx.state !== "running" || G.clockStuck));
  update();
  render(G, ts / 1000);
  requestAnimationFrame(loop);
}

// ---------- 入力（キーボード・タッチ共通ロジック） ----------

// タブ切替などでiOSが音声を止めた場合の復帰（進行は音声時計基準なので必須）
// suspendedだけでなくinterrupted等もまとめて起こす
let resettingAudio = false;

function ensureAudioRunning() {
  if (!audioCtx) return;
  // iOS既知バグ: stateはrunningなのに時計が進まない。resumeでは直らないので作り直す
  if (G.clockStuck && !resettingAudio) {
    hardResetAudio();
    return;
  }
  if (audioCtx.state !== "running") audioCtx.resume().catch(() => {});
}

// 壊れたAudioContextを破棄して作り直し、ラウンドを最初からやり直す
// （タップのジェスチャー内から呼ばれる前提）
async function hardResetAudio() {
  resettingAudio = true;
  G.clockStuck = false;
  try { audioCtx.close(); } catch (e) { /* 既にclosedでも構わない */ }
  audioCtx = null;
  try {
    await startRound();
  } finally {
    resettingAudio = false;
  }
}

// 指差し入力（target: 1=左 2=正面 3=右）
function handlePointInput(target, t) {
  if (!round || !round.event) return; // 開始時刻の確定前は無視
  const ev = round.event;
  // イントロ中の早すぎる入力は無視（手拍子につられた分は許す）
  if (G.mode === "intro" && t < ev.t - winNow()) return;

  if (ev.type === "point" && ev.actor === 0) {
    if (round.pendingKeys) {
      if (!round.pendingKeys.keys.includes(target)) round.pendingKeys.keys.push(target);
    } else {
      round.pendingKeys = { keys: [target], t };
      setTimeout(resolvePlayerPoint, 60); // 同時押し猶予
    }
  } else if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
    gameOver("今はハイハイのタイミング！");
  } else if (G.mode === "play") {
    gameOver("自分の番じゃないのに指をさした！");
  }
}

function handleHaihaiInput(t) {
  if (!round || !round.event) return; // 開始時刻の確定前は無視
  const ev = round.event;
  if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
    resolvePlayerHaihai(t);
  } else if (G.mode === "play") {
    gameOver("今はハイハイじゃない！");
  }
}

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  ensureAudioRunning();
  const key = e.key.toLowerCase();

  if (G.mode === "title") {
    if (key === "1") { G.difficulty = "easy"; playUiSelect("easy"); return; }
    if (key === "2") { G.difficulty = "normal"; playUiSelect("normal"); return; }
    if (key === "3") { G.difficulty = "hard"; playUiSelect("hard"); return; }
    if (key === "h") { openHowto(); return; }
    startRound();
    return;
  }

  if (G.mode === "howto") {
    closeHowto();
    return;
  }

  if (G.mode === "gameover") {
    if (key === "r") startRound();
    if (key === "t") { G.mode = "title"; playUiPop(); }
    return;
  }

  if (!audioCtx || !round) return;
  const t = audioCtx.currentTime;

  if (key in KEY_TARGET) {
    handlePointInput(KEY_TARGET[key], t);
    return;
  }
  if (key === " ") {
    e.preventDefault();
    handleHaihaiInput(t);
  }
});

// ---------- タッチ入力（スマホ） ----------

function canvasPos(touch) {
  const rect = canvas.getBoundingClientRect();
  // 要素の箱が480:800比でなくても（object-fit等のレターボックス）、
  // 実際の描画域を逆算して座標を合わせる
  const scale = Math.min(rect.width / W, rect.height / H);
  const ox = rect.left + (rect.width - W * scale) / 2;
  const oy = rect.top + (rect.height - H * scale) / 2;
  return {
    x: (touch.clientX - ox) / scale,
    y: (touch.clientY - oy) / scale,
  };
}

function inRect(p, x, y, w, h) {
  return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
}

// タップ位置 → 対象。CPU3人は当たり判定が重なる場所があるので一番近い人を採る
function hitZone(p) {
  let best = null;
  let bestD = 1;
  for (let i = 1; i <= 3; i++) {
    const dx = (p.x - CPU_POS[i].x) / 85;
    const dy = (p.y - (CPU_POS[i].y + 15)) / 115;
    const d = Math.hypot(dx, dy);
    if (d < 1 && d < bestD) {
      best = i;
      bestD = d;
    }
  }
  if (best !== null) return best;
  if (p.y > 630) return "haihai"; // 画面下の手元エリア
  return null;
}

// 当たり判定の矩形は render.js の TITLE_UI を共有（描画とのズレ防止）
function hitDifficulty(p) {
  const keys = Object.keys(DIFFICULTIES);
  for (let i = 0; i < keys.length; i++) {
    const r = TITLE_UI.pills[i];
    if (inRect(p, r.x, r.y, r.w, r.h)) return keys[i];
  }
  return null;
}

// 開いた直後の連打タップで即閉じてしまい「反応してない」ように見えるのを防ぐ
let howtoOpenedAt = 0;

function openHowto() {
  G.mode = "howto";
  howtoOpenedAt = performance.now();
  playUiPop(540);
}

function closeHowto() {
  if (performance.now() - howtoOpenedAt < 250) return;
  G.mode = "title";
  playUiPop(540);
}

function handleTapUI(pos) {
  if (G.mode === "title") {
    const card = hitDifficulty(pos);
    const s = TITLE_UI.start;
    const h = TITLE_UI.howto;
    if (card) {
      G.difficulty = card;
      playUiSelect(card);
    }
    else if (inRect(pos, s.x, s.y, s.w, s.h)) startRound();
    else if (inRect(pos, h.x, h.y, h.w, h.h)) openHowto();
    return true;
  }
  if (G.mode === "howto") {
    closeHowto();
    return true;
  }
  if (G.mode === "gameover") {
    if (inRect(pos, 120, 462, 240, 52)) startRound();
    else if (inRect(pos, 160, 524, 160, 34)) { G.mode = "title"; playUiPop(); }
    return true;
  }
  return false;
}

canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
  ensureAudioRunning();
  const touches = Array.from(e.changedTouches).map(canvasPos);
  if (touches.length === 0) return;
  if (handleTapUI(touches[0])) return;

  if (!audioCtx || !round) return;
  const t = audioCtx.currentTime;
  for (const pos of touches) {
    const z = hitZone(pos);
    if (z === null) continue; // 何もない場所のタップは指が滑っただけとみなす
    if (z === "haihai") handleHaihaiInput(t);
    else handlePointInput(z, t);
  }
}, { passive: false });

// iOSは音声の許可ジェスチャーとしてtouchendを要求することがある。
// 指が離れた瞬間にも音声を起こすことで、1タップ目（押す→離す）でスタートが完結する
canvas.addEventListener("touchend", (e) => {
  e.preventDefault();
  ensureAudioRunning();
}, { passive: false });

// デスクトップでもタイトル・リザルトはクリック可能にする（プレイ中の誤クリックは無視）
canvas.addEventListener("mousedown", (e) => {
  ensureAudioRunning();
  handleTapUI(canvasPos(e));
});

// タブ復帰時にiOSが音声を止めたままにする場合がある
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) ensureAudioRunning();
});

requestAnimationFrame(loop);
