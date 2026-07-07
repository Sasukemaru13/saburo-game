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
  introSub: "",  // イントロ/待機画面の補足行（introTextの下に小さく表示）
  waitNote: "",  // プレイ中の「○○の応答待ち…」表示（リモート人間の入力待ちが長引いた時）
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
  missInfo: "",          // 直前のミス（誰が・のこりライフ）
  missReason: "",        // 直前のミスの種類（「早すぎた！」等・一時停止画面に大きく表示）
  _lastMissKey: null,    // ミスの重複処理防止（beat:seat）
  resumeSeat: null,      // interlude中、再開ボタンを押す担当（ローカル席。ミスした人）
  onlineWaiting: false,  // 開始前の待ち合わせ中か（待機画面のヒント表示用）
  _readyTimer: null,     // ゲストのready再送タイマー
  rankingList: null,     // 1人用ゲームオーバー時の上位5件（fetch成功時のみ）
  _memberOfMatch: true,  // フェーズ3: start受信時に自分が players に含まれていれば true
  rankingScreen: null,   // タイトルのランキング画面データ { list, difficulty, state:"loading"|"ok"|"error" }
  spectating: false,     // フェーズ5: 観戦中か（入力・判定・申告を一切通さない）
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
  if (audioMuted()) return; // 観戦リプレイ中は鳴らさない
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
  if (audioMuted()) return; // 観戦リプレイ中は鳴らさない
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
  if (audioMuted()) return; // 観戦リプレイ中は鳴らさない
  dbg("tick", when);
  const src = audioCtx.createBufferSource();
  src.buffer = tickBuffer;
  const g = audioCtx.createGain();
  g.gain.value = 0.12;
  src.connect(g).connect(audioCtx.destination);
  src.start(Math.max(when, audioCtx.currentTime));
}

