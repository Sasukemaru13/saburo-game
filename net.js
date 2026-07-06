// net.js — オンライン対戦の通信・座席変換・決定論PRNG
// フェーズ0+1: BroadcastChannel によるローカル2タブ擬似対戦 (?mode=local)
// フェーズ2: WebSocket によるサーバー経由の別マシン対戦 (?online=1 または ?ws=...)

// ---------- シード付きPRNG（mulberry32） ----------
// 同一シードで全クライアントが同じ乱数列を引くことが保証される。
// 呼び出し順が「拍の進行」だけに依存し、描画やローカル入力に依存しないことが
// 決定論の絶対条件。

function makePRNG(seed) {
  let s = seed >>> 0; // 32bit uint に正規化
  return function netRng() {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- WebSocketサーバーURL定数 ----------
// ?ws=<url> で上書き可能。省略時はホストで自動切替（localhost→ws / それ以外→wss）

const SABURO_SERVER = (function() {
  const params = new URLSearchParams(location.search);
  if (params.has("ws")) return params.get("ws");
  // ローカル開発ではゲーム配信が :8080（python3 -m http.server）なので、
  // 対戦サーバーは :8081 で起動する運用（PORT=8081 python3 saburo.py）
  return location.hostname === "localhost"
    ? "ws://localhost:8081"
    : "wss://zeus-kun.fly.dev";
})();

// ws: → http:, wss: → https: へ変換したHTTP基底URL（スコア送信に使う）
const SABURO_SERVER_HTTP = SABURO_SERVER.replace(/^ws(s)?:/, function(_, s) {
  return s ? "https:" : "http:";
});

// ---------- Transport 抽象 ----------
// send(msg: object) / onMessage(cb: function(msg: object)) の2メソッドを持つ。
// フェーズ1: LocalTransport（BroadcastChannel）
// フェーズ2: WsTransport（WebSocket）

function LocalTransport(roomId) {
  const channelName = "saburo-room-" + roomId;
  const bc = new BroadcastChannel(channelName);
  let _cb = null;
  bc.onmessage = function(e) {
    if (_cb) _cb(e.data);
  };
  return {
    send: function(msg) {
      bc.postMessage(msg);
    },
    onMessage: function(cb) {
      _cb = cb;
    },
    close: function() {
      bc.close();
    },
  };
}

// ---------- WsTransport（フェーズ2） ----------
// LocalTransport と同じ send/onMessage/close インターフェース。
// 接続断を検知したら onClose コールバックを呼ぶ。

function WsTransport(url) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let _cb = null;
  let _closeCb = null;

  ws.onmessage = function(e) {
    if (!_cb) return;
    try {
      const msg = JSON.parse(e.data);
      _cb(msg);
    } catch (err) {
      console.warn("saburo: WsTransport JSON parse error", err, e.data);
    }
  };

  ws.onclose = function() {
    if (_closeCb) _closeCb();
  };

  ws.onerror = function(e) {
    console.warn("saburo: WebSocket error", e);
  };

  return {
    ws: ws,
    send: function(msg) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    onMessage: function(cb) {
      _cb = cb;
    },
    onClose: function(cb) {
      _closeCb = cb;
    },
    close: function() {
      ws.close();
    },
  };
}

// ---------- 座席変換 ----------
// サーバー絶対席（abs: 0-3）↔ ローカル表示席（local: 自分が常に0）
// 回転写像: local = (abs - mySeat + 4) % 4 / abs = (local + mySeat) % 4
//
// 1人用モードでは mySeat = 0 なので変換は恒等写像になる

let _mySeat = 0;

function setSeat(seat) {
  _mySeat = seat;
}

function toLocal(abs) {
  return (abs - _mySeat + 4) % 4;
}

function toAbs(local) {
  return (local + _mySeat) % 4;
}

// ---------- サーバー時計の抽象 ----------
// フェーズ1(localモード): Date.now() をそのまま返す（同一マシンなので同一時計）。
// フェーズ2(WSモード): NTP風ping/pongで推定したオフセット（ms）を Date.now() に加算する。
//
// NET.serverNowMs() は「サーバー時刻のミリ秒推定値」を返す。
// game.js 側での変換式: t0Local = audioCtx.currentTime + (msg.t0 - NET.serverNowMs()) / 1000

let _clockOffsetMs = 0;     // serverTime(ms) - performance.now() の推定値
let _minRtt = Infinity;     // 採用した最小RTT（再サンプルで小さい値が出たら更新）
let _resyncTimer = null;    // 定期再同期タイマー

// ローカルモード互換: Date.now() ≒ performance.now() + 時計起点差
// WSモードでは _clockOffsetMs の精度が重要
function serverNowMs() {
  return performance.now() + _clockOffsetMs;
}

// ---------- URLパラメータのパース ----------

function parseOnlineParams() {
  const params = new URLSearchParams(location.search);
  // mode=local → フェーズ1のBroadcastChannelモード（完全後方互換）
  // online=1 / ws=<url> → フェーズ2のWSモード
  const isLocal = params.get("mode") === "local";
  const isOnline = params.has("online") || params.has("ws");
  return {
    online: isLocal || isOnline, // どちらも「オンラインモード」として扱う
    wsMode: isOnline && !isLocal, // true = WSサーバー経由
    room: params.get("room") || "default",
    seat: parseInt(params.get("seat") || "0", 10), // localモード専用
    seed: parseInt(params.get("seed") || "0", 10), // localモード専用
    t0: parseFloat(params.get("t0") || "0"),
    name: params.get("name") || localStorage.getItem("saburo_name") || null,
  };
}

// ---------- ローカルルーム制御（フェーズ1用） ----------
// URLパラメータ: ?online=1&room=X&seat=N&seed=S&t0=T
//
// seat=0 のタブがホスト。以下のフローで2タブを同期させる:
//   1. seat=0 タブ（ホスト）を先に開く。少し待ってから seat=1 タブを開く。
//   2. ホストは自分の audioCtx が起動したら "start" メッセージをブロードキャスト。
//   3. seat=1 タブはそれを受けて同じ t0 で armRound する。
//   4. 以降は BroadcastChannel で "input" をやり取りし人間手番ゲートを動かす。
//
// ホストの t0 計算: audioCtx.currentTime + 2.0（両タブがゲットしてバッファが確保できる程度の余裕）

// ---------- NetClient ----------
// game.js から使う唯一のインターフェース。

const NET = {
  online: false,
  wsMode: false,      // true = WSサーバー経由（フェーズ2）
  connected: false,   // WSモードで joined を受けた後に true
  clockReady: false,  // 最初のpongでサーバー時計のオフセットが取れたら true
  lastPlayers: null,  // 最新の在室者リスト（joined/rosterで更新・待機画面用）

  // オンラインパラメータ
  room: "default",
  mySeat: 0,
  cpuSeed: 0,
  t0Server: 0,

  // 送受信コールバック
  _transport: null,
  _onStartCb: null,
  _onInputCb: null,
  _onReadyCb: null,
  _onResumeCb: null,
  _onLeaveCb: null,
  _onRosterCb: null,  // roster/joined 受信時（待機画面の人数表示用）

  // ready 待ち合わせ（localモード専用）
  readySeats: {},
  departedSeats: {},

  // PRNGインスタンス（cpuSeed で初期化）
  _rng: null,

  // ---------- 初期化。game.js の起動時に呼ぶ ----------
  init: function() {
    const p = parseOnlineParams();
    if (!p.online) {
      this.online = false;
      return;
    }

    this.online = true;
    this.wsMode = p.wsMode;
    this.room = p.room;
    this._playerName = p.name;

    if (p.wsMode) {
      // WSモード: サーバーに接続して joined を待つ
      this._initWs(p);
    } else {
      // localモード（BroadcastChannel）: 従来と完全同一の動作
      this.mySeat = p.seat;
      this.cpuSeed = p.seed;
      setSeat(p.seat);
      this._transport = LocalTransport(p.room);
      this._transport.onMessage(this._handleMessage.bind(this));
    }
  },

  // ---------- WSモードの接続初期化 ----------
  _initWs: function(p) {
    const params = new URLSearchParams(location.search);
    // room と name を QueryString でサーバーへ
    const room = params.get("room") || "saburo";
    const name = encodeURIComponent(this._playerName || "ゲスト");
    const url = SABURO_SERVER + "/saburo/ws?room=" + encodeURIComponent(room) + "&name=" + name;

    this.connected = false;
    this.clockReady = false;
    this.lastPlayers = null;
    this._transport = WsTransport(url);
    this._transport.onMessage(this._handleMessage.bind(this));
    this._transport.onClose(function() {
      NET.connected = false;
      if (NET._onLeaveCb) {
        // 接続断をゲームへ通知（seat=-1 で「サーバー切断」を表す）
        NET._onLeaveCb(-1);
      }
    });
  },

  // WSモード: 接続が閉じていたら張り直す（タイトルへ戻る=退出→再スタートの再入室用）。
  // 「退出したのに同じソケットでreadyを送る幽霊状態」を作らないため、
  // 退出時はソケットを閉じ、スタート時にここで必ず張り直す
  ensureConnected: function() {
    if (!this.wsMode) return;
    const ws = this._transport && this._transport.ws;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    this._initWs();
  },

  // WSモード: 部屋から抜けて接続も閉じる（タイトルへ戻るとき）
  disconnect: function() {
    if (!this.wsMode || !this._transport) return;
    this.sendLeave();
    this._transport.close();
    this._transport = null;
    this.connected = false;
    this.clockReady = false;
    this.lastPlayers = null;
  },

  // ---------- NTP風時計同期（WSモード専用） ----------
  // 接続直後に8回ping、以後10秒ごとに2回ずつ再サンプル。
  // 最小RTTのサンプルだけを採用する（遅延の下限 = 片道最小伝搬遅延）。
  _startClockSync: function() {
    const self = this;
    let pingCount = 0;
    const INITIAL_PINGS = 8;
    const PING_INTERVAL_MS = 50;

    function sendPing() {
      if (!self._transport) return;
      const t = performance.now();
      self._transport.send({ type: "ping", t: t });
    }

    // 初回8発（50ms間隔）
    const initial = setInterval(function() {
      sendPing();
      pingCount++;
      if (pingCount >= INITIAL_PINGS) clearInterval(initial);
    }, PING_INTERVAL_MS);

    // 以後10秒ごとに2発
    _resyncTimer = setInterval(function() {
      sendPing();
      setTimeout(sendPing, PING_INTERVAL_MS);
    }, 10000);
  },

  // pong 受信時の処理（_handleMessage から呼ばれる）
  _handlePong: function(msg) {
    const now = performance.now();
    const rtt = now - msg.t;
    if (rtt < _minRtt) {
      _minRtt = rtt;
      // offsetMs = server - (t + rtt/2) = server - t - rtt/2
      // performance.now() 基準に変換: server - (performance.now() at send time + rtt/2)
      // = msg.server - msg.t - rtt/2 = msg.server - (msg.t + rtt/2)
      _clockOffsetMs = msg.server - (msg.t + rtt / 2);
    }
    // 最初のpongで時計合わせ完了（これが立つまでreadyを送らない=同期前startの防止）
    this.clockReady = true;
  },

  // 外部から呼べるサーバー時刻推定値（ms）
  serverNowMs: function() {
    return serverNowMs();
  },

  // ---------- seededRandom ----------
  rng: function() {
    if (!this._rng) {
      this._rng = makePRNG(this.cpuSeed);
    }
    return this._rng;
  },

  // ---------- 送信API ----------

  // ready 送信（localモード: ホストへ通知 / WSモード: サーバーへ送信）
  sendReady: function(difficulty) {
    if (!this.online || !this._transport) return;
    // WSモード: 時計が合う前にreadyを送るとオフセット0のままstartが来て
    // 開始時刻の変換が破綻する。1秒ごとの再送があるので合うまで黙って待つ
    if (this.wsMode && (!this.connected || !this.clockReady)) return;
    const msg = { type: "ready", difficulty: difficulty || "normal" };
    if (!this.wsMode) msg.seat = this.mySeat; // localモードは seat を付ける
    this._transport.send(msg);
  },

  // ready コールバック登録（cb(seat)）
  onReady: function(cb) {
    this._onReadyCb = cb;
  },

  // localモード専用: ホストが start をブロードキャスト
  broadcastStart: function(t0, cpuSeed, players) {
    if (!this.online || this.wsMode || this.mySeat !== 0) return;
    this.cpuSeed = cpuSeed;
    this._rng = makePRNG(cpuSeed);
    this.readySeats = {};
    const msg = {
      type: "start",
      t0: t0,
      cpuSeed: cpuSeed,
      players: players,
      difficulty: G.difficulty,
    };
    this._transport.send(msg);
    if (this._onStartCb) this._onStartCb(msg);
  },

  // 自分の入力を送る（targets はローカル席配列→絶対席に変換して送信）
  sendInput: function(beat, action, targets, result) {
    if (!this.online) return;
    const absTargets = targets.map(toAbs);
    const msg = {
      type: "input",
      beat: beat,
      action: action,
      targets: absTargets,
      result: result,
    };
    if (!this.wsMode) msg.seat = this.mySeat;
    this._transport.send(msg);
  },

  // start コールバック登録
  onStart: function(cb) {
    this._onStartCb = cb;
  },

  // ミス後の再開リクエスト
  // localモード: t0+actorAbs を自前でブロードキャスト
  // WSモード: resume_req をサーバーへ送る（サーバーが resume を配る）
  sendResume: function(t0, actorAbs) {
    if (!this.online) return;
    if (this.wsMode) {
      this._transport.send({ type: "resume_req" });
    } else {
      const msg = { type: "resume", t0: t0, actor: actorAbs };
      this._transport.send(msg);
      if (this._onResumeCb) this._onResumeCb(msg);
    }
  },

  // resume コールバック登録
  onResume: function(cb) {
    this._onResumeCb = cb;
  },

  // 退出通知
  sendLeave: function() {
    if (!this.online || !this._transport) return;
    const msg = { type: "leave" };
    if (!this.wsMode) msg.seat = this.mySeat;
    this._transport.send(msg);
  },

  // leave コールバック登録（cb(seat)）
  onLeave: function(cb) {
    this._onLeaveCb = cb;
  },

  // 他席の input コールバック登録
  onInput: function(cb) {
    this._onInputCb = cb;
  },

  // roster コールバック登録（cb(players)）: 待機画面の人数表示用
  onRoster: function(cb) {
    this._onRosterCb = cb;
  },

  // ---------- 内部メッセージハンドラ ----------
  _handleMessage: function(msg) {
    if (msg.type === "joined") {
      // WSモード専用: 自分の席番号が確定する
      this.mySeat = msg.seat;
      setSeat(msg.seat);
      this.connected = true;
      if (typeof G !== "undefined") G._wsRetry = 0; // 再接続成功でリトライ計数をリセット
      this.lastPlayers = msg.players || null; // 最新の在室者（待機画面が後から参照する）
      // 時計同期を開始
      this._startClockSync();
      // roster 相当の初期メンバー通知
      if (this._onRosterCb && msg.players) this._onRosterCb(msg.players);
    } else if (msg.type === "roster") {
      this.lastPlayers = msg.players || null;
      if (this._onRosterCb) this._onRosterCb(msg.players);
    } else if (msg.type === "pong") {
      this._handlePong(msg);
    } else if (msg.type === "start") {
      this.t0Server = msg.t0;
      this.cpuSeed = msg.cpuSeed;
      this._rng = makePRNG(msg.cpuSeed);
      this.readySeats = {};
      if (this._onStartCb) this._onStartCb(msg);
    } else if (msg.type === "resume") {
      if (this._onResumeCb) this._onResumeCb(msg);
    } else if (msg.type === "ready") {
      // localモード専用
      if (msg.seat === this.mySeat) return;
      this.readySeats[msg.seat] = Date.now();
      this.departedSeats[msg.seat] = false;
      if (this._onReadyCb) this._onReadyCb(msg.seat);
    } else if (msg.type === "leave") {
      if (!this.wsMode && msg.seat === this.mySeat) return;
      const leavingSeat = msg.seat;
      if (!this.wsMode) {
        this.departedSeats[leavingSeat] = true;
        delete this.readySeats[leavingSeat];
      }
      if (this._onLeaveCb) this._onLeaveCb(leavingSeat);
    } else if (msg.type === "full") {
      console.warn("saburo: 部屋が満員です");
      if (this._onLeaveCb) this._onLeaveCb(-2); // -2 = 満員
    } else if (msg.type === "input") {
      // 自分自身のエコーは無視
      if (msg.seat === this.mySeat) return;
      if (this._onInputCb) {
        const localSeat = toLocal(msg.seat);
        const localTargets = (msg.targets || []).map(toLocal);
        this._onInputCb(msg.beat, localSeat, msg.action, localTargets, msg.result);
      }
    }
  },
};
