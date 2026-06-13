// Standard ELO rating. K=32 means a single game can move you up to ~32 points.
export function eloDelta(myRating, oppRating, won, k = 32) {
  const expected = 1 / (1 + 10 ** ((oppRating - myRating) / 400));
  const actual = won ? 1 : 0;
  return Math.round(k * (actual - expected));
}
