const readline = require("readline/promises");

async function ask(question, fallback = "") {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const value = await rl.question(question);
    return value.trim() || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question, fallback = true) {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} (${suffix}) `)).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

module.exports = { ask, confirm };
