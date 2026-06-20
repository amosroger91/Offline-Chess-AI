// ============================================================
//  online.js  —  serverless P2P multiplayer via Trystero.
//  Uses the BitTorrent (torrent) strategy: open wss:// trackers
//  with NO auth, unlike the default nostr relays which now
//  require authentication / block anonymous posting. No servers,
//  no sign-up — just a shared room code. Also carries text chat
//  and WebRTC voice (addStream / onPeerStream).
//
//  Pinned to trystero@0.21.2 on esm.sh, which exposes the clean
//  [send, get] tuple API for makeAction.
// ============================================================
import { joinRoom, selfId } from "https://esm.sh/trystero@0.21.2/torrent";

export const mySelfId = selfId;

// Generate a short, shareable, unambiguous room code.
export function makeRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I/O/0/1
  let s = "";
  for (let i = 0; i < 5; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export function joinOnline(roomId, h = {}) {
  const room = joinRoom({ appId: "offline-chess-ai-v1" }, roomId);
  const [sendMove, getMove] = room.makeAction("move");
  const [sendChat, getChat] = room.makeAction("chat");
  const [sendMeta, getMeta] = room.makeAction("meta");
  const [sendCtrl, getCtrl] = room.makeAction("ctrl");

  getMove((d, id) => h.onMove && h.onMove(d, id));
  getChat((d, id) => h.onChat && h.onChat(d, id));
  getMeta((d, id) => h.onMeta && h.onMeta(d, id));
  getCtrl((d, id) => h.onCtrl && h.onCtrl(d, id));
  room.onPeerJoin((id) => h.onPeerJoin && h.onPeerJoin(id));
  room.onPeerLeave((id) => h.onPeerLeave && h.onPeerLeave(id));
  room.onPeerStream((stream, id) => h.onStream && h.onStream(stream, id));

  return {
    selfId,
    sendMove, sendChat, sendMeta, sendCtrl,
    addStream: (s) => { try { room.addStream(s); } catch (e) { console.warn("addStream", e); } },
    removeStream: (s) => { try { room.removeStream(s); } catch {} },
    peers: () => { try { return room.getPeers(); } catch { return {}; } },
    leave: () => { try { room.leave(); } catch {} },
  };
}
