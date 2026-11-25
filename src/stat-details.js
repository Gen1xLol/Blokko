const detailPools = {
  blocks: [
    [
      "Things are getting started up in here!",
      "Hey, it's better than nothing.",
      "Could be better, but for now, this will suffice.",
    ],
    [
      "Pretty cool!",
      "I can see this project going pretty far.",
      "That mouse has been busy!",
    ],
    [
      "Yowza! That's a lotta blocks!",
      "Are you okay? You seem a little overworked.",
      "Very impressive!",
    ],
    [
      "Who hurt you?",
      "That's a lot of blocks. I sure hope you have a good backup.",
      "WHAT could you POSSIBLY be DOING.",
    ],
  ],
  scripts: [
    [
      "Pretty good start!",
      "Things may just be getting started... but this is a good start.",
      "The scripts are starting to take shape (no pun intended)!",
    ],
    [
      "Not too shabby!",
      "Hey, this is a pretty good start to a project.",
      "Just a few more scripts and you'll be ready to go!",
    ],
    [
      "A whole lotta scripts!",
      "The plot thickens...",
      "Wow, you must be really dedicated to this project... or just really bored. Hard to tell.",
    ],
    [
      "They should make an IRS for blocks just for people like you.",
      "I don't even know what you're doing, but I hope it works out for you.",
      "What are you doing with all these scripts? I don't even wanna know.",
    ],
  ],
};

function getRangeIndex(count) {
  if (count < 100) return 0;
  if (count < 1000) return 1;
  if (count < 2000) return 2;
  return 3;
}

function pickFromRandomizedPool(pool) {
  const shuffled = [...pool];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[randomIndex]] = [
      shuffled[randomIndex],
      shuffled[index],
    ];
  }
  return shuffled[0];
}

export function getStatDetail(type, count) {
  const numericCount = Number(count);
  if (!Number.isFinite(numericCount) || numericCount < 0)
    throw new RangeError(`Invalid statistic count: ${count}`);
  const pool = detailPools[type]?.[getRangeIndex(numericCount)];
  if (!pool) throw new RangeError(`unknown statistic detail type - ${type}`);
  return pickFromRandomizedPool(pool);
}

window.detailPools = detailPools;