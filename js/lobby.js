// ============================================================
//  lobby.js  —  account-less auto-matchmaking ("Quick Match").
//
//  The classic decentralized lobby (everyone in one mesh room
//  sorts the waiting set and pairs off) needs a broadcast mesh.
//  We're on PeerJS (Trystero's public signaling is dead — see
//  online.js), and PeerJS is point-to-point with no mesh/room,
//  so we use a tiny coordinator instead:
//
//   - The first player to claim a well-known lobby peer-id
//     ("occ-lobby-vN") becomes the HUB; everyone else gets
//     `unavailable-id` and connects to the hub as a CLIENT.
//   - The hub tracks who's waiting (itself + connected clients),
//     pairs them off, generates a private game code, and tells
//     each pair their code + color. The hub plays too (it's in
//     the queue), so nobody is stuck coordinating forever.
//   - Each matched pair then connects directly P2P via the
//     normal joinOnline() game path; the lobby is torn down.
//   - If the hub leaves, clients re-elect a new hub.
//
//  Fine for a handful of waiters (a Trystero/PeerJS mesh would
//  cap out around dozens anyway). For a bigger queue you'd move
//  presence to a shared store (Supabase/Firebase) — see README.
// ============================================================
import { makeRoomCode } from "./online.js";
import * as peerjs from "https://esm.sh/peerjs@1.5.4";
const Peer = peerjs.Peer || peerjs.default;

const LOBBY_ID = "occ-lobby-v1";

export function findMatch(handlers = {}) {
  const { onStatus, onMatched, onError } = handlers;
  let peer = null, isHub = false, cancelled = false, matched = false;
  const conns = new Map();   // hub: peerId -> DataConnection
  let waiting = [];          // hub: ordered waiting peer ids (hub self at [0])
  let reelectTimer = null;

  const status = (s) => onStatus && onStatus(s);

  function teardown() {
    clearTimeout(reelectTimer);
    try { for (const c of conns.values()) c.close(); } catch {}
    conns.clear();
    try { if (peer) peer.destroy(); } catch {}
    peer = null;
  }
  function finish(code, host) {
    if (matched) return;
    matched = true;
    teardown();
    onMatched && onMatched(code, host);
  }

  // ---- hub ----
  function pairLoop() {
    // Notify all *client* peers in this round first; only defer the hub's own
    // match. If finish() (which tears down the lobby) ran mid-loop, it would
    // close the partner's connection before their match message was delivered.
    let selfMatch = null;
    while (waiting.length >= 2) {
      const a = waiting.shift(), b = waiting.shift();
      const code = makeRoomCode();
      for (const [id, host] of [[a, true], [b, false]]) {
        if (peer && id === peer.id) selfMatch = { code, host };
        else { const c = conns.get(id); if (c && c.open) { try { c.send({ t: "match", code, host }); } catch {} } }
      }
    }
    if (selfMatch) {
      // Let the data channel flush the partner's message before we tear down.
      const sm = selfMatch;
      setTimeout(() => finish(sm.code, sm.host), 500);
      return;
    }
    const others = waiting.includes(peer && peer.id) ? waiting.length - 1 : waiting.length;
    status(others > 0 ? `Waiting for an opponent… (${others} in queue)` : "Waiting for an opponent…");
  }
  function startAsHub() {
    isHub = true;
    waiting = [peer.id];
    status("Waiting for an opponent…");
    peer.on("connection", (c) => {
      c.on("open", () => { if (!waiting.includes(c.peer)) waiting.push(c.peer); conns.set(c.peer, c); pairLoop(); });
      c.on("close", () => { conns.delete(c.peer); waiting = waiting.filter((x) => x !== c.peer); });
      c.on("error", () => {});
    });
  }

  // ---- client ----
  function startAsClient() {
    isHub = false;
    const c = peer.connect(LOBBY_ID, { reliable: true });
    c.on("open", () => status("Waiting for an opponent…"));
    c.on("data", (m) => { if (m && m.t === "match") finish(m.code, !!m.host); });
    c.on("close", () => { if (!matched && !cancelled) reelect(); });
    c.on("error", () => { if (!matched && !cancelled) reelect(); });
  }
  function reelect() {
    clearTimeout(reelectTimer);
    try { if (peer) peer.destroy(); } catch {}
    peer = null;
    reelectTimer = setTimeout(connect, 300 + Math.random() * 900); // jitter avoids a thundering herd
  }

  function connect() {
    if (cancelled || matched) return;
    status("Looking for a game…");
    peer = new Peer(LOBBY_ID);
    peer.on("open", () => startAsHub());
    peer.on("error", (e) => {
      const type = e && e.type;
      if (type === "unavailable-id") {        // someone already hosts the lobby → join it
        try { peer.destroy(); } catch {}
        peer = new Peer();
        peer.on("open", () => startAsClient());
        peer.on("error", (e2) => { if (!matched && !cancelled) reelect(); });
      } else if (!matched && !cancelled) {
        onError && onError(type || String(e));
      }
    });
  }

  connect();
  return { cancel() { cancelled = true; teardown(); } };
}
