// ============================================================
//  online.js  —  serverless P2P multiplayer via PeerJS.
//
//  We moved off Trystero: its free public signaling (nostr
//  relays now require auth, torrent/mqtt trackers stopped
//  matching peers) was unreliable and tested-broken. PeerJS
//  uses a maintained public broker cloud — verified to connect
//  two real browsers and exchange data both ways.
//
//  Model: the host registers under the room code as its peer
//  id ("occ-<CODE>"); the joiner connects to it. One reliable
//  DataConnection carries move/chat/meta/ctrl messages, and
//  peer.call() carries WebRTC voice.
// ============================================================
import * as peerjs from "https://esm.sh/peerjs@1.5.4";
const Peer = peerjs.Peer || peerjs.default;

export function makeRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let s = "";
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function joinOnline(code, h = {}, isHost = false) {
  const hostId = "occ-" + code;
  const peer = isHost ? new Peer(hostId) : new Peer();
  let conn = null;
  let localStreamRef = null;
  let connected = false;
  let joinerTries = 0;
  let opponentPeerId = isHost ? null : hostId;

  function wireConn(c) {
    conn = c;
    c.on("open", () => { connected = true; opponentPeerId = c.peer; h.onPeerJoin && h.onPeerJoin(c.peer); });
    c.on("data", (m) => {
      if (!m || !m.t) return;
      if (m.t === "move") h.onMove && h.onMove(m.d);
      else if (m.t === "chat") h.onChat && h.onChat(m.d);
      else if (m.t === "meta") h.onMeta && h.onMeta(m.d);
      else if (m.t === "ctrl") h.onCtrl && h.onCtrl(m.d);
      else if (m.t === "radio") h.onRadio && h.onRadio(m.d);
    });
    c.on("close", () => h.onPeerLeave && h.onPeerLeave(c.peer));
    c.on("error", () => {});
  }

  peer.on("open", () => {
    if (!isHost) wireConn(peer.connect(hostId, { reliable: true }));
  });
  if (isHost) peer.on("connection", (c) => { if (conn) { c.close(); return; } wireConn(c); });

  // Incoming voice call → answer (with our mic if we have one) and surface the stream.
  peer.on("call", (call) => {
    call.answer(localStreamRef || undefined);
    call.on("stream", (s) => h.onStream && h.onStream(s));
  });
  peer.on("error", (e) => {
    const type = e && e.type ? e.type : String(e);
    // Joiner may beat the host to the room — retry a few times before giving up.
    if (!isHost && type === "peer-unavailable" && !connected && joinerTries < 8) {
      joinerTries++;
      setTimeout(() => { if (!connected) wireConn(peer.connect(hostId, { reliable: true })); }, 700);
      return;
    }
    h.onError && h.onError(type);
  });

  const send = (t, d) => { try { if (conn && conn.open) conn.send({ t, d }); } catch (e) { console.warn("send", e); } };

  return {
    isHost,
    get selfId() { return peer.id; },
    get opponentId() { return opponentPeerId; },
    sendMove: (d) => send("move", d),
    sendChat: (d) => send("chat", d),
    sendMeta: (d) => send("meta", d),
    sendCtrl: (d) => send("ctrl", d),
    sendRadio: (d) => send("radio", d),
    addStream: (s) => {
      localStreamRef = s;
      if (opponentPeerId) {
        const call = peer.call(opponentPeerId, s);
        call && call.on("stream", (rs) => h.onStream && h.onStream(rs));
      }
    },
    removeStream: () => { localStreamRef = null; },
    peers: () => (opponentPeerId ? { [opponentPeerId]: 1 } : {}),
    leave: () => { try { if (conn) conn.close(); peer.destroy(); } catch {} },
  };
}