function playBuzzer() {
  if (audioMuted()) return; // 観戦リプレイ中は鳴らさない
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

// ---------- ゲーム進行時刻（gameNow） ----------
// 進行判定（update・拍進行・期限判定・アニメ進行）が使う「現在時刻」の集約点。
// 通常は audioCtx.currentTime をそのまま返す（従来と完全に同一）。
// 観戦リプレイ中（SPEC.replaying）は「加速した仮想時刻」を返し、既存の update()
// ロジックをそのまま速回しして決定論リプレイを実現する。
// 注意: 音声再生の時刻指定（playX の when）はここを通さない。リプレイ中は音を
// ミュートするので、音声側は従来どおり audioCtx.currentTime のままでよい。
function gameNow() {
  if (SPEC.replaying) return SPEC.vnow;
  return audioCtx ? audioCtx.currentTime : 0;
}

// ---------- 観戦（spectate）状態 ----------
// replaying:   spectate_init の記録を仮想時刻で速回し中か
// vnow:        リプレイ用の仮想時刻（audioCtx.currentTime と同じ座標系＝秒）
// queue:       未適用のリプレイイベント（start を除く input/miss_decl/resume）
// muted:       リプレイ中の音ミュート（追いついたら false に戻してライブ音を出す）
// targetNow:   追いつきの目標時刻（現在のサーバー同期時刻をローカル座標に変換した値）
const SPEC = {
  replaying: false,
  vnow: 0,
  queue: [],
  muted: false,
  targetNow: 0,
  // リプレイ用の凍結アンカー: 観戦開始時の (audioCtx.currentTime, サーバー時刻ms)。
  // サーバー時刻ms → 仮想座標(秒) の変換をこのアンカー基準で固定する。
  // 実クロックが進んでも変換が一定になり、resume の t0 も vnow と同じ座標に落ちる。
  anchorAudio: 0,
  anchorServerMs: 0,
};

// サーバー時刻(ms) → 仮想座標(秒)。凍結アンカー基準（リプレイ中の唯一の正しい変換）。
// vnow・round.t0・resume の t0 はすべてこの座標で揃う。
function replayServerMsToLocal(ms) {
  return SPEC.anchorAudio + (ms - SPEC.anchorServerMs) / 1000;
}

// リプレイ中は音を出さない。playX 系の頭で呼んで早期returnする
function audioMuted() {
  return SPEC.muted;
}

// ---------- ラウンド進行 ----------
// イベントは絶対時刻 t を持つ。テンポが上がっても次イベントは「前イベント + 今のinterval」。

let round = null;

let startingRound = false;

// 試合中の各メッセージ（start/input/resume/leave/miss_decl/match_end）の受信
// コールバックを NET に登録する。startRound（当事者）と観戦フロー（合流後）で共有する。
// NET.onX は上書き式なので再登録は無害。
function registerMatchCallbacks() {
    // start コールバックは1本に統合する（onStartは上書き式なので二重登録禁止）。
    // ホスト自身も broadcastStart 経由でここを通る
    NET.onStart(function(msg) {
      // 自分がスタート待ち状態のときだけ受け付ける（ゲームオーバー画面等での誤発動防止）。
      // 観戦リプレイの開始（startSpectate）もここを intro 状態で通す
      if (G.mode !== "intro") return;
      // すでに試合が組まれている（armRound済み）なら二発目のstartは無視する。
      // ready再送が開始と行き違うとサーバーが二重にstartを配ることがあり、
      // これを受けるとイントロ中に試合が組み直されて「勝手にスタート」に見える
      if (round && round.event) return;
      // 難易度は常に "normal" 固定（UIを廃止してふつう固定にしたため）
      G.difficulty = "normal";
      G.diff = DIFFICULTIES.normal;
      round.interval = 60 / G.diff.bpm;
      G.bpmNow = G.diff.bpm;
      if (msg.players) {
        G.players = msg.players;
        G.humanSeats = msg.players
          .filter(function(p) { return p.kind === "human"; })
          .map(function(p) { return toLocal(p.seat); });
        G.chars = makeChars(G.players);
      }

      // フェーズ3: 自分が試合メンバーに含まれているか確認する
      // start の players に自分の絶対席が human として入っていなければ「試合メンバー外」。
      // 観戦中は常にメンバー外扱い（席は持つが in_match ではない）
      const selfInMatch = G.spectating
        ? false
        : (msg.players
          ? msg.players.some(function(p) { return p.seat === NET.mySeat && p.kind === "human"; })
          : true); // players がない（localモード等）なら参加とみなす
      G._memberOfMatch = selfInMatch;

      if (!selfInMatch && !G.spectating) {
        // 試合メンバー外（かつ非観戦）: ready 再送タイマーを止めて待機継続
        if (G._readyTimer) {
          clearInterval(G._readyTimer);
          G._readyTimer = null;
        }
        G.introText = "試合が始まりました（次の試合から参加できます）";
        G.introSub = "";
        // armRound せず待機のまま。match_end で待機テキストを戻す
        return;
      }

      if (audioCtx.state !== "running") audioCtx.resume().catch(function() {});
      // msg.t0 はサーバー時刻（ms）。audioCtx.currentTime はタブごとに独立した時計なので
      // サーバー時刻基準でローカル音声時計に変換する。
      // localモードでは NET.serverNowMs() ≒ performance.now() ≒ Date.now() - epoch差 なので
      // 差分が同符号になり実質的に従来の Date.now() と同じ精度で動く。
      const _nowMs = NET.wsMode ? NET.serverNowMs() : Date.now();
      const t0Local = audioCtx.currentTime + (msg.t0 - _nowMs) / 1000;
      if (t0Local < audioCtx.currentTime + 0.2 && !G.spectating) {
        console.warn("saburo: start時刻が過去/直近すぎる (受信遅れ?)", msg.t0, t0Local);
      }
      armRound(t0Local);
    });

    NET.onInput(handleRemoteInput);
    NET.onResume(function(msg) { handleResume(msg.t0, msg.actor, msg.lives); });
    NET.onLeave(function(seat) {
      // タイトル表示中の切断は黙って張り直す（在室者一覧・入室状態を保つ）。
      // タブ切替はvisibilitychange側が拾うが、表示中の回線切れはここが唯一の再接続経路
      if (G.mode === "title" && seat === -1) {
        G._wsRetry = (G._wsRetry || 0) + 1;
        if (G._wsRetry <= 5) {
          setTimeout(function() {
            if (G.online && NET.wsMode && !NET.connected) NET.ensureConnected();
          }, 300 * G._wsRetry);
        }
        return;
      }
      // 観戦中の切断: 試合を打ち切らず観戦を解いて待機へ戻す（自分は当事者ではない）
      if (G.spectating && seat === -1) {
        exitSpectate();
        gameOver("観戦していた試合との接続が切れました");
        return;
      }
      // 進行中・待機中なら試合を打ち切る（すでに終了画面なら何もしない）
      if (G.mode === "intro" || G.mode === "play" || G.mode === "interlude") {
        if (seat === -1) {
          // 開始前の待機中の切断は黙って張り直す（スマホがタブを離れると
          // ソケットが静かに死に、スタート直後に切断通知が届くことがある）。
          // 張り直しが続く場合だけ諦めて知らせる
          if (G.mode === "intro" && round && !round.event) {
            G._wsRetry = (G._wsRetry || 0) + 1;
            if (G._wsRetry <= 5) {
              G.introText = "接続中…";
              setTimeout(function() { NET.ensureConnected(); }, 300 * G._wsRetry);
              return;
            }
          }
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

    // フェーズ3: サーバー公式ミス宣言（バグ3修正で同時ミス裁定にも使う）
    // サーバーが採用した1件だけが全員に届く。楽観適用したものと食い違う場合はリコンサイル
    NET.onMissDecl(function(absSeat, beat, reason) {
      const localSeat = toLocal(absSeat);
      const key = beat + ":" + localSeat;
      // すでに同一beat:seatのミスを処理済みなら重複適用しない（楽観適用と一致した場合）
      if (G._missApplied && G._missApplied.has(key)) return;
      // 別人のミスがサーバーから届いた場合（楽観適用した自分のミスを巻き戻す必要あり）:
      // 自分が既にinterludeに入っていて別beatのリコンサイルが必要なケースを検出する。
      // 観戦中は自分の楽観適用がないのでリコンサイル不要
      const myKey = beat + ":0"; // 自分のローカル席は常に0
      if (!G.spectating && G._lastMissKey === myKey && localSeat !== 0) {
        // 自分のミスを楽観適用済みだが、サーバーは別人を採用 → 自分のミスを取り消して
        // 別人のミスで上書きする（interlude表示・resumeSeat・ライフ減を再設定）
        G._lastMissKey = null; // 重複防止キーをリセットして下の handleMiss を通す
        // ライフを +1 して楽観適用分を戻す（死亡判定も取り消し）
        G.lives[0] = Math.min(3, G.lives[0] + 1);
        if (G.chars[0] && G.chars[0].kind === "cpu") {
          // CPU化を戻す（まだ生きていた）
          G.chars[0].kind = "human";
          if (!G.humanSeats.includes(0)) G.humanSeats.push(0);
        }
      }
      handleMiss(localSeat, reason || "反応できなかった…（時間切れ）", beat);
    });

    // フェーズ3: 試合終了の再配布（自分が送ったものも返ってくる）
    NET.onMatchEnd(function(winner) {
      if (G.mode === "gameover") return; // すでに終了済みなら無視
      // 観戦中の match_end: 観戦を解いて通常の待機画面（お辞儀待ち）に戻す
      if (G.spectating) {
        exitSpectate();
        const reason = winner >= 0
          ? seatDisplayName(toLocal(winner)) + " の勝ち！"
          : "引き分け…";
        gameOver(reason);
        NET.inProgress = false;
        return;
      }
      if (G.mode === "play" || G.mode === "interlude" || G.mode === "intro") {
        const reason = winner >= 0
          ? seatDisplayName(toLocal(winner)) + " の勝ち！"
          : "引き分け…";
        gameOver(reason);
      }
      // 試合メンバー外で待機中だった場合: 待機テキストを通常に戻す
      if (!G._memberOfMatch) {
        G._memberOfMatch = true;
        if (G.mode === "intro" && round && !round.event) {
          // updateWaitingText は WSモードなので roster が来た時に更新されるが
          // match_end 直後は roster が届く前に文言が stale になるため暫定で更新する
          G.introText = "参加待ち…";
          G.introSub = "次の試合から参加できます";
        }
      }
      // inProgress フラグを折る
      NET.inProgress = false;
    });
}

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
  G.missReason = "";
  G.starterName = "";
  G._lastMissKey = null;
  G._missApplied = new Set();

  round = {
    t0: 0,
    interval: 60 / G.diff.bpm,
    beats: 0,            // テンポアップ判定用の通し拍数
    consec: [0, 0, 0, 0], // 同時さしの連続回数
    phaseT: 0,           // 描画用ビート位相の基準時刻
    pendingKeys: null,   // プレイヤーの指差し入力収集 {keys:[], t}
    earlyInput: null,    // リモート手番の隙間に保留した早押し {kind:"point"|"haihai", keys, t}
    event: null,
    awaitingClock: true, // 音声時計が動き出した瞬間にarmRoundで開始時刻を確定する
    beatCounter: 0,
    stallReportedBeat: -1, // フェーズ3: stall_report を送った最後の beat（重複防止）
  };

  if (G.online) {
    // オンライン時は awaitingClock フラグを使わず、NET の start コールバックで armRound を呼ぶ
    round.awaitingClock = false;

    // 試合中の各メッセージ（start/input/resume/leave/miss_decl/match_end）の
    // コールバックを登録する。観戦フローもライブ合流後に同じ経路を使うため共有する
    registerMatchCallbacks();

    if (NET.wsMode) {
      // WSモード: 全員が ready を送ってサーバーの start を待つ（席0もそれ以外も同じ）。
      // タイトルへ戻って切断していた場合はここで張り直す（再入室）
      NET.ensureConnected();
      // 接続確立前にスタートを押すと最初の送信は握り潰される（readyState未OPEN）ため、
      // 待機中は1秒ごとに再送する（サーバー側は冪等なので害なし）
      NET.sendReady("normal");
      if (G._readyTimer) clearInterval(G._readyTimer);
      G._readyTimer = setInterval(function() {
        const waiting = G.online && G.mode === "intro" && round && !round.event;
        if (waiting) {
          NET.sendReady("normal");
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
          G.introSub = "";
          // バグ4修正: 「接続中」表示になったらウォッチドッグを起動する
          _startConnectingWatchdog();
          return;
        }
        _clearConnectingWatchdog(); // 接続できたらウォッチドッグをリセット
        const list = players || NET.lastPlayers || [];
        const humanCount = list.filter(function(p) { return p.kind === "human"; }).length;
        const readyCount = list.filter(function(p) { return p.ready; }).length;
        // お辞儀した（ready）プレイヤーから順に席名をDiscord名に切り替える演出
        // G.charsはstartRound時点では makeChars() = CPUキャラ名で初期化されている
        if (G.onlineWaiting && G.chars) {
          const WAIT_CPU_NAMES = ["太郎", "一郎", "二郎", "四郎"];
          for (let local = 0; local < 4; local++) {
            const abs = toAbs(local);
            const player = list.find(function(p) { return p.seat === abs; });
            if (!player) continue;
            if (player.kind === "human" && player.ready) {
              // ready済みならDiscord名を表示（自分は「名前（あなた）」形式）
              const displayName = local === 0
                ? (player.name ? player.name + "（あなた）" : "あなた")
                : (player.name || "P" + (abs + 1));
              if (G.chars[local]) {
                G.chars[local].name = displayName;
                G.chars[local].kind = "human";
              }
            } else if (player.kind === "human" && !player.ready) {
              // まだお辞儀していない人間席はCPU名のまま
              if (G.chars[local]) {
                G.chars[local].name = WAIT_CPU_NAMES[abs];
                G.chars[local].kind = "cpu";
              }
            }
          }
        }
        // フェーズ3: 試合中（inProgress）なら「試合中・終了待ち」を補足に出す
        if (NET.inProgress) {
          G.introText = "いま試合中です";
          G.introSub = "試合が終わると参加できます";
          return;
        }
        // 「何が起きていて・何を待っているか」を具体的に出す（2026-07-08 実地フィードバック）
        // メイン行は短く保ち、補足はintroSub（下の小さい行）に分ける
        if (humanCount >= 2) {
          // まだお辞儀していない人の名前を出す（誰待ちかを見えるように）
          const waitingNames = list
            .filter(function(p) { return p.kind === "human" && !p.ready; })
            .map(function(p) { return (p.name || "?").slice(0, 8); });
          G.introText = "お辞儀した人 " + readyCount + "/" + humanCount;
          G.introSub = waitingNames.length > 0
            ? waitingNames.join("・") + " のお辞儀を待っています"
            : "まもなく開始！";
        } else {
          G.introText = "部屋にいるのはあなただけ";
          G.introSub = "対戦相手の入室を待っています…";
        }
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
        NET.sendReady("normal");
        if (G._readyTimer) clearInterval(G._readyTimer);
        G._readyTimer = setInterval(function() {
          const waiting = G.online && G.mode === "intro" && round && !round.event;
          if (waiting) {
            NET.sendReady("normal");
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
  G.introSub = "";         // 待機中の補足行を消す（イントロのタンタン表示に混ざらないように）
  G.waitNote = "";
  round.earlyInput = null;
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
      // URLに ?stoken= があればbodyに含める（週間ランキング対象）
      const stoken = (function() {
        const params = new URLSearchParams(location.search);
        return params.get("stoken") || null;
      })();
      const body = { name: playerName, difficulty: G.difficulty, score: G.score };
      if (stoken) body.stoken = stoken;
      fetch(SABURO_SERVER_HTTP + "/saburo/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

// ---------- ベスト記録のサーバー同期 ----------
// ページ読み込み時（1人用かつ名前あり）に /saburo/mybest を叩き、
// サーバーとローカルの食い違いを解消する
function syncBestWithServer() {
  const params = new URLSearchParams(location.search);
  // オンラインモードでは動かさない
  if (params.has("online") || params.has("ws") || params.get("mode") === "local") return;
  const playerName = params.get("name") || localStorage.getItem("saburo_name") || null;
  if (!playerName) return;

  fetch(SABURO_SERVER_HTTP + "/saburo/mybest?name=" + encodeURIComponent(playerName))
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (!data) return;
      // サーバー値とローカル値を難易度ごとに比較して同期する
      for (const diff of Object.keys(DIFFICULTIES)) {
        const serverScore = (typeof data[diff] === "number") ? data[diff] : 0;
        const localScore = G.bests[diff];
        if (serverScore > localScore) {
          // サーバー > ローカル: ローカルをサーバー値に上書き。
          // 同期はこの一方向（サーバー→端末）だけ。逆方向の「吸い上げ」は廃止した——
          // 端末に残った古い記録が勝手にランキングへ復活し続けるため（66点事件 2026-07-07）。
          // サーバーのランキングに載るのは実際にプレイした時のスコアだけ
          G.bests[diff] = serverScore;
          localStorage.setItem("saburo_best_" + diff, String(serverScore));
        }
      }
    })
    .catch(function(e) { console.warn("saburo: mybest fetch failed", e); });
}

// ---------- ランキング画面のfetch ----------
function fetchRankingScreen(difficulty) {
  G.rankingScreen = { list: null, difficulty: difficulty, state: "loading" };
  fetch(SABURO_SERVER_HTTP + "/saburo/ranking?difficulty=" + difficulty)
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) {
      if (G.rankingScreen && G.rankingScreen.difficulty === difficulty) {
        if (data && (Array.isArray(data) || (data.ranking && Array.isArray(data.ranking)))) {
          const list = Array.isArray(data) ? data : data.ranking;
          G.rankingScreen.list = list.slice(0, 10);
          G.rankingScreen.state = "ok";
        } else {
          G.rankingScreen.state = "error";
        }
      }
    })
    .catch(function() {
      if (G.rankingScreen && G.rankingScreen.difficulty === difficulty) {
        G.rankingScreen.state = "error";
      }
    });
}

// ランキング画面を開く（タイトルの難易度に合わせてfetch）
let rankingOpenedAt = 0;

function openRanking() {
  G.mode = "ranking";
  rankingOpenedAt = performance.now();
  playUiPop(660);
  fetchRankingScreen(G.difficulty);
}

function closeRanking() {
  if (performance.now() - rankingOpenedAt < 250) return;
  G.mode = "title";
  G.rankingScreen = null;
  playUiPop(540);
}

// 表示用の席名。自席は「◯◯（あなた）」だと長いので、文中では「あなた」に短縮する
function seatDisplayName(localSeat) {
  if (localSeat === 0) return "あなた";
  return (G.chars[localSeat] && G.chars[localSeat].name) || "P" + (toAbs(localSeat) + 1);
}

// ---------- オンライン: ミス処理（ライフ制） ----------
// 自分のミスはここを必ず通す（1人用は従来どおり即gameOver）
function reportSelfMiss(reason) {
  // 観戦中は自分の判定・申告を一切行わない（当事者ではない）
  if (G.spectating) return;
  if (!G.online) {
    gameOver(reason);
    return;
  }
  // 死亡後（CPU代走中）の自分は判定対象外
  if (G.chars[0] && G.chars[0].kind === "cpu") return;
  const ev = round && round.event;
  const beat = ev ? ev.beat : -1;
  // バグ3修正: WSモードではサーバーを裁定役にする（先着1件制）。
  // miss_declをサーバーへ送り、サーバーが採用した1件だけが全員に中継される。
  // 楽観的にローカル即適用するが、別人のmiss_declが届いたら上書き（リコンサイル）する。
  // localモードは従来どおりinput(miss)経由（同一マシンなのでレースが起きない）
  if (NET.wsMode) {
    NET.sendMissDecl(beat, toAbs(0), reason);
    handleMiss(0, reason, beat); // 楽観適用（サーバーが別人を採用した場合は上書き）
  } else {
    NET.sendInput(beat, "miss", [], "miss", reason);
    handleMiss(0, reason, beat);
  }
}

// ミス確定（自分・リモート共通）。ライフを減らし、リスタートか試合終了へ
function handleMiss(seat, reason, beat) {
  const ev = round && round.event;
  if (beat === undefined) beat = ev ? ev.beat : -1;
  const key = beat + ":" + seat;
  // 同一ミスの重複処理防止。単一キーだと「楽観適用→別beatの中継→自分のbeatの中継」の
  // 順で二重適用が起きるため、セグメント内の適用済みキーをすべて覚える
  if (!G._missApplied) G._missApplied = new Set();
  if (G._missApplied.has(key)) return;
  G._missApplied.add(key);
  G._lastMissKey = key;

  playBuzzer();
  G.lives[seat] = Math.max(0, (G.lives[seat] || 0) - 1);
  const name = seatDisplayName(seat);
  // どのミスだったか（「早すぎた！」等）を一時停止画面に大きく出す
  G.missReason = reason || "リズムを外した！";

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
    const winnerLocal = alive.length === 1 ? alive[0] : -1;
    // フェーズ3: 勝敗をサーバー経由で全員へ配布（自分のタブが勝敗を決定した場合に送る）
    if (G.online) NET.sendMatchEnd(winnerLocal >= 0 ? toAbs(winnerLocal) : -1);
    gameOver(winnerLocal >= 0 ? seatDisplayName(winnerLocal) + " の勝ち！" : "引き分け…");
    return;
  }

  // ライフが残っていれば一時停止。ミスした人がスタートを押して再開する（自動再開しない）
  G.missInfo = name + " がミス（のこりライフ " + G.lives[seat] + "）";
  G.resumeSeat = seat;
  G.starterName = name;
  round.pendingKeys = null;
  round.earlyInput = null;
  G.waitNote = "";
  G.turnActor = null;
  G.mode = "interlude";
}

// interlude中、ミスした人（resumeSeat=自分）がスタートを押したら再開を全タブへ配る
// バグ1修正: 死亡者（G.chars[0].kind==="cpu"）でもresumeSeat===0なら送れるようにする。
// 死亡後はCPU代走に切り替わって試合を続けるため、再開を押す権利は変わらない
function tryResume() {
  if (!G.online || G.mode !== "interlude") return;
  if (G.resumeSeat !== 0) return; // 再開ボタンはミスした本人だけ
  // フェーズ3: ライフを絶対席順に並べ替えてサーバーへ送る
  const livesAbs = [0, 0, 0, 0];
  for (let local = 0; local < 4; local++) {
    livesAbs[toAbs(local)] = G.lives[local];
  }
  NET.sendResume(Date.now() + 2000, toAbs(G.resumeSeat), livesAbs);
}

// 再開メッセージ（自分・リモート共通）: ミスした人からテンポ初速で再スタート
function handleResume(t0Wall, actorAbs, livesFromMsg) {
  if (!G.online || G.mode !== "interlude") return;
  if (audioCtx.state !== "running") audioCtx.resume().catch(function() {});
  round.interval = 60 / G.diff.bpm;
  G.bpmNow = G.diff.bpm;
  round.beats = 0;
  round.consec = [0, 0, 0, 0];
  round.pendingKeys = null;
  G.resumeSeat = null;
  // 再開で拍番号が0から振り直されるため、ミスの適用済みキーをクリアする。
  // 残すと前セグメントと同じ 拍:席 のミスが重複扱いで握り潰される（フリーズ）
  G._lastMissKey = null;
  if (G._missApplied) G._missApplied.clear();

  // フェーズ3: サーバーから lives が返ってきた場合はそれを正値として採用する。
  // 絶対席順 → ローカル席順に変換して G.lives に適用する
  if (livesFromMsg && Array.isArray(livesFromMsg) && livesFromMsg.length === 4) {
    for (let abs = 0; abs < 4; abs++) {
      const local = toLocal(abs);
      G.lives[local] = livesFromMsg[abs];
      // ライフ0 の席はCPU化（既にcpuなら何もしない）
      if (livesFromMsg[abs] === 0 && G.chars[local] && G.chars[local].kind !== "cpu") {
        G.chars[local].kind = "cpu";
        G.humanSeats = G.humanSeats.filter(function(s) { return s !== local; });
      }
    }
  }

  G.mode = "intro";
  // t0Wall はサーバー時刻(ms)。リプレイ中は凍結アンカー基準で仮想座標に変換し、
  // 前セグメントの vnow と連続させる（serverMsToLocal がリプレイ判定を内包する）。
  // 通常時は従来どおり現在時刻基準
  const t0Local = serverMsToLocal(t0Wall);
  armRound(t0Local, toLocal(actorAbs));
}

// ---------- 観戦（spectate）: 記録の高速リプレイ → ライブ合流 ----------
// spectate_init で受け取った記録（start を先頭に input/miss_decl/resume）を、
// 加速した仮想時刻で既存の update()/handleRemoteInput/handleMiss/handleResume を
// そのまま回して決定論リプレイする。仮想時刻が現在のサーバー同期時刻に追いついたら
// ライブ描画へ移行する（以降は通常のWS中継が今までどおり適用される）。
//
// 決定論の核心: リプレイ専用の進行ロジックは書かない。既存の進行コードを
// gameNow()=仮想時刻で回すだけ。乱数（NET.rng）の消費順序が実試合と一致する。

// サーバー時刻(ms) → ローカル座標(秒)。リプレイ中は凍結アンカー基準で変換し、
// vnow・round.t0・resume の t0 を同じ座標に揃える。通常時は現在時刻基準。
function serverMsToLocal(ms) {
  if (SPEC.replaying) return replayServerMsToLocal(ms);
  const nowMs = NET.wsMode ? NET.serverNowMs() : Date.now();
  return audioCtx.currentTime + (ms - nowMs) / 1000;
}

// 観戦フローの入口（タイトルの「観戦する」ボタン）。当事者にはならない。
// 接続を確認し、試合中の各コールバックと spectate_init コールバックを登録して
// spectate_req を送る。サーバーが記録を返したら startSpectate が走る。
async function startSpectateFlow() {
  if (!G.online || !NET.wsMode) return;
  playUiStart();
  try {
    await initAudio();
  } catch (e) { /* デコード失敗は無視（音は出ないが観戦は可能） */ }
  if (audioCtx && audioCtx.state !== "running") audioCtx.resume().catch(function() {});

  G.mode = "intro";
  G.introText = "観戦の準備中…";
  G.introSub = "";
  G.spectating = false; // spectate_init が届くまではまだ観戦確定でない

  NET.ensureConnected();
  registerMatchCallbacks();          // ライブ合流後に使う共通コールバック
  NET.onSpectateInit(startSpectate); // 記録が届いたらリプレイ開始
  // 接続直後は送信が握り潰されうるので、届くまで少し粘って再送する
  NET.sendSpectateReq();
  let tries = 0;
  const timer = setInterval(function() {
    tries++;
    if (G.spectating || G.mode !== "intro" || tries > 10) {
      clearInterval(timer);
      return;
    }
    NET.sendSpectateReq();
  }, 400);
}

// spectate_init を受けたときの入口。events[0] は start。
function startSpectate(events) {
  // 試合外（空配列）なら観戦対象なし。待機画面へ戻す
  if (!Array.isArray(events) || events.length === 0) {
    G.spectating = false;
    SPEC.replaying = false;
    SPEC.muted = false;
    NET.inProgress = false;
    G.introText = "いま観戦できる試合はありません";
    G.introSub = "";
    // 通常の待機フローに戻す（お辞儀待ち）
    startRound();
    return;
  }
  const startMsg = events[0];
  if (!startMsg || startMsg.type !== "start") return;
  // すでに観戦中なら二重開始しない
  if (G.spectating) return;

  // 観戦モードへ。自分の入力・判定・申告は一切通さない（全席リモート/CPU扱い）。
  G.spectating = true;
  G.online = true;
  G.difficulty = "normal";
  G.diff = DIFFICULTIES.normal;
  G.mode = "intro";
  G.introText = "";
  G.introSub = "";
  G.onlineWaiting = false;
  G.score = 0;
  G.lives = [3, 3, 3, 3];
  G.missInfo = "";
  G.missReason = "";
  G.waitNote = "";
  G._lastMissKey = null;
  G._missApplied = new Set();
  G.popups = [];

  // round を実試合と同じ形で初期化する（startRound と同一の初期値）
  round = {
    t0: 0,
    interval: 60 / G.diff.bpm,
    beats: 0,
    consec: [0, 0, 0, 0],
    phaseT: 0,
    pendingKeys: null,
    earlyInput: null,
    event: null,
    awaitingClock: false,
    beatCounter: 0,
    stallReportedBeat: -1,
  };

  // 仮想時刻を有効化してミュート開始
  SPEC.replaying = true;
  SPEC.muted = true;
  // 残りの記録（start を除く）を適用待ちキューへ
  SPEC.queue = events.slice(1);

  // net.js の start 受信ハンドラは通さないので、PRNG を記録の cpuSeed で
  // 明示的に初期化する（CPU挙動の決定論リプレイに必須）。t0Server も揃える
  NET.cpuSeed = startMsg.cpuSeed;
  NET._rng = makePRNG(startMsg.cpuSeed);
  NET.t0Server = startMsg.t0;

  // 凍結アンカーを確定する（onStart / handleResume / serverMsToLocal がこれ基準で
  // サーバーms→仮想座標を変換する）。ここを起点に全セグメントの t0 が揃う
  SPEC.anchorAudio = audioCtx ? audioCtx.currentTime : 0;
  SPEC.anchorServerMs = NET.wsMode ? NET.serverNowMs() : Date.now();

  // start を既存の onStart 経路に通してラウンドを組み立てる。
  // これで G.players・G.humanSeats・cpuSeed(NET.rng) が実試合と同一に初期化され、
  // armRound により round.event（最初の point）が仮想時刻座標で置かれる。
  if (NET._onStartCb) NET._onStartCb(startMsg);

  // armRound が置いた round.t0（音声時計座標）を仮想時刻の起点にする。
  // ここから update() を速回しして FIRST_BEAT 分のイントロも含めて再生する。
  SPEC.vnow = (round && round.t0) ? round.t0 : (audioCtx ? audioCtx.currentTime : 0);
  SPEC.targetNow = audioCtx ? audioCtx.currentTime : 0;
}

// 観戦を解いて通常状態に戻す（match_end・切断時）
function exitSpectate() {
  G.spectating = false;
  SPEC.replaying = false;
  SPEC.muted = false;
  SPEC.queue = [];
}

// タイトルのスタートボタン（Space/タップ）の分岐。オンラインで試合中なら観戦、
// それ以外は従来どおりお辞儀（startRound）。ラベルは render.js の drawTitle と揃える
function startButtonAction() {
  if (G.online && NET.wsMode && NET.connected && NET.inProgress) {
    startSpectateFlow();
  } else {
    startRound();
  }
}

// 次に適用すべき記録イベントの「発生時刻（仮想時刻座標・秒）」を返す。
// input/miss_decl は beat 番号のみ（時刻は round.event が該当 beat に達したとき）。
// resume は t0(ms) を持つのでセグメント境界として座標変換して使う。
function nextReplayEventTime() {
  const e = SPEC.queue[0];
  if (!e) return Infinity;
  if (e.type === "resume") {
    // resume の t0 は「miss 後の再開時刻」。そのセグメントの armRound 起点になる。
    // ここに vnow を合わせてから適用する
    return serverMsToLocal(e.t0);
  }
  // input / miss_decl は現在のセグメント内。round.event が該当 beat に到達した
  // 時点で適用する（＝いま適用可能なら現在時刻扱い）
  return SPEC.vnow;
}

// キュー先頭の記録イベントを1件適用する。live と同じコールバック経路を通す。
function applyReplayEvent(e) {
  if (e.type === "input") {
    // handleRemoteInput は「相手タブの入力」を beat で照合して適用する。
    // net.js の受信変換（絶対席→ローカル席）と同じ変換をここで行う。
    // 自分自身のエコー（seat===mySeat）も観戦では適用する（全席リモート扱い）
    const localSeat = toLocal(e.seat);
    const localTargets = (e.targets || []).map(toLocal);
    handleRemoteInput(e.beat, localSeat, e.action, localTargets, e.result, e.reason);
  } else if (e.type === "miss_decl") {
    const localSeat = toLocal(e.seat);
    handleMiss(localSeat, e.reason || "時間切れ", e.beat);
  } else if (e.type === "resume") {
    // handleResume は interlude 中のみ効く。直前の miss_decl で interlude に
    // 入っているはず。actor は絶対席。lives も付いてくる
    handleResume(e.t0, e.actor, e.lives);
  }
}

// 毎フレーム呼ぶ。仮想時刻を速く進めながら update() を回し、記録を順に適用する。
// 追いついたらライブへ移行する。
function driveReplay() {
  if (!SPEC.replaying || !round) return;

  // 1フレームで進める仮想時間の総量（実時間よりずっと速く進めてよい）。
  // 1回の update() の刻みは小さく保ち、拍やイベントの取りこぼしを防ぐ。
  const STEP = 0.02;               // 1刻み=20ms相当（十分細かい）
  const MAX_ADVANCE = 4.0;         // 1フレームで最大4秒ぶん進める
  let advanced = 0;

  while (advanced < MAX_ADVANCE) {
    // いま適用できる記録イベントを先に処理する
    // （input/miss_decl は現在セグメント内なので即、resume は境界時刻まで進めてから）
    let guard = 0;
    while (SPEC.queue.length > 0 && guard++ < 64) {
      const e = SPEC.queue[0];
      if (e.type === "resume") {
        const rt = serverMsToLocal(e.t0);
        // resume 時刻まで vnow を進めてから適用する（セグメント境界）
        if (SPEC.vnow < rt) {
          // まだ境界に達していない: このセグメントの残りを回してから来る
          break;
        }
        SPEC.queue.shift();
        applyReplayEvent(e);
      } else {
        // input / miss_decl: 現在の round.event が該当 beat のときだけ適用できる。
        // まだ手前の beat なら update() を回して round.event を進める必要がある。
        if (round.event && round.event.beat === e.beat) {
          SPEC.queue.shift();
          applyReplayEvent(e);
        } else if (round.event && round.event.beat > e.beat) {
          // 取りこぼし（通常は起きない）: 古い記録は捨てて先へ
          SPEC.queue.shift();
        } else {
          break; // round.event がまだ手前 → update() で進める
        }
      }
    }

    // 追いつき判定: 仮想時刻が「今」に達したらライブへ
    if (SPEC.vnow >= audioCtx.currentTime) {
      finishSpectateReplay();
      return;
    }

    // 仮想時刻を1刻み進めて update() を回す（既存の進行ロジックがそのまま動く）
    SPEC.vnow += STEP;
    advanced += STEP;
    update();

    // リプレイ中に試合が終わっていたら（記録が勝敗まで含む場合）抜ける
    if (G.mode === "gameover") {
      SPEC.replaying = false;
      SPEC.muted = false;
      return;
    }
  }
}

// リプレイを終えてライブ観戦へ移行する。以降は通常の音声時計と
// 通常のWS中継（input/miss_decl/resume/match_end）で描画が続く。
function finishSpectateReplay() {
  // 追いつき時点で未適用の記録が残っていたら（ごく最近の入室）先に全部適用する。
  // これらは入室時点までの実イベントで、ライブ中継では二度と届かないため取りこぼせない。
  // まだリプレイ座標で解釈するので muted のまま適用し、その後にライブへ切り替える
  let guard = 0;
  while (SPEC.queue.length > 0 && guard++ < 256) {
    const e = SPEC.queue[0];
    if (e.type === "resume") {
      // resume の t0 まで round を進めてから適用する（境界を飛ばさない）
      const rt = serverMsToLocal(e.t0);
      if (round && round.event && SPEC.vnow < rt) { SPEC.vnow = rt; }
      SPEC.queue.shift();
      applyReplayEvent(e);
    } else if (round && round.event && round.event.beat < e.beat) {
      // まだ手前の beat: 仮想時刻を進めて round.event を該当 beat まで動かす
      SPEC.vnow += round.interval;
      update();
    } else {
      SPEC.queue.shift();
      applyReplayEvent(e);
    }
  }
  SPEC.replaying = false;
  SPEC.muted = false;
  SPEC.queue = [];
  // G.now / gameNow() は以降 audioCtx.currentTime を返す。round.event.t は
  // 音声時計座標のままなので、そのままライブ進行に連続する。
}

// 拍が進むごとに呼ぶ。RAMP_EVERY拍ごとにテンポを上げる（上限なし）
function maybeRamp() {
  round.beats++;
  if (round.beats % RAMP_EVERY === 0) {
    round.interval *= RAMP_FACTOR;
    G.bpmNow = Math.round(60 / round.interval);
    G.speedupAt = gameNow();
    if (FX.speedupFx) playSpeedup(audioCtx.currentTime);
  }
}

// テンポアップのジングル（上昇2音）
function playSpeedup(t) {
  if (audioMuted()) return; // 観戦リプレイ中は鳴らさない
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
    t0: gameNow(),
  });
  if (G.popups.length > 12) G.popups.shift();
}

// 実効判定窓: 高速域では拍間隔の40%まで自動で締まる（窓が拍より広いと壊れるため）
function winNow() {
  return Math.min(G.diff.window, round.interval * 0.4);
}

// バグ2修正: 高ping環境でいきなりアウトになる問題への猶予計算。
// さされた通知を受信した時刻（_pointRecvTime）を記録し、応答期限を
//   「共有拍基準の期限」と「受信時刻 + MIN_RESPONSE_GRACE（拍間隔の80%）」
// の遅い方にする。ただし共有拍基準 + 1拍を超えないようにクリップする。
//
// 【決定論への影響】: この猶予はローカル判定のみに効く。相手タブや
// サーバーは「自分の入力メッセージの到着」で判定するので決定論は壊れない。
// ただし stall_report が猶予より先に発動しないよう、送信タイマーを
// MIN_RESPONSE_GRACE + STALL_MARGIN 以上（定数化）に保つこと
//
// MIN_RESPONSE_GRACE: 拍間隔の80%。100BPMなら約0.48秒。高pingでも最低これだけ応答できる
const MIN_RESPONSE_GRACE_RATIO = 0.8;
// STALL_MARGIN: stall_reportを猶予終了後に余裕を持って送るための追加マージン（秒）
const STALL_MARGIN = 0.5;

// さされた（point手番が自分に来た）通知の受信時刻を記録する。
// handleRemoteInput で相手の「point → 自分さし」が確定したタイミングで呼ぶ
let _pointRecvTime = 0; // audioCtx.currentTime 基準（秒）

// 自分の応答期限を返す。通常は共有拍基準の期限を返し、
// 受信が遅れた場合は猶予を加算した値にする（上限は共有拍基準+1拍）
function selfDeadline(ev) {
  const grace = round.interval * MIN_RESPONSE_GRACE_RATIO;
  const graceDeadline = _pointRecvTime + grace;
  const beatDeadline = ev.t + winNow();
  // 上限: 共有拍基準 + 1拍（無限に伸ばさない）
  const cap = ev.t + round.interval;
  return Math.min(cap, Math.max(beatDeadline, graceDeadline));
}

function advanceEvent(nextEvent) {
  round.phaseT = nextEvent.t - round.interval;
  // 通し拍番号を採番（人間手番ゲートのキー）
  if (round.beatCounter === undefined) round.beatCounter = 0;
  round.beatCounter++;
  nextEvent.beat = round.beatCounter;
  round.event = nextEvent;
  G.waitNote = ""; // 待っていた入力が届いてイベントが進んだ
  playTick(nextEvent.t);
}

// actor が targets を指差す（入力検証は済んでいる前提）
function doPoint(actor, targets) {
  const ev = round.event;
  const now = gameNow();
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
function handleRemoteInput(beat, localSeat, action, localTargets, result, reason) {
  if (G.mode === "gameover") return;
  if (!round || !round.event) return;

  // リモートのミス: ライフ制の共通処理へ（重複はhandleMiss側でbeat:seatキーで弾く）
  if (result === "miss") {
    handleMiss(localSeat, reason, beat);
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
      // バグ2修正: リモートのpointで次手番が自分（ローカル0）になる可能性があるため、
      // このタイミング（通知受信時刻）を _pointRecvTime に記録する。
      // doPoint後に round.event が更新され、actor===0なら受信時刻が期限計算に使われる
      if (round.event && round.event.type === "point" && round.event.actor === 0) {
        _pointRecvTime = audioCtx ? audioCtx.currentTime : 0;
      }
      // 情報が届く前に保留していた自分の早押しを、本来のタップ時刻で判定する
      if (round.earlyInput) {
        const early = round.earlyInput;
        round.earlyInput = null;
        const nev = round.event;
        if (early.kind === "haihai") {
          if (nev.type === "haihai" && nev.actors.includes(0) && !nev.playerDone) {
            resolvePlayerHaihai(early.t);
          } else {
            reportSelfMiss("今はハイハイじゃない！");
          }
        } else {
          if (nev.type === "point" && nev.actor === 0) {
            round.pendingKeys = { keys: early.keys, t: early.t };
            resolvePlayerPoint();
          } else {
            reportSelfMiss("自分の番じゃないのに指をさした！");
          }
        }
      }
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
        start: gameNow(),
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
  const now = gameNow();
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
      // バグ2修正: selfDeadlineで受信遅延を考慮した期限を使う
      if (now > selfDeadline(ev) && !round.pendingKeys) {
        reportSelfMiss("反応できなかった…");
      }
    } else if (G.online && G.humanSeats && G.humanSeats.includes(ev.actor)) {
      // オンライン時: リモート人間の番 → resolve（handleRemoteInput）が来るまで待つだけ
      // タイムアウト裁定はフェーズ3（サーバー審判）。それまでは無言のフリーズに
      // 見えないよう「応答待ち」を表示する
      G.waitNote = now > ev.t + 1.5
        ? seatDisplayName(ev.actor) + " の応答待ち…"
        : "";
      // フェーズ3: stall_report はバグ2の猶予（MIN_RESPONSE_GRACE_RATIO + STALL_MARGIN）
      // より長い時点で送る。100BPMでは 0.6*0.8+0.5=0.98秒→約1.5秒後が妥当
      // stall_threshold = 拍間隔 * MIN_RESPONSE_GRACE_RATIO + STALL_MARGIN（最低2.5秒）
      const stallThreshold = Math.max(2.5, round.interval * MIN_RESPONSE_GRACE_RATIO + STALL_MARGIN);
      // 観戦中は申告しない（当事者ではない）。リプレイは記録の入力で進む
      if (!G.spectating && now > ev.t + stallThreshold && round.stallReportedBeat !== ev.beat) {
        round.stallReportedBeat = ev.beat;
        NET.sendStallReport(ev.beat, toAbs(ev.actor));
      }
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
        // リモート待ち: 判定はしないが、長引いたら表示だけ出す
        if (now > ev.t + 1.5) G.waitNote = "ハイハイの応答待ち…";
        // フェーズ3: 2.5秒超で未応答の人間actor それぞれに stall_report（1beat1回）。
        // 観戦中は申告しない（当事者ではない。リプレイは記録の入力で進む）
        if (!G.spectating && now > ev.t + 2.5 && round.stallReportedBeat !== ev.beat) {
          round.stallReportedBeat = ev.beat;
          for (const a of ev.actors) {
            if (G.chars[a] && G.chars[a].kind === "human") {
              if (!ev.playerDoneSeats || !ev.playerDoneSeats[a]) {
                NET.sendStallReport(ev.beat, toAbs(a));
              }
            }
          }
        }
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
    G.now = gameNow(); // アニメ進行はゲーム時刻基準（リプレイ中は仮想時刻）
    // iOS既知バグの見張り: stateがrunningのまま時計が0.4秒以上進まないなら壊れている。
    // 観戦リプレイ中は仮想時刻で回すので音声時計の見張りは休止する
    if (inGame && !SPEC.replaying) {
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
  // 音声時計が止まっていたら進行も止まる。タップ促しを表示して復帰させる。
  // 観戦リプレイ中は仮想時刻で回すので音声停止扱いにしない
  G.audioStalled = !SPEC.replaying &&
    !!(audioCtx && inGame && (audioCtx.state !== "running" || G.clockStuck));
  if (SPEC.replaying) {
    driveReplay(); // 仮想時刻を速回しして記録を再生・現在に追いついたらライブへ
  } else {
    update();
  }
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
    if (G.online) {
      // オンライン対戦中に「最初からやり直す」と自分だけ新しい試合が始まり
      // ライフも3に戻って大事故になる（実対戦で発生）。対戦から抜ける扱いにして
      // 音声を作り直し、本人はもう一度スタートし直してもらう
      ensureAudioCtx();
      await initAudio();
      NET.sendLeave();
      gameOver("音声が止まったため対戦から抜けました（もう一度どうぞ）");
    } else {
      await startRound();
    }
  } finally {
    resettingAudio = false;
  }
}

// 指差し入力（target: 1=左 2=正面 3=右）
// オンライン: 「リモート人間の手番の直後」か（次イベントの情報がまだ届いていない隙間）。
// この間の入力は誤りと断定できないので保留し、情報が届いてから本来のタップ時刻で判定する
function inRemoteTurnGap(ev) {
  return G.online && ev.type === "point" && ev.actor !== 0 &&
    G.humanSeats && G.humanSeats.includes(ev.actor);
}

function handlePointInput(target, t) {
  if (G.spectating) return; // 観戦中は入力を受け付けない
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
  } else if (inRemoteTurnGap(ev)) {
    // 相手の指し先情報が届く前の早押し。保留して届いた時点で判定する
    if (round.earlyInput && round.earlyInput.kind === "point") {
      if (!round.earlyInput.keys.includes(target)) round.earlyInput.keys.push(target);
    } else {
      round.earlyInput = { kind: "point", keys: [target], t: t };
    }
  } else if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
    reportSelfMiss("今はハイハイのタイミング！");
  } else if (G.mode === "play") {
    reportSelfMiss("自分の番じゃないのに指をさした！");
  }
}

function handleHaihaiInput(t) {
  if (G.spectating) return; // 観戦中は入力を受け付けない
  if (!round || !round.event) return; // 開始時刻の確定前は無視
  // オンライン時、死亡後（CPU代走中）の自分の入力は受け付けない
  if (G.online && G.chars[0] && G.chars[0].kind === "cpu") return;
  const ev = round.event;
  if (ev.type === "haihai" && ev.actors.includes(0) && !ev.playerDone) {
    resolvePlayerHaihai(t);
  } else if (inRemoteTurnGap(ev)) {
    // 同時さしの通知が届く前の早めのハイハイ。保留して届いた時点で判定する
    round.earlyInput = { kind: "haihai", keys: [], t: t };
  } else if (G.mode === "play") {
    reportSelfMiss("今はハイハイじゃない！");
  }
}

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  ensureAudioRunning();
  const key = e.key.toLowerCase();

  if (G.mode === "title") {
    if (key === "h") { openHowto(); return; }
    // ランキング（1人用のみ）
    if (key === "r" && !G.online) { openRanking(); return; }
    if (key === " ") {
      e.preventDefault();
      startButtonAction();
    }
    return;
  }

  // 観戦中はゲーム入力を受け付けない。T でタイトルへ退出できる
  if (G.spectating) {
    if (key === "t") { exitSpectate(); goTitle(); }
    return;
  }

  if (G.mode === "ranking") {
    closeRanking();
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
  // 観戦中はどこをタップしてもタイトルへ退出（ゲーム入力には流さない）
  if (G.spectating) {
    exitSpectate();
    goTitle();
    return true;
  }
  if (G.mode === "title") {
    const s = TITLE_UI.start;
    const h = TITLE_UI.howto;
    const rk = TITLE_UI.ranking;
    if (inRect(pos, s.x, s.y, s.w, s.h)) startButtonAction();
    else if (inRect(pos, h.x, h.y, h.w, h.h)) openHowto();
    else if (rk && !G.online && inRect(pos, rk.x, rk.y, rk.w, rk.h)) openRanking();
    return true;
  }
  if (G.mode === "ranking") {
    closeRanking();
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
  // オンラインの待ち合わせ中（開始前）: 「タイトルへ」ボタン（render.jsと座標を揃える）
  if (G.online && G.mode === "intro" && round && !round.event) {
    if (inRect(pos, 170, 678, 140, 44)) goTitle();
    return true; // 待機中の誤タップをゲーム入力に流さない
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
  if (!document.hidden) {
    ensureAudioRunning();
    // バグ4修正: オンラインモード中はモードを問わず先回り再接続する。
    // v=19 では待機中（intro+event無し）限定だったが、試合中・interlude中でも
    // タブを離れるとソケットが死ぬため、全モードで確認・再接続する
    if (G.online && NET.wsMode) {
      _ensureWsAndResync();
    }
  }
});

// バグ4修正: WS接続を確認して切れていれば再接続・状態を再同期する共通処理
function _ensureWsAndResync() {
  if (!G.online || !NET.wsMode) return;
  const wasConnected = NET.connected;
  NET.ensureConnected(); // 切断していれば張り直す（joined受信でconnected=trueになる）
  // 再接続後の状態同期は onLeave → _initWs → joined のフローで起動する。
  // joined受信後に _wsResyncOnReconnect が呼ばれるよう事前にフラグを立てる
  if (!wasConnected || !NET._transport || !NET._transport.ws ||
      NET._transport.ws.readyState !== WebSocket.OPEN) {
    NET._pendingResync = true; // joined受信時に同期処理を走らせる
  }
}

// バグ4修正: 接続中表示が長引いた場合のウォッチドッグ（10秒）
// 「接続中」表示のまま動かなくなった時の逃げ道を提供する
let _connectingWatchdogTimer = null;

function _startConnectingWatchdog() {
  _clearConnectingWatchdog();
  _connectingWatchdogTimer = setTimeout(function() {
    // 10秒経ってもまだ「接続中」（introかつconnected=false）なら警告を出す
    if (G.online && NET.wsMode && !NET.connected &&
        G.mode === "intro" && round && !round.event) {
      G.introText = "接続できません。タップでタイトルへ";
      G.introSub = "";
    }
  }, 10000);
}

function _clearConnectingWatchdog() {
  if (_connectingWatchdogTimer) {
    clearTimeout(_connectingWatchdogTimer);
    _connectingWatchdogTimer = null;
  }
}

// タブを閉じた・別ページへ移動したときも退出を通知する
window.addEventListener("pagehide", () => {
  if (G.online) NET.sendLeave();
});

// NET を初期化する（?online=1 / ?ws= / ?mode=local のときだけ有効になる）
// net.js が先に読み込まれている必要がある（index.html の script 順で保証）
NET.init();
G.online = NET.online;

// ?resetbest=1: この端末のベスト記録を消す（古い・身に覚えのない記録の掃除用。
// サーバー側の記録を消してもローカルに残っていると同期で復活するため、両方消す手段が要る）
(function() {
  const params = new URLSearchParams(location.search);
  if (params.get("resetbest") === "1") {
    for (const k of Object.keys(DIFFICULTIES)) {
      localStorage.removeItem("saburo_best_" + k);
    }
    G.bests = loadBests();
    console.log("saburo: この端末のベスト記録をリセットしました");
  }
})();

// 1人用かつ名前あり: ベスト記録をサーバーと同期する（非同期・失敗は無視）
syncBestWithServer();

requestAnimationFrame(loop);
