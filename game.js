// game.js — 三郎ゲーム本体（拍エンジン・ターン管理・CPU・入力判定・音声）

const DIFFICULTIES = {
  easy:   { label: "やさしい",   bpm: 80,  window: 0.22, cpuMiss: 0.10,  cpuDouble: 0.15 },
  normal: { label: "ふつう",     bpm: 110, window: 0.16, cpuMiss: 0.04,  cpuDouble: 0.25 },
  hard:   { label: "むずかしい", bpm: 140, window: 0.11, cpuMiss: 0.012, cpuDouble: 0.33 },
};

// 0=プレイヤー(手前) 1=左 2=正面 3=右
function makeChars() {
  return [
    { name: "あなた", color: "#e8554d", pos: { x: 450, y: 460 }, pitch: 1.0,  anim: null, keyHint: "" },
    { name: "一郎",   color: "#4d7de8", pos: { x: 150, y: 240 }, pitch: 0.82, anim: null, keyHint: "A" },
    { name: "二郎",   color: "#4db35e", pos: { x: 450, y: 120 }, pitch: 1.22, anim: null, keyHint: "W" },
    { name: "四郎",   color: "#c78b2e", pos: { x: 750, y: 240 }, pitch: 1.45, anim: null, keyHint: "D" },
  ];
}

const KEY_TARGET = { a: 1, w: 2, d: 3 };
const INTRO_CLAPS = [0, 1, 2, 2.5, 3]; // タン タン タタ タン
const FIRST_BEAT = 4;

