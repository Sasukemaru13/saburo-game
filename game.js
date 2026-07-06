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
function makeChars(onlinePlayers) {
  // 1人用（デフォルト）: 従来どおりの固定キャラ
  if (!onlinePlayers) {
    return [
      { name: "あなた", color: "#e8554d", pitch: 1.0,  anim: null },
      { name: "一郎",   color: "#4d7de8", pitch: 0.82, anim: null },
      { name: "二郎",   color: "#4db35e", pitch: 1.22, anim: null },
      { name: "四郎",   color: "#c78b2e", pitch: 1.45, anim: null },
    ];
  }
  // オンライン版: joined で受け取った players 配列（絶対席）をローカル席0基準に並べ直す
  // 固定カラー・ピッチは絶対席番号で決める（全クライアントで統一）
  const COLORS = ["#e8554d", "#4d7de8", "#4db35e", "#c78b2e"];
  const PITCHES = [1.0, 0.82, 1.22, 1.45];
  // CPU名は絶対席基準（サーバーの build_start_players と一致させる）。
  // 「三郎」は使わない（実在しないのがネタの核）。絶対席0が空席の場合は太郎
  const CPU_NAMES = ["太郎", "一郎", "二郎", "四郎"];
  const chars = [];
  for (let local = 0; local < 4; local++) {
    const abs = toAbs(local);
    const player = onlinePlayers.find(function(p) { return p.seat === abs; });
    if (player) {
      chars.push({
        name: player.kind === "human"
          ? (local === 0 ? (player.name ? player.name + "（あなた）" : "あなた") : (player.name || "P" + (abs + 1)))
          : (player.name || CPU_NAMES[abs]),
        color: COLORS[abs],
        pitch: PITCHES[abs],
        anim: null,
        kind: player.kind,
      });
    } else {
      // 席が埋まっていなければCPUで埋める
      chars.push({ name: CPU_NAMES[abs], color: COLORS[abs], pitch: PITCHES[abs], anim: null, kind: "cpu" });
    }
  }
  return chars;
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

  // ---------- オンライン対戦フィールド（?online=1 のときのみ使用） ----------
  online: false,         // オンラインモード中かどうか
  players: null,         // 席情報配列 [{seat, name, kind:"human"|"cpu"},...] （joined受信後に設定）
  humanSeats: [],        // 人間が座っている絶対席番号のリスト（ローカル席に変換済み）
  // 人間手番ゲート: beat番号 → {resolve:[localSeat,...], pendingSeats:Set<localSeat>}
  // pendingSeats が空になったら全員確定
  _inputGate: null,
  // ライフ制（ローカル席index）。ミスで-1、0で死亡=CPU代走。人間が1人になったら試合終了
  lives: [3, 3, 3, 3],
  starterName: "",       // このラウンドの開始者名（イントロで表示）
  missInfo: "",          // 直前のミス内容（リスタートのイントロで表示）
  _lastMissKey: null,    // ミスの重複処理防止（beat:seat）
  resumeSeat: null,      // interlude中、再開ボタンを押す担当（ローカル席。ミスした人）
  onlineWaiting: false,  // 開始前の待ち合わせ中か（待機画面のヒント表示用）
  _readyTimer: null,     // ゲストのready再送タイマー
  rankingList: null,     // 1人用ゲームオーバー時の上位5件（fetch成功時のみ）
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

// UI音はオシレーターのライブ合成だと環境によってアタックが欠け、
// 減衰の尻尾だけの「小さい変な音」がランダムに鳴る（手拍子で同じ問題が出て
// 波形の事前生成で解決した前例あり）。同じ方式で波形をバッファに焼いて再生する。
// エンベロープも周波数チャープもサンプルに焼き込むので、再生時の自動化処理が一切ない
const uiBuffers = {};

function makeChirpBuffer(freq, ratio) {
  const sr = audioCtx.sampleRate;
  const n = Math.floor(sr * 0.13);
  const buf = audioCtx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const attack = sr * 0.006;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = freq * Math.pow(ratio, Math.min(1, i / (sr * 0.06)));
    phase += (2 * Math.PI * f) / sr;
    const tri = (2 / Math.PI) * Math.asin(Math.sin(phase)); // triangle波
    const env = (i < attack ? i / attack : 1) * Math.exp(-Math.max(0, i - attack) / (sr * 0.028));
    d[i] = tri * env;
  }
  return buf;
}

function playBuffer(buf, vol, when) {
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const g = audioCtx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(audioCtx.destination);
  src.start(when);
}

