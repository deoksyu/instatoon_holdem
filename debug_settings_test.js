const { io } = require("socket.io-client");
const URL = "http://localhost:3737";
function connect(tag) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ["websocket"] });
    s.on("room:state", (msg) => { s._latestState = msg; });
    s.on("connect_error", (e) => console.log(tag, "connect_error", e.message));
    s.on("connect", () => resolve(s));
  });
}
function emit(sock, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("emit timeout: " + event)), 5000);
    sock.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const host = await connect("host");
  const p2 = await connect("p2");
  const createRes = await emit(host, "room:create", { name: "test", instagramUsername: "" });
  const roomCode = createRes.roomCode;
  const joinRes = await emit(p2, "room:requestJoin", { roomCode, name: "test", instagramUsername: "" });
  await wait(150);
  console.log("host state after join request:", JSON.stringify(host._latestState?.pendingRequests));
  const pendingId = host._latestState.pendingRequests[0]?.socketId;
  const approveRes = await emit(host, "room:approve", { targetId: pendingId });
  console.log("approve result:", JSON.stringify(approveRes));
  await wait(150);
  console.log("host state.players after approve:", JSON.stringify(host._latestState?.state?.players?.map(p => ({id:p.id, chips:p.chips, sittingOut:p.sittingOut}))));
  console.log("isHost:", host._latestState?.isHost);
  try {
    const startRes = await emit(host, "room:start", {});
    console.log("start result:", JSON.stringify(startRes));
  } catch (e) {
    console.log("start ERROR:", e.message);
  }
  host.close(); p2.close();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(1); });