const G = {
  mode: "title",
  difficulty: "normal",
  diff: DIFFICULTIES.normal,
  chars: makeChars(),
  beatPhase: 0,
  turnActor: null,
  survived: 0,
  loser: null,
  loseReason: "",
  introText: "",
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

async function initAudio() {
  if (audioCtx) {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    return;
  }
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  for (const name of ["saburo", "haihai"]) {
    buffers[name] = await audioCtx.decodeAudioData(base64ToArrayBuffer(AUDIO_DATA[name]));
  }
  clapBuffer = makeClapBuffer();
  tickBuffer = makeTickBuffer();

  // Bluetooth等の出力デバイスが無音で省電力ゲートに入ると短い音の頭が欠けて
  // 音量がばらついて聞こえる。極小ノイズを流し続けてデバイスを起こしておく
  const keep = audioCtx.createBufferSource();
  const kb = audioCtx.createBuffer(1, audioCtx.sampleRate, audioCtx.sampleRate);
  const kd = kb.getChannelData(0);
  for (let i = 0; i < kd.length; i++) kd[i] = Math.random() * 2 - 1;
  keep.buffer = kb;
  keep.loop = true;
  const kg = audioCtx.createGain();
  kg.gain.value = 0.0008; // 約-62dB。耳には聞こえないがデバイスは起き続ける
  keep.connect(kg).connect(audioCtx.destination);
  keep.start();
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

let round = null; // 1ラウンド分の進行状態

function beatTime(beat) {
  return round.t0 + beat * round.interval;
}

async function startRound() {
  await initAudio();
  G.diff = DIFFICULTIES[G.difficulty];
  G.chars = makeChars();
  G.mode = "intro";
  G.turnActor = null;
  G.survived = 0;
  G.loser = null;
  G.loseReason = "";

  round = {
    t0: audioCtx.currentTime + 0.5,
    interval: 60 / G.diff.bpm,
    consec: [0, 0, 0, 0], // 同時指しの連続回数
    nextTickBeat: FIRST_BEAT,
    pendingKeys: null, // プレイヤーの指差し入力収集 {keys:[], t}
    event: { type: "point", beat: FIRST_BEAT, actor: 0 },
  };

  // イントロの手拍子を先行スケジュール
  for (const b of INTRO_CLAPS) playClap(beatTime(b), 0.6);
}

function gameOver(loser, reason) {
  G.mode = "gameover";
  G.loser = loser;
  G.loseReason = reason;
  G.turnActor = null;
  G.chars[loser].anim = null;
  playBuzzer();
}

// actor が targets を指差す（入力検証は済んでいる前提）
function doPoint(actor, targets) {
  const ev = round.event;
  const now = audioCtx.currentTime;
  playVoice("saburo", G.chars[actor].pitch);
  G.chars[actor].anim = { type: "point", targets, until: now + round.interval * 0.8 };
  G.survived++;

  if (targets.length === 2) {
    round.consec[actor]++;
    round.event = {
      type: "haihai",
      beat: ev.beat + 1,
      actors: targets.slice(),
      returnTo: actor,
      cpuDone: false,
      playerDone: !targets.includes(0),
    };
  } else {
    round.consec[actor] = 0;
    round.consec[targets[0]] = 0;
    round.event = { type: "point", beat: ev.beat + 1, actor: targets[0] };
  }
  prepareCpu();
}

// 次イベントがCPU絡みなら、実行タイミング(ジッター)とミス判定を先に決めておく
function prepareCpu() {
  const ev = round.event;
  if (ev.type === "point" && ev.actor !== 0) {
    ev.cpuActAt = beatTime(ev.beat) + (Math.random() - 0.5) * 0.05;
    ev.cpuMiss = Math.random() < G.diff.cpuMiss;
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

  const tb = beatTime(ev.beat);
  if (Math.abs(t - tb) > G.diff.window) {
    gameOver(0, t < tb ? "早すぎた！" : "遅すぎた！");
    return;
  }
  if (keys.length === 2 && round.consec[0] >= 2) {
    gameOver(0, "同時指しは連続2回まで！");
    return;
  }
  doPoint(0, keys);
}

function resolvePlayerHaihai(t) {
  const ev = round.event;
  const tb = beatTime(ev.beat);
  if (Math.abs(t - tb) > G.diff.window) {
    gameOver(0, t < tb ? "ハイハイが早すぎた！" : "ハイハイが遅すぎた！");
    return;
  }
  playVoice("haihai", G.chars[0].pitch);
  G.chars[0].anim = { type: "haihai", until: tb + round.interval * 0.9 };
  ev.playerDone = true;
}

// ---------- メインループ ----------

function update() {
  if (!round || !audioCtx || G.mode === "title" || G.mode === "gameover") return;
  const now = audioCtx.currentTime;
  const ev = round.event;
  const win = G.diff.window;

  // ビート位相（描画用）
  const raw = (now - round.t0) / round.interval;
  G.beatPhase = raw < 0 ? 0 : raw - Math.floor(raw);

  // イントロ表示と play への移行
  if (G.mode === "intro") {
    const claps = INTRO_CLAPS.filter((b) => raw >= b).length;
    G.introText = ["", "タン", "タン　タン", "タン　タン　タ", "タン　タン　タタ", "タン　タン　タタ　タン"][claps];
    if (raw >= 3.5) G.mode = "play";
  }

  // メトロノーム（少し先までスケジュール）
  while (beatTime(round.nextTickBeat) < now + 0.15) {
    const tt = beatTime(round.nextTickBeat);
    if (tt > now - 0.05) playTick(tt); // 大きく遅れた分は鳴らさず捨てる
    round.nextTickBeat++;
  }

  // アニメーションの期限切れ
  for (const c of G.chars) {
    if (c.anim && now > c.anim.until) c.anim = null;
  }

  G.turnActor = ev.type === "point" ? ev.actor : null;
  const tb = beatTime(ev.beat);

  if (ev.type === "point") {
    if (ev.actor === 0) {
      // プレイヤーの番: 時間切れ判定
      if (now > tb + win && !round.pendingKeys) {
        gameOver(0, "反応できなかった…");
      }
    } else {
      // CPUの番
      if (!ev.cpuDone && now >= ev.cpuActAt) {
        if (ev.cpuMiss) {
          if (now > tb + win) {
            gameOver(ev.actor, `${G.chars[ev.actor].name}がリズムを外した！`);
          }
        } else {
          ev.cpuDone = true;
          doPoint(ev.actor, cpuChooseTargets(ev.actor));
        }
      }
    }
  } else if (ev.type === "haihai") {
    // CPU側のハイハイは拍ちょうどに実行
    if (!ev.cpuDone && now >= tb) {
      ev.cpuDone = true;
      let delay = 0;
      for (const a of ev.actors) {
        if (a === 0) continue;
        playVoice("haihai", G.chars[a].pitch, tb + delay);
        G.chars[a].anim = { type: "haihai", until: tb + round.interval * 0.9 };
        delay += 0.03;
      }
    }
    // プレイヤーが含まれる場合の時間切れ
    if (!ev.playerDone && now > tb + win) {
      gameOver(0, "ハイハイできなかった…");
      return;
    }
    // 全員完了したら手番が同時指しした人に戻る
    if (ev.cpuDone && ev.playerDone && now >= tb) {
      G.survived++;
      round.event = { type: "point", beat: ev.beat + 1, actor: ev.returnTo };
      prepareCpu();
    }
  }
}

function loop(ts) {
  update();
  render(G, ts / 1000);
  requestAnimationFrame(loop);
}

// ---------- 入力 ----------

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  const key = e.key.toLowerCase();

  if (G.mode === "title") {
    if (key === "1") { G.difficulty = "easy"; return; }
    if (key === "2") { G.difficulty = "normal"; return; }
    if (key === "3") { G.difficulty = "hard"; return; }
    startRound();
    return;
  }

  if (G.mode === "gameover") {
    if (key === "r") startRound();
    if (key === "t") G.mode = "title";
    return;
  }

  if (!audioCtx || !round) return;
  const t = audioCtx.currentTime;
  const ev = round.event;

  if (key in KEY_TARGET) {
    // イントロ中の早すぎる入力は無視（手拍子につられた分は許す）
    if (G.mode === "intro" && t < beatTime(FIRST_BEAT) - G.diff.window) return;

    if (ev.type === "point" && ev.actor === 0) {
      const target = KEY_TARGET[key];
      if (round.pendingKeys) {
        if (!round.pendingKeys.keys.includes(target)) round.pendingKeys.keys.push(target);
      } else {
        round.pendingKeys = { keys: [target], t };
        setTimeout(resolvePlayerPoint, 60); // 同時押し猶予
      }
    } else if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
      gameOver(0, "ハイハイはSpaceキー！");
    } else if (G.mode === "play") {
      gameOver(0, "自分の番じゃないのに指差した！");
    }
    return;
  }

  if (key === " ") {
    e.preventDefault();
    if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
      resolvePlayerHaihai(t);
    } else if (G.mode === "play") {
      gameOver(0, "今はハイハイじゃない！");
    }
  }
});

requestAnimationFrame(loop);