// 短く上に跳ねる「ピョッ」。freqで音程を変えられる
function playUiPop(freq = 760, vol = 0.3) {
  ensureAudioCtx();
  const key = "pop" + Math.round(freq);
  if (!uiBuffers[key]) uiBuffers[key] = makeChirpBuffer(freq, 1.6);
  const t = audioCtx.currentTime + 0.05; // 再生ヘッドとのレース回避の先読み
  dbg(key, t);
  playBuffer(uiBuffers[key], vol, t);
}

// スタート用の2音「ピポッ↑」
function playUiStart() {
  ensureAudioCtx();
  for (const f of [660, 990]) {
    if (!uiBuffers["jingle" + f]) uiBuffers["jingle" + f] = makeChirpBuffer(f, 1);
  }
  const t = audioCtx.currentTime + 0.05;
  dbg("startJingle", t);
  playBuffer(uiBuffers.jingle660, 0.32, t);
  playBuffer(uiBuffers.jingle990, 0.32, t + 0.07);
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

// ---------- 音声デバッグ表示（URLに ?debug を付けると有効） ----------
// 各音のスケジュール時刻と再生ヘッドの差(Δ)を表示する。Δがほぼ0以下なら
// エンベロープの頭が欠けて「小さい変な音」になっている証拠になる
const DEBUG_AUDIO = location.search.includes("debug");
let dbgEl = null;
const dbgLines = [];
function dbg(name, when) {
  if (!DEBUG_AUDIO || !audioCtx) return;
  if (!dbgEl) {
    dbgEl = document.createElement("div");
    dbgEl.style.cssText =
      "position:fixed;left:4px;top:4px;z-index:9;color:#0f0;background:rgba(0,0,0,.75);" +
      "font:11px monospace;padding:6px;pointer-events:none;white-space:pre";
    document.body.appendChild(dbgEl);
    setInterval(() => {
      if (!audioCtx) return;
      dbgEl.textContent =
        `sr=${audioCtx.sampleRate} state=${audioCtx.state}\n` +
        `base=${(audioCtx.baseLatency || 0).toFixed(3)} out=${(audioCtx.outputLatency || 0).toFixed(3)}\n` +
        `ct=${audioCtx.currentTime.toFixed(2)}\n` +
        "--- 直近の音 (Δ=先読み秒) ---\n" +
        dbgLines.slice(-9).join("\n");
    }, 200);
  }
  const d = when - audioCtx.currentTime;
  dbgLines.push(`${name} Δ=${d.toFixed(3)}${d < 0.01 ? " ←頭欠けリスク" : ""}`);
}

function playVoice(name, pitch, when = 0, vol = 1.0) {
  dbg("voice:" + name, Math.max(when, audioCtx.currentTime));
  const src = audioCtx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = pitch;
  const g = audioCtx.createGain();
  g.gain.value = vol;
  src.connect(g).connect(audioCtx.destination);
  src.start(Math.max(when, audioCtx.currentTime));
}

function playClap(when, vol = 0.5) {
  dbg("clap", when);
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
  dbg("tick", when);
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
  const t = audioCtx.currentTime + 0.05; // playUiPopと同じ理由のリード
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
  // オンライン時は NET.init() で確定した players を使う。1人用は null で従来固定キャラ
  G.chars = G.online ? makeChars(G.players) : makeChars();
  G.mode = "intro";
  G.turnActor = null;
  G.score = 0;
  G.newBest = false;
  G.loseReason = "";
  G.bpmNow = G.diff.bpm;
  G.popups = [];
  G.speedupAt = 0;
  G._inputGate = null;
  G.lives = [3, 3, 3, 3];
  G.missInfo = "";
  G.starterName = "";
  G._lastMissKey = null;

  round = {
    t0: 0,
    interval: 60 / G.diff.bpm,
    beats: 0,            // テンポアップ判定用の通し拍数
    consec: [0, 0, 0, 0], // 同時さしの連続回数
    phaseT: 0,           // 描画用ビート位相の基準時刻
    pendingKeys: null,   // プレイヤーの指差し入力収集 {keys:[], t}
    event: null,
    awaitingClock: true, // 音声時計が動き出した瞬間にarmRoundで開始時刻を確定する
    beatCounter: 0,
  };

  if (G.online) {
    // オンライン時は awaitingClock フラグを使わず、NET の start コールバックで armRound を呼ぶ
    round.awaitingClock = false;

    // start コールバックは1本に統合する（onStartは上書き式なので二重登録禁止）。
    // ホスト自身も broadcastStart 経由でここを通る
    NET.onStart(function(msg) {
      // 自分がスタート待ち状態のときだけ受け付ける（ゲームオーバー画面等での誤発動防止）
      if (G.mode !== "intro") return;
      // 難易度はホストの指定に合わせる（拍間隔・判定窓・CPU同時さし確率＝乱数消費が
      // 全タブで一致しないと決定論が壊れる）
      if (msg.difficulty && DIFFICULTIES[msg.difficulty]) {
        G.difficulty = msg.difficulty;
        G.diff = DIFFICULTIES[msg.difficulty];
        round.interval = 60 / G.diff.bpm;
        G.bpmNow = G.diff.bpm;
      }
      if (msg.players) {
        G.players = msg.players;
        G.humanSeats = msg.players
          .filter(function(p) { return p.kind === "human"; })
          .map(function(p) { return toLocal(p.seat); });
        G.chars = makeChars(G.players);
      }
      if (audioCtx.state !== "running") audioCtx.resume().catch(function() {});
      // msg.t0 はサーバー時刻（ms）。audioCtx.currentTime はタブごとに独立した時計なので
      // サーバー時刻基準でローカル音声時計に変換する。
      // localモードでは NET.serverNowMs() ≒ performance.now() ≒ Date.now() - epoch差 なので
      // 差分が同符号になり実質的に従来の Date.now() と同じ精度で動く。
      const _nowMs = NET.wsMode ? NET.serverNowMs() : Date.now();
      const t0Local = audioCtx.currentTime + (msg.t0 - _nowMs) / 1000;
      if (t0Local < audioCtx.currentTime + 0.2) {
        console.warn("saburo: start時刻が過去/直近すぎる (受信遅れ?)", msg.t0, t0Local);
      }
      armRound(t0Local);
    });

    NET.onInput(handleRemoteInput);
    NET.onResume(function(msg) { handleResume(msg.t0, msg.actor); });
    NET.onLeave(function(seat) {
      // 進行中・待機中なら試合を打ち切る（すでに終了画面なら何もしない）
      if (G.mode === "intro" || G.mode === "play" || G.mode === "interlude") {
        if (seat === -1) {
          gameOver("サーバーとの接続が切れました");
        } else if (seat === -2) {
          gameOver("部屋が満員です");
        } else {
          // 自分の試合がまだ始まっていない（開始前の待機中）なら、他人の退出は
          // 打ち切り対象ではない。人数表示（roster）の更新に任せて無視する
          if (!round || !round.event) return;
          const local = toLocal(seat);
          const name = seatDisplayName(local);
          gameOver(name + " が退出しました");
        }
      }
    });

    if (NET.wsMode) {
      // WSモード: 全員が ready を送ってサーバーの start を待つ（席0もそれ以外も同じ）。
      // タイトルへ戻って切断していた場合はここで張り直す（再入室）
      NET.ensureConnected();
      // 接続確立前にスタートを押すと最初の送信は握り潰される（readyState未OPEN）ため、
      // 待機中は1秒ごとに再送する（サーバー側は冪等なので害なし）
      NET.sendReady(G.difficulty);
      if (G._readyTimer) clearInterval(G._readyTimer);
      G._readyTimer = setInterval(function() {
        const waiting = G.online && G.mode === "intro" && round && !round.event;
        if (waiting) {
          NET.sendReady(G.difficulty);
        } else {
          clearInterval(G._readyTimer);
          G._readyTimer = null;
        }
      }, 1000);
      // 待機画面の人数表示。rosterはスタートを押す前（接続直後）にも届いているので、
      // 押した瞬間に手元の最新値（NET.lastPlayers）で即describeし、以後rosterで更新する
      const updateWaitingText = function(players) {
        if (G.mode !== "intro" || (round && round.event)) return;
        if (!NET.connected) {
          G.introText = "接続中…";
          return;
        }
        const list = players || NET.lastPlayers || [];
        const humanCount = list.filter(function(p) { return p.kind === "human"; }).length;
        // 対戦中の部屋に後から入った場合、その試合が終わるまでは始まらない
        // （サーバーは試合の終了を知らないため正確な表示はフェーズ3で対応）
        G.introText = humanCount >= 2
          ? "参加者 " + humanCount + " 人　全員が押すと開始…"
          : "参加者 " + humanCount + " 人　相手の入室待ち…";
      };
      NET.onRoster(updateWaitingText);
      updateWaitingText(null);
    } else {
      // localモード: 従来どおりホスト主導で start を配る
      // 相手がすでに退出している状態で「もう一度」を押した場合は待たずに知らせる
      const otherSeat = NET.mySeat === 0 ? 1 : 0;
      if (NET.departedSeats[otherSeat]) {
        gameOver("相手が退出しました（対戦するにはもう一度URLを開いてもらってね）");
        return;
      }

      if (NET.mySeat === 0) {
        // ホスト: ゲスト（絶対席1）がスタートを押している（ready）のを確認してから開始を配る
        const tryStart = function() {
          if (G.mode !== "intro") return;
          const ts = NET.readySeats[1];
          if (!ts || Date.now() - ts > 3000) return;
          const t0 = Date.now() + 2000;
          const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
          const players = [
            { seat: 0, name: "P1", kind: "human" },
            { seat: 1, name: "P2", kind: "human" },
            { seat: 2, name: "二郎", kind: "cpu" },
            { seat: 3, name: "四郎", kind: "cpu" },
          ];
          NET.broadcastStart(t0, seed, players);
        };
        NET.onReady(tryStart);
        tryStart();
      } else {
        // ゲスト: readyを送って start を待つ。1秒ごとに再送
        NET.sendReady(G.difficulty);
        if (G._readyTimer) clearInterval(G._readyTimer);
        G._readyTimer = setInterval(function() {
          const waiting = G.online && G.mode === "intro" && round && !round.event;
          if (waiting) {
            NET.sendReady(G.difficulty);
          } else {
            clearInterval(G._readyTimer);
            G._readyTimer = null;
          }
        }, 1000);
      }
    }

    // 待ち合わせ中の表示（armRoundが呼ばれてintroが進み始めると上書きされる）
    // WSモードの文言は updateWaitingText が管理済み（上で設定・roster更新）
    if (!NET.wsMode) {
      G.introText = NET.mySeat === 0 ? "相手を待っています…" : "ホストを待っています…";
    }
    G.onlineWaiting = true;
  } else {
    // 1人用: 従来どおり音声時計が動き出したら armRound
    if (audioCtx.state === "running") armRound();
  }
}

// 開始時刻を「音声時計が動いている今」基準で確定してイントロをスケジュールする。
// iOSでresumeの完了が遅れても、完了した時点からきれいに始まり、宙ぶらりんにならない
function armRound(t0Override, firstActorLocal) {
  // オンライン時はホストが配布した t0 を使う。1人用は従来どおり現在時刻+0.5
  const t0 = (t0Override !== undefined) ? t0Override : audioCtx.currentTime + 0.5;
  round.t0 = t0;
  round.phaseT = t0;
  // 最初の手番: 指定があればその席（=最後にミスした人からのリスタート）。
  // 指定なしの初回は「絶対席0」。1人用では自分（=0）、オンラインでは各タブの
  // ローカル座標に変換する（ここを各タブの「自分」にすると初手から進行が分岐する）
  const firstActor = (firstActorLocal !== undefined)
    ? firstActorLocal
    : (G.online ? toLocal(0) : 0);
  G.starterName = G.chars[firstActor] ? seatDisplayName(firstActor) : "";
  G.onlineWaiting = false; // 待ち合わせ終了
  // 通し拍番号はリスタートを跨いでも巻き戻さない（人間手番ゲート・ミス重複防止のキー）
  if (round.beatCounter === undefined) round.beatCounter = 0;
  round.beatCounter++;
  round.event = {
    type: "point",
    t: t0 + FIRST_BEAT * round.interval,
    actor: firstActor,
    beat: round.beatCounter,
  };
  round.awaitingClock = false;
  // 開始者がCPU（死亡した席の代走を含む）なら行動タイミングを仕込む
  // （1人用は開始者=自分なのでno-op。乱数消費は全タブ対称）
  prepareCpu();
  // 1.2はバンドパスで削れる分の補償。声(1.0)と並んでも埋もれない音量にする
  for (const b of INTRO_CLAPS) playClap(t0 + b * round.interval, 1.2);
  playTick(round.event.t);
}

function gameOver(reason) {
  G.mode = "gameover";
  G.loseReason = reason;
  G.turnActor = null;
  G.rankingList = null; // 前回のランキングをリセット
  // オンライン対戦のスコアはルールが別物なので1人用のベスト記録を汚さない
  if (!G.online && G.score > G.bests[G.difficulty]) {
    G.bests[G.difficulty] = G.score;
    G.newBest = true;
    localStorage.setItem("saburo_best_" + G.difficulty, String(G.score));
  }
  playBuzzer();

  // 1人用: スコア送信とランキング取得（スコア>0かつ名前あり）
  if (!G.online && G.score > 0) {
    const playerName = (function() {
      const params = new URLSearchParams(location.search);
      return params.get("name") || localStorage.getItem("saburo_name") || null;
    })();
    if (playerName) {
      fetch(SABURO_SERVER_HTTP + "/saburo/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: playerName, difficulty: G.difficulty, score: G.score }),
      }).catch(function(e) { console.warn("saburo: score submit failed", e); });
    }
    // ランキング取得（失敗は無視）
    fetch(SABURO_SERVER_HTTP + "/saburo/ranking?difficulty=" + G.difficulty)
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && Array.isArray(data)) {
          G.rankingList = data.slice(0, 5);
        }
      })
      .catch(function() { /* 無視 */ });
  }
}

