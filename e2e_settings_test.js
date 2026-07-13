const { io } = require("socket.io-client");
const URL = "http://localhost:3737";

function connect() {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ["polling","websocket"] });
    s.on("connect", () => resolve(s));
  });
}
function emit(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}
function once(sock, event) {
  return new Promise((resolve) => sock.once(event, resolve));
}

(async () => {
  const host = await connect();
  const p2 = await connect();

  const createRes = await emit(host, "room:create", { name: "test", instagramUsername: "" });
  if (!createRes.ok) throw new Error("create failed: " + createRes.error);
  const roomCode = createRes.roomCode;
  console.log("room created:", roomCode);

  const joinRes = await emit(p2, "room:requestJoin", { roomCode, name: "test", instagramUsername: "" });
  if (!joinRes.ok) throw new Error("join failed: " + joinRes.error);

  // host approves p2
  let hostState = await once(host, "room:state");
  const pendingId = hostState.pendingRequests[0]?.socketId;
  const approveRes = await emit(host, "room:approve", { targetId: pendingId });
  if (!approveRes.ok) throw new Error("approve failed: " + approveRes.error);

  // non-host tries to save settings -> should fail
  const nonHostSave = await emit(p2, "room:settings:save", { smallBlind: 5, bigBlind: 10, maxRebuys: 1, rebuyAmount: 1000 });
  console.log("non-host save (expect ok:false):", JSON.stringify(nonHostSave));

  // invalid values -> should fail
  const badSave = await emit(host, "room:settings:save", { smallBlind: 100, bigBlind: 50, maxRebuys: 1, rebuyAmount: 1000 });
  console.log("bb<sb save (expect ok:false):", JSON.stringify(badSave));

  // host starts first hand with default blinds (10/20)
  const startRes = await emit(host, "room:start", {});
  if (!startRes.ok) throw new Error("start failed: " + startRes.error);
  let state = await once(host, "room:state");
  console.log("hand 1 blinds:", state.state.smallBlind, state.state.bigBlind, "gameSettings:", JSON.stringify(state.gameSettings));

  // host saves new settings mid-hand -> should be pending, NOT applied yet
  const saveRes = await emit(host, "room:settings:save", { smallBlind: 50, bigBlind: 100, maxRebuys: 3, rebuyAmount: 7500 });
  console.log("valid save result:", JSON.stringify(saveRes));
  state = await once(host, "room:state");
  console.log("after save, still mid-hand, table blinds unchanged:", state.state.smallBlind, state.state.bigBlind);
  console.log("pendingGameSettings visible to host:", JSON.stringify(state.pendingGameSettings));

  // fold through to end the hand (both players act fold/check until hand ends), simplistic: force fold on current player repeatedly
  for (let i = 0; i < 10; i++) {
    if (state.state.street === "waiting" || state.state.street === "showdown") break;
    const actingId = state.state.currentPlayerId;
    const actor = actingId === host.id ? host : p2;
    const actRes = await emit(actor, "room:action", { type: "fold" });
    if (!actRes.ok) { console.log("action failed:", actRes.error); break; }
    state = await once(host, "room:state");
  }
  console.log("street after folding out:", state.state.street);

  // start next hand -> new blinds should now apply
  const nextRes = await emit(host, "room:nextHand", {});
  console.log("nextHand result:", JSON.stringify(nextRes));
  state = await once(host, "room:state");
  console.log("hand 2 blinds (expect 50/100):", state.state.smallBlind, state.state.bigBlind);
  console.log("gameSettings after apply:", JSON.stringify(state.gameSettings));
  console.log("pendingGameSettings after apply (expect null):", JSON.stringify(state.pendingGameSettings));

  host.close();
  p2.close();
  process.exit(0);
})().catch((e) => {
  console.error("TEST ERROR:", e);
  process.exit(1);
});
