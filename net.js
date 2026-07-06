// net.js — オンライン対戦の通信・座席変換・決定論PRNG
// フェーズ0+1: BroadcastChannel によるローカル2タブ擬似対戦
// フェーズ2以降: WsTransport に差し替えるだけで実対戦に移行できる

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

// ---------- Transport 抽象 ----------
// send(msg: object) / onMessage(cb: function(msg: object)) の2メソッドを持つ。
// フェーズ1: LocalTransport（BroadcastChannel）
// フェーズ2以降: WsTransport（WebSocket）をここに足す

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
// フェーズ1ではローカル時計をそのまま返す（同一マシンなので同一時計）。
// フェーズ2以降はNTP風ping/pongで推定したオフセットを使う。

let _serverOffset = 0; // serverTime - audioCtxTime の推定値

function serverNow() {
  // フェーズ2以降: return audioCtx.currentTime + _serverOffset;
  return typeof audioCtx !== "undefined" && audioCtx
    ? audioCtx.currentTime
    : performance.now() / 1000;
}

function setServerOffset(offset) {
  _serverOffset = offset;
}

// ---------- URLパラメータのパース ----------

function parseOnlineParams() {
  const params = new URLSearchParams(location.search);
  return {
    online: params.has("online"),
    room: params.get("room") || "default",
    seat: parseInt(params.get("seat") || "0", 10),
    seed: parseInt(params.get("seed") || "0", 10),
    t0: parseFloat(params.get("t0") || "0"),
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
  ready: false,

  // オンラインパラメータ
  room: "default",
  mySeat: 0,
  cpuSeed: 0,
  t0Server: 0,        // ホストが決めた開始時刻（壁時計 Date.now() 基準・ms。audioCtxはタブごとに独立時計なので不可）

  // 送受信コールバック
  _transport: null,
  _onStartCb: null,   // start メッセージを受けたときのコールバック(t0を渡す)
  _onInputCb: null,   // 他席のinputを受けたときのコールバック

  // PRNGインスタンス（cpuSeed で初期化）
  _rng: null,

  // 初期化。game.js の起動時に呼ぶ
  init: function() {
    const p = parseOnlineParams();
    if (!p.online) {
      this.online = false;
      return;
    }

    this.online = true;
    this.room = p.room;
    this.mySeat = p.seat;
    this.cpuSeed = p.seed;
    setSeat(p.seat);

    this._transport = LocalTransport(p.room);
    this._transport.onMessage(this._handleMessage.bind(this));

    // seat=0 がホスト: audioCtx 起動後に start をブロードキャスト（game.js 側で呼ぶ）
    // seat != 0 は start メッセージ待ち
  },

  // seededRandom を返す（cpuSeed で初期化済み）。
  // prepareCpu / cpuChooseTargets で呼ぶ。呼び出し順 = 拍の進行と1対1対応している必要がある。
  rng: function() {
    if (!this._rng) {
      this._rng = makePRNG(this.cpuSeed);
    }
    return this._rng;
  },

  // ホストがゲーム開始時刻を決め、全タブにブロードキャストする。
  // game.js の armRound 相当を呼ぶ直前に実行する。
  broadcastStart: function(t0, cpuSeed, players) {
    if (!this.online || this.mySeat !== 0) return;
    const msg = {
      type: "start",
      t0: t0,
      cpuSeed: cpuSeed,
      players: players,
    };
    this._transport.send(msg);
    // ホスト自身も同じ情報で処理する
    if (this._onStartCb) this._onStartCb(msg);
  },

  // 自分の入力を他タブへ送る。
  // beat: 通し拍番号 / action: "point"|"haihai" / targets: ローカル席の配列
  // result: "ok"|"miss"
  sendInput: function(beat, action, targets, result) {
    if (!this.online) return;
    // 送信する targets は絶対席番号（toAbs）に変換する
    const absTargets = targets.map(toAbs);
    const msg = {
      type: "input",
      beat: beat,
      action: action,
      targets: absTargets,
      result: result,
      seat: this.mySeat,
    };
    this._transport.send(msg);
  },

  // start メッセージのコールバックを登録する
  onStart: function(cb) {
    this._onStartCb = cb;
  },

  // 他席のinputメッセージのコールバックを登録する
  // cb(beat, localSeat, action, localTargets, result) の形で呼ばれる
  onInput: function(cb) {
    this._onInputCb = cb;
  },

  // 内部: メッセージハンドラ
  _handleMessage: function(msg) {
    if (msg.type === "start") {
      this.t0Server = msg.t0;
      this.cpuSeed = msg.cpuSeed;
      // PRNGを正しいシードで（再）初期化
      this._rng = makePRNG(msg.cpuSeed);
      if (this._onStartCb) this._onStartCb(msg);
    } else if (msg.type === "input") {
      // 自分自身のエコーは無視
      if (msg.seat === this.mySeat) return;
      if (this._onInputCb) {
        // 絶対席→ローカル席に変換してから渡す
        const localSeat = toLocal(msg.seat);
        const localTargets = msg.targets.map(toLocal);
        this._onInputCb(msg.beat, localSeat, msg.action, localTargets, msg.result);
      }
    }
  },
};