// 表示用の席名。自席は「◯◯（あなた）」だと長いので、文中では「あなた」に短縮する
function seatDisplayName(localSeat) {
  if (localSeat === 0) return "あなた";
  return (G.chars[localSeat] && G.chars[localSeat].name) || "P" + (toAbs(localSeat) + 1);
}

// ---------- オンライン: ミス処理（ライフ制） ----------
// 自分のミスはここを必ず通す（1人用は従来どおり即gameOver）
function reportSelfMiss(reason) {
  if (!G.online) {
    gameOver(reason);
    return;
  }
  // 死亡後（CPU代走中）の自分は判定対象外
  if (G.chars[0] && G.chars[0].kind === "cpu") return;
  const ev = round && round.event;
  const beat = ev ? ev.beat : -1;
  NET.sendInput(beat, "miss", [], "miss");
  handleMiss(0, reason, beat);
}

// ミス確定（自分・リモート共通）。ライフを減らし、リスタートか試合終了へ
function handleMiss(seat, reason, beat) {
  const ev = round && round.event;
  if (beat === undefined) beat = ev ? ev.beat : -1;
  const key = beat + ":" + seat;
  if (G._lastMissKey === key) return; // 同一ミスの重複処理防止
  G._lastMissKey = key;

  playBuzzer();
  G.lives[seat] = Math.max(0, (G.lives[seat] || 0) - 1);
  const name = seatDisplayName(seat);

  if (G.lives[seat] <= 0) {
    // 死亡: 以降この席はCPUが代走する（死亡時のクドス支払いはフェーズ4=ゼウスくん側）
    G.chars[seat].kind = "cpu";
    G.humanSeats = G.humanSeats.filter(function(s) { return s !== seat; });
  }

  // 生き残りの人間が1人以下になったら試合終了
  const alive = [];
  for (let i = 0; i < 4; i++) {
    if (G.chars[i] && G.chars[i].kind === "human") alive.push(i);
  }
  if (alive.length <= 1) {
    gameOver(alive.length === 1 ? seatDisplayName(alive[0]) + " の勝ち！" : "引き分け…");
    return;
  }

  // ライフが残っていれば一時停止。ミスした人がスタートを押して再開する（自動再開しない）
  G.missInfo = name + " がミス（のこりライフ " + G.lives[seat] + "）";
  G.resumeSeat = seat;
  G.starterName = name;
  round.pendingKeys = null;
  G.turnActor = null;
  G.mode = "interlude";
}

