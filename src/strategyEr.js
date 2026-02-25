const { ewmMeanAdjustFalseIgnoreNaFalse } = require('./technicalIndicator');

function computeElderRay({ highAdj, lowAdj, closeAdj }, { span = 20 } = {}) {
  if (!Number.isFinite(span) || span <= 0) throw new Error(`span 必须是正数：${span}`);
  if (highAdj.length !== lowAdj.length || highAdj.length !== closeAdj.length) {
    throw new Error('highAdj/lowAdj/closeAdj 长度不一致');
  }

  const emaClose = ewmMeanAdjustFalseIgnoreNaFalse(closeAdj, span);
  const n = closeAdj.length;
  const bullPower = new Array(n).fill(Number.NaN);
  const bearPower = new Array(n).fill(Number.NaN);

  for (let i = 0; i < n; i += 1) {
    const ema = emaClose[i];
    const high = highAdj[i];
    const low = lowAdj[i];
    if (!Number.isFinite(ema) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    bullPower[i] = high - ema;
    bearPower[i] = low - ema;
  }

  return { emaClose, bullPower, bearPower };
}

function computeSignalsErLongOnly({ highAdj, lowAdj, closeAdj }, { span = 20 } = {}) {
  const { bullPower, bearPower } = computeElderRay({ highAdj, lowAdj, closeAdj }, { span });
  const n = closeAdj.length;
  const entry = new Array(n).fill(false);
  const exit = new Array(n).fill(false);

  for (let i = 1; i < n; i += 1) {
    const bearPrev = bearPower[i - 1];
    const bearNow = bearPower[i];
    if (Number.isFinite(bearPrev) && Number.isFinite(bearNow) && bearPrev <= 0 && bearNow > 0) {
      entry[i] = true;
    }

    const bullPrev = bullPower[i - 1];
    const bullNow = bullPower[i];
    if (Number.isFinite(bullPrev) && Number.isFinite(bullNow) && bullPrev >= 0 && bullNow < 0) {
      exit[i] = true;
    }
  }

  return { entry, exit, bullPower, bearPower };
}

module.exports = {
  computeElderRay,
  computeSignalsErLongOnly,
};

