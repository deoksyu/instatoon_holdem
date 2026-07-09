const { io } = require("socket.io-client");
const URL = "https://instatoon-holdem.onrender.com";
function mkSocket() { return io(URL, { reconnection: false }); }

async function main() {
  const host = mkSocket();
  const p2 = mkSocket();
  let roomCode, approveReqId;
  const actedTurns = new Set();
  let lastHostInv = null;

  host.on("connect_error", e => console.log("host CE", e.message));
  await new Promise((r) => host.on("connect", r));
  await new Promise((r) => p2.on("connect", r));
  console.log("connected");

  function attach(sock, label) {
    sock.on("room:state", (msg) => {
      if (!msg || !msg.state) return;
      if (msg.pendingRequests && msg.pendingRequests.length && !approveReqId) approveReqId = msg.pendingRequests[0].socketId;
      if (label === "host" && msg.myCardInventory && msg.myCardInventory.length > 0) {
        lastHostInv = msg.myCardInventory;
      }
      const turnKey = `${msg.state.handNumber}-${msg.state.street}-${msg.state.currentPlayerId}-${msg.you}`;
      if (msg.you === msg.state.currentPlayerId && msg.legalActions && msg.legalActions.length && !actedTurns.has(turnKey)) {
        actedTurns.add(turnKey);
        const type = msg.legalActions.includes("check") ? "check" : "call";
        setTimeout(() => sock.emit("room:action", { type }, () => {}), 30);
      }
    });
  }
  attach(host, "host"); attach(p2, "p2");

  host.emit("room:create", { name: "test" }, (res) => { roomCode = res && res.roomCode; console.log("room", roomCode); });
  await new Promise((r) => setTimeout(r, 800));
  p2.emit("room:requestJoin", { roomCode, name: "test" }, () => {});
  await new Promise((r) => setTimeout(r, 800));
  host.emit("room:approve", { targetId: approveReqId }, () => {});
  await new Promise((r) => setTimeout(r, 600));
  host.emit("room:start", () => {});
  await new Promise((r) => setTimeout(r, 8000));

  console.log("lastHostInv (raw):", JSON.stringify(lastHostInv));
  host.close(); p2.close();
  process.exit(0);
}
main().catch((e) => { console.error("THREW:", e); process.exit(1); });
