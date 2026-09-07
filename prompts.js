// Minimal terminal prompt kit: arrow-key select, text input, yes/no confirm.
// Hand-rolled so the project stays dependency-free.

const readline = require("readline");

const useColor = process.stdout.isTTY;
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);

const bold = paint("1");
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");

// Cursor control only means something on a terminal; when stdout is piped to a
// file or another process these would show up as literal "[2K" noise.
const ansi = (sequence) => (useColor ? sequence : "");
const CURSOR_HIDE = ansi("\x1b[?25l");
const CURSOR_SHOW = ansi("\x1b[?25h");
const CLEAR_LINE = ansi("\x1b[2K");
const cursorUp = (lines) => ansi(`\x1b[${lines}A`);

function exit(code = 0) {
  process.stdout.write(CURSOR_SHOW);
  process.exit(code);
}

/**
 * Arrow-key list picker. Resolves the chosen choice's `value`, or null if the
 * user backs out with Escape.
 *
 * @param {string} title
 * @param {Array<{label: string, hint?: string, value: any}>} choices
 */
function select(title, choices) {
  return new Promise((resolve) => {
    let index = 0;

    process.stdout.write(
      `\n${bold(title)}\n${dim("  ↑/↓ move · Enter select · Esc back · Ctrl+C quit")}\n\n`
    );

    const draw = (isFirstPass) => {
      // Redraw in place by walking the cursor back over the previous render.
      if (!isFirstPass) process.stdout.write(cursorUp(choices.length));
      choices.forEach((choice, i) => {
        const active = i === index;
        const pointer = active ? cyan("❯") : " ";
        const label = active ? cyan(choice.label) : choice.label;
        const hint = choice.hint ? ` ${dim(choice.hint)}` : "";
        process.stdout.write(`${CLEAR_LINE}${pointer} ${label}${hint}\n`);
      });
    };

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(CURSOR_SHOW);
    };

    const onKeypress = (_str, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.stdout.write("\n");
        exit(0);
      } else if (key.name === "up" || key.name === "k") {
        index = (index - 1 + choices.length) % choices.length;
        draw(false);
      } else if (key.name === "down" || key.name === "j") {
        index = (index + 1) % choices.length;
        draw(false);
      } else if (key.name === "return") {
        cleanup();
        resolve(choices[index].value);
      } else if (key.name === "escape") {
        cleanup();
        resolve(null);
      }
    };

    draw(true);
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(CURSOR_HIDE);
    process.stdin.on("keypress", onKeypress);
  });
}

/**
 * Free-text prompt. Re-asks while `required` and the answer is empty;
 * falls back to `fallback` when the user just hits Enter.
 *
 * @param {string} question
 * @param {{ required?: boolean, fallback?: string }} [options]
 */
function ask(question, options = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      exit(0);
    });

    const request = () => {
      rl.question(`${bold(question)} `, (answer) => {
        const value = answer.trim();
        if (!value) {
          if (options.fallback !== undefined) {
            rl.close();
            return resolve(options.fallback);
          }
          if (options.required) {
            process.stdout.write(dim("  a value is required\n"));
            return request();
          }
        }
        rl.close();
        resolve(value);
      });
    };

    request();
  });
}

/** Yes/no picker. `defaultYes` only controls which row starts highlighted. */
async function confirm(question, defaultYes = false) {
  const choices = [
    { label: "No", value: false },
    { label: "Yes", value: true },
  ];
  if (defaultYes) choices.reverse();
  const answer = await select(question, choices);
  return answer === null ? false : answer;
}

/** Blocks until Enter, so results stay on screen before the menu redraws. */
function pause(message = "Press Enter to return to the menu…") {
  return ask(dim(message));
}

module.exports = { select, ask, confirm, pause, bold, dim, cyan, green, yellow, red, exit };
