// Amounts are stored in tomans; the SEP gateway and the Moadian system both
// take rials. One constant for both (2026-10): the gateway's factor used to
// be an admin setting while Moadian hardcoded 10, so changing the setting
// charged one amount and declared another.
export const TOMAN_TO_RIAL = 10;

export const tomanToRial = (toman: number) =>
  Math.round((Number(toman) || 0) * TOMAN_TO_RIAL);