// interlude中、ミスした人（resumeSeat=自分）がスタートを押したら再開を全タブへ配る
function tryResume() {
  if (!G.online || G.mode !== "interlude") return;
  if (G.resumeSeat !== 0) return; // 再開ボタンはミスした本人だけ
  NET.sendResume(Date.now() + 2000, toAbs(G.resumeSeat));
}

// 再開メッセージ（自分・リモート共通）: ミスした人からテンポ初速で再スタート
function handleResume(t0Wall, actorAbs) {
  if (!G.online || G.mode !== "interlude") return;
  if (audioCtx.state !== "running") audioCtx.resume().catch(function() {});
  round.interval = 60 / G.diff.bpm;
  G.bpmNow = G.diff.bpm;
  round.beats = 0;
  round.consec = [0, 0, 0, 0];
  round.pendingKeys = null;
  G.resumeSeat = null;
  G.mode = "intro";
  const _resumeNowMs = NET.wsMode ? NET.serverNowMs() : Date.now();
  const t0Local = audioCtx.currentTime + (t0Wall - _resumeNowMs) / 1000;
  armRound(t0Local, toLocal(actorAbs));
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
  // 通し拍番号を採番（人間手番ゲートのキー）
  if (round.beatCounter === undefined) round.beatCounter = 0;
  round.beatCounter++;
  nextEvent.beat = round.beatCounter;
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
  // オンライン対戦は勝ち負けで決まるため点数なし（永明決定 2026-07-06）
  if (!G.online) {
    let gain = 1;
    if (actor === 0 && targets.length === 2 && round.consec[0] === 0) gain = 2;
    G.score += gain;
    addPopup(actor, gain);
  }
  maybeRamp();

  if (targets.length === 2) {
    round.consec[actor]++;
    advanceEvent({
      type: "haihai",
      t: ev.t + round.interval,
      actors: targets.slice(),
      returnTo: actor,
      cpuDone: false,
      // 1人用: 自分が含まれる時だけ応答待ち。
      // オンライン: 人間（自分・リモート問わず）が1人でも含まれれば応答待ち
      playerDone: G.online
        ? !targets.some(function(a) { return G.chars[a] && G.chars[a].kind === "human"; })
        : !targets.includes(0),
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
  if (ev.type !== "point") return;
  if (G.online) {
    // オンライン時: 乱数を引くのは「本物のCPU」の手番だけ。
    // ev.actor !== 0 で判定すると、リモート人間の手番で自分のタブだけ乱数を引いてしまい
    // （相手のタブではそれは actor === 0 なので引かない）、以後の乱数列が全タブでズレる
    const ch = G.chars[ev.actor];
    if (!ch || ch.kind !== "cpu") return;
    ev.cpuActAt = ev.t + (NET.rng()() - 0.5) * 0.05;
    ev.cpuDone = false;
  } else if (ev.actor !== 0) {
    // 1人用: 従来どおり
    ev.cpuActAt = ev.t + (Math.random() - 0.5) * 0.05;
    ev.cpuDone = false;
  }
}

function cpuChooseTargets(actor) {
  // オンライン時: 抽選は必ず「絶対席番号」で行い、結果をローカル座標へ変換して返す。
  // ローカル座標のまま抽選すると、同じ乱数を引いても others 配列の中身（実体）が
  // タブごとに別人なので、指し先が画面ごとに分岐する
  const actorAbs = G.online ? toAbs(actor) : actor;
  const others = [0, 1, 2, 3].filter((i) => i !== actorAbs);
  const canDouble = round.consec[actor] < 2;
  // 乱数の呼び出し順は「拍の進行（advanceEvent → prepareCpu → cpuChooseTargets）」
  // だけに依存し、描画・ローカル入力には依存しない（決定論の核心）
  const rnd = G.online ? NET.rng() : Math.random.bind(Math);
  let picked;
  if (canDouble && rnd() < G.diff.cpuDouble) {
    const i = Math.floor(rnd() * 3);
    let j = Math.floor(rnd() * 2);
    if (j >= i) j++;
    picked = [others[i], others[j]];
  } else {
    picked = [others[Math.floor(rnd() * 3)]];
  }
  return G.online ? picked.map(toLocal) : picked;
}

// プレイヤーの指差し入力を確定する（同時押し収集後に呼ばれる）
function resolvePlayerPoint() {
  if (G.mode === "gameover" || !round.pendingKeys) return;
  const { keys, t } = round.pendingKeys;
  round.pendingKeys = null;
  const ev = round.event;
  if (ev.type !== "point" || ev.actor !== 0) return;

  if (Math.abs(t - ev.t) > winNow()) {
    reportSelfMiss(t < ev.t ? "早すぎた！" : "遅すぎた！");
    return;
  }
  if (keys.length === 2 && round.consec[0] >= 2) {
    reportSelfMiss("同時さしは連続2回まで！");
    return;
  }

  if (G.online) {
    // オンライン時: 自分の成功を送信し、ローカルには即適用
    NET.sendInput(ev.beat, "point", keys, "ok");
  }
  doPoint(0, keys);
}

function resolvePlayerHaihai(t) {
  const ev = round.event;
  if (Math.abs(t - ev.t) > winNow()) {
    reportSelfMiss(t < ev.t ? "ハイハイが早すぎた！" : "ハイハイが遅すぎた！");
    return;
  }
  playVoice("haihai", G.chars[0].pitch);
  G.chars[0].anim = { type: "haihai", start: audioCtx.currentTime, until: ev.t + round.interval * 0.9 };

  if (G.online) {
    // オンライン時: 自分のハイハイ完了を送信し、playerDoneSeats に記録
    NET.sendInput(ev.beat, "haihai", [], "ok");
    if (!ev.playerDoneSeats) ev.playerDoneSeats = {};
    ev.playerDoneSeats[0] = true;
    _checkHaihaiDone(ev);
  } else {
    ev.playerDone = true;
  }
}

// ---------- オンライン: リモート人間の入力を受けたときの処理 ----------
// net.js の NET.onInput コールバックから呼ばれる
function handleRemoteInput(beat, localSeat, action, localTargets, result) {
  if (G.mode === "gameover") return;
  if (!round || !round.event) return;

  // リモートのミス: ライフ制の共通処理へ（重複はhandleMiss側でbeat:seatキーで弾く）
  if (result === "miss") {
    handleMiss(localSeat, seatDisplayName(localSeat) + " がリズムを外した！", beat);
    return;
  }

  const ev = round.event;
  // 拍番号が一致するイベントにだけ適用する（リスタート直後などに古い入力が
  // 新しいイベントへ誤適用されるのを防ぐ。拍番号は全タブで共通の通し番号）
  if (ev.beat !== beat) return;

  if (action === "point") {
    // リモート人間の指差しを適用
    if (ev.type === "point" && ev.actor === localSeat) {
      doPoint(localSeat, localTargets);
    }
    // ゲートから当該席を除去
    if (G._inputGate && G._inputGate.beat === beat) {
      G._inputGate.pendingSeats.delete(localSeat);
    }
  } else if (action === "haihai") {
    // リモート人間のハイハイを適用
    if (ev.type === "haihai" && ev.actors.includes(localSeat) && !ev.playerDoneSeats) {
      ev.playerDoneSeats = {};
    }
    if (ev.type === "haihai") {
      if (!ev.playerDoneSeats) ev.playerDoneSeats = {};
      ev.playerDoneSeats[localSeat] = true;
      playVoice("haihai", G.chars[localSeat].pitch);
      G.chars[localSeat].anim = {
        type: "haihai",
        start: audioCtx.currentTime,
        until: ev.t + round.interval * 0.9,
      };
      // 全人間席が揃ったか確認（update側の playerDone と整合させる）
      _checkHaihaiDone(ev);
    }
  }
}

// ハイハイ完了チェック: 人間全員が done になったら ev.playerDone をセット
function _checkHaihaiDone(ev) {
  if (!ev.actors) return;
  const humanActors = ev.actors.filter(function(a) {
    return G.chars[a] && G.chars[a].kind === "human";
  });
  // 1人用では kind が未定義のため全員 playerDone = true として進む（既存動作を壊さない）
  if (humanActors.length === 0) {
    ev.playerDone = true;
    return;
  }
  if (!ev.playerDoneSeats) return;
  const allDone = humanActors.every(function(a) { return ev.playerDoneSeats[a]; });
  if (allDone) ev.playerDone = true;
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
  // オンラインのゲストはホストの start メッセージ（armRound）が来るまでイベントが無い
  if (!ev) return;
  const win = winNow();

  // ビート位相（描画用）
  while (now >= round.phaseT + round.interval) round.phaseT += round.interval;
  G.beatPhase = Math.max(0, (now - round.phaseT) / round.interval);

  // イントロ表示と play への移行
  if (G.mode === "intro") {
    const raw = (now - round.t0) / round.interval;
    const claps = INTRO_CLAPS.filter((b) => raw >= b).length;
    G.introText = ["", "タン", "タン　タン", "タン　タン　タ", "タン　タン　タタ", "タン　タン　タタ　タン"][claps];
    if (raw >= 3.5) {
      G.mode = "play";
      G.missInfo = ""; // リスタート表示はプレイ開始で消す
    }
  }

  // アニメーションの期限切れ
  for (const c of G.chars) {
    if (c.anim && now > c.anim.until) c.anim = null;
  }
  // 消えたポップアップの掃除
  if (G.popups.length) G.popups = G.popups.filter((p) => now - p.t0 < 0.9);

  G.turnActor = ev.type === "point" ? ev.actor : null;

  if (ev.type === "point") {
    if (ev.actor === 0 && !(G.online && G.chars[0].kind === "cpu")) {
      // 自分（ローカル0番）の番: 時間切れ判定（死亡後=CPU代走中は下のCPU分岐が担当）
      if (now > ev.t + win && !round.pendingKeys) {
        reportSelfMiss("反応できなかった…");
      }
    } else if (G.online && G.humanSeats && G.humanSeats.includes(ev.actor)) {
      // オンライン時: リモート人間の番 → resolve（handleRemoteInput）が来るまで待つだけ
      // タイムアウトはフェーズ3（サーバー審判）で実装。フェーズ1は性善説でスキップ
    } else if (!ev.cpuDone && now >= ev.cpuActAt) {
      // CPUの番: 従来どおりローカル決定論で進める
      ev.cpuDone = true;
      doPoint(ev.actor, cpuChooseTargets(ev.actor));
    }
  } else if (ev.type === "haihai") {
    // CPU側のハイハイは拍ちょうどに実行（人間席はスキップ: handleRemoteInput で処理する）
    if (!ev.cpuDone && now >= ev.t) {
      ev.cpuDone = true;
      let delay = 0;
      for (const a of ev.actors) {
        // 自分の席は自分の入力で処理する（ただし死亡後=CPU代走中はCPUとして鳴らす）
        if (a === 0 && !(G.online && G.chars[0].kind === "cpu")) continue;
        // オンライン時: リモート人間席はリモートの入力で処理する
        if (G.online && G.humanSeats && G.humanSeats.includes(a)) continue;
        playVoice("haihai", G.chars[a].pitch, ev.t + delay);
        G.chars[a].anim = { type: "haihai", start: ev.t, until: ev.t + round.interval * 0.9 };
        delay += 0.03;
      }
    }
    // プレイヤーが含まれる場合の時間切れ
    if (!ev.playerDone && now > ev.t + win) {
      // オンライン時、自分の分は済んでいて（または自分は無関係で）リモート人間待ちなら
      // 自分では判定しない（missはその人のタブが申告する）
      const selfAlive = !(G.online && G.chars[0].kind === "cpu");
      const selfPending = selfAlive && ev.actors.includes(0) &&
        !(ev.playerDoneSeats && ev.playerDoneSeats[0]);
      if (G.online && !selfPending) {
        // リモート待ち: 何もしない
      } else {
        reportSelfMiss("ハイハイできなかった…");
        return;
      }
    }
    // 全員完了したら手番が同時指しした人に戻る
    if (ev.cpuDone && ev.playerDone && now >= ev.t) {
      if (!G.online) {
        G.score++;
        addPopup(ev.returnTo, 1);
      }
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
  // オンライン時、死亡後（CPU代走中）の自分の入力は受け付けない
  if (G.online && G.chars[0] && G.chars[0].kind === "cpu") return;
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
    reportSelfMiss("今はハイハイのタイミング！");
  } else if (G.mode === "play") {
    reportSelfMiss("自分の番じゃないのに指をさした！");
  }
}

function handleHaihaiInput(t) {
  if (!round || !round.event) return; // 開始時刻の確定前は無視
  // オンライン時、死亡後（CPU代走中）の自分の入力は受け付けない
  if (G.online && G.chars[0] && G.chars[0].kind === "cpu") return;
  const ev = round.event;
  if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
    resolvePlayerHaihai(t);
  } else if (G.mode === "play") {
    reportSelfMiss("今はハイハイじゃない！");
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
    if (key === " ") {
      e.preventDefault();
      startRound();
    }
    return;
  }

  if (G.mode === "howto") {
    closeHowto();
    return;
  }

  if (G.mode === "gameover") {
    if (key === "r") startRound();
    if (key === "t") goTitle();
    return;
  }

  if (G.mode === "interlude") {
    if (key === " ") {
      e.preventDefault();
      tryResume(); // Spaceのみ（押せるのはミスした本人だけ）
    }
    return;
  }

  // オンラインの待ち合わせ中（開始前）は T でタイトルへ戻れる（抜け道の確保）
  if (G.online && G.mode === "intro" && round && !round.event) {
    if (key === "t") goTitle();
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

// タイトルへ戻る。オンライン中は他のタブへ退出を通知する（残された側のフリーズ防止）
function goTitle() {
  if (G.online) {
    if (NET.wsMode) {
      // 退出＋切断までやる（接続だけ生かすと「部屋にいない幽霊」がreadyを送り続けて
      // 二度と試合が始まらない）。次のスタート時に ensureConnected で張り直す
      NET.disconnect();
    } else {
      NET.sendLeave();
    }
  }
  G.mode = "title";
  playUiPop();
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
    else if (inRect(pos, 160, 524, 160, 34)) goTitle();
    return true;
  }
  if (G.mode === "interlude") {
    tryResume(); // どこをタップしても可（押せるのはミスした本人だけ）
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

// タブを閉じた・別ページへ移動したときも退出を通知する
window.addEventListener("pagehide", () => {
  if (G.online) NET.sendLeave();
});

// NET を初期化する（?online=1 / ?ws= / ?mode=local のときだけ有効になる）
// net.js が先に読み込まれている必要がある（index.html の script 順で保証）
NET.init();
G.online = NET.online;

requestAnimationFrame(loop);
