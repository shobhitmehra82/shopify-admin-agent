// Drives useSpeech in jsdom with a fake SpeechRecognition, so the fixed window,
// the self-stop and the auto-send are actually exercised rather than reasoned about.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// Node 22 defines `navigator` as a getter-only global, so assignment throws.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Stands in for the browser's recogniser: records what the hook asks of it and
// lets the test fire result/end events on cue.
const instances = [];
class FakeRecognition {
  constructor() {
    this.started = 0;
    this.stopped = 0;
    this.aborted = 0;
    instances.push(this);
  }
  start() {
    this.started++;
  }
  // The real API flushes buffered audio as a final result, then fires onend.
  stop() {
    this.stopped++;
    this.onend?.();
  }
  abort() {
    this.aborted++;
  }
  emitFinal(text) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }
  emitInterim(text) {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal: false })] });
  }
  emitError(error) {
    this.onerror?.({ error });
  }
}
dom.window.SpeechRecognition = FakeRecognition;

const { useSpeech } = await import("../src/useSpeech.js");
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const pass = [];
const fail = [];
const t = (label, cond, detail = "") => (cond ? pass : fail).push(`${label}${detail ? ` — ${detail}` : ""}`);

// --- harness -------------------------------------------------------------
const sent = [];
let hook = null;

function Probe({ seconds }) {
  hook = useSpeech({ seconds, onCommand: (text) => sent.push(text) });
  return null;
}

const root = createRoot(document.getElementById("root"));
await act(async () => {
  root.render(<Probe seconds={3} />);
});

const rec = instances[0];
t("recogniser constructed once", instances.length === 1, `${instances.length}`);
t("continuous, so a pause mid-command doesn't end it", rec.continuous === true);
t("interim results on, for the live readout", rec.interimResults === true);
t("supported in a browser with the API", hook.supported === true);
t("idle remaining equals the window", hook.remaining === 3, `${hook.remaining}`);

// --- a full recording: press, speak, let the window elapse ---------------
await act(async () => {
  hook.toggle();
});
t("start() called on press", rec.started === 1);
t("listening after press", hook.listening === true);
t("does not stop on press", rec.stopped === 0);

await act(async () => {
  rec.emitInterim("show me some");
});
t("interim transcript exposed for the readout", hook.interim === "show me some", hook.interim);
t("nothing sent mid-recording", sent.length === 0);

await act(async () => {
  rec.emitFinal("show me some bracelets");
});
t("still recording after a final result (window not over)", hook.listening === true);
t("still nothing sent", sent.length === 0);

// Let the auto-stop timer fire. 3s window, so 3.2s of real time.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3200));
});
t("window elapsing stops recording with no click", rec.stopped === 1, `stopped ${rec.stopped}×`);
t("listening cleared", hook.listening === false);
t("transcript auto-sent exactly once", sent.length === 1, JSON.stringify(sent));
t("auto-sent the settled text", sent[0] === "show me some bracelets", sent[0]);
t("interim cleared after send", hook.interim === "");
t("no error on a good recording", hook.error === null, String(hook.error));

// --- clipped word: only interim arrived before the window closed ---------
await act(async () => {
  hook.toggle();
});
await act(async () => {
  rec.emitInterim("add two bracelets");
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3200));
});
t("falls back to interim rather than losing the command",
  sent.length === 2 && sent[1] === "add two bracelets", JSON.stringify(sent[1]));

// --- early stop by clicking the button ----------------------------------
await act(async () => {
  hook.toggle();
});
await act(async () => {
  rec.emitFinal("hello");
});
await act(async () => {
  hook.toggle(); // click again = stop now
});
t("clicking mid-window stops immediately", hook.listening === false);
t("early stop still sends", sent.length === 3 && sent[2] === "hello", JSON.stringify(sent[2]));

// The elapsed original timer must not fire a second stop/send.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3200));
});
t("no duplicate send after an early stop", sent.length === 3, `${sent.length} sends`);

// --- silence ------------------------------------------------------------
await act(async () => {
  hook.toggle();
});
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 3200));
});
t("silence sends nothing", sent.length === 3, `${sent.length} sends`);
t("silence explains itself", /Didn't catch that/.test(hook.error || ""), String(hook.error));

// --- denied microphone --------------------------------------------------
await act(async () => {
  hook.toggle();
});
await act(async () => {
  rec.emitError("not-allowed");
});
await act(async () => {
  rec.stop();
});
t("permission error surfaced", /Microphone access denied/.test(hook.error || ""), String(hook.error));
t("permission error not overwritten by the generic one",
  !/Didn't catch that/.test(hook.error || ""));
t("nothing sent when denied", sent.length === 3);

// --- config change ------------------------------------------------------
await act(async () => {
  root.render(<Probe seconds={7} />);
});
t("a new configured window is picked up", hook.remaining === 7 && hook.seconds === 7, `${hook.remaining}`);
t("recogniser not rebuilt on re-render", instances.length === 1, `${instances.length}`);

pass.forEach((p) => console.log("  ok   " + p));
fail.forEach((f) => console.log("  FAIL " + f));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
if (fail.length) process.exit(1);
