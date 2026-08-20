/** Exact v3 TickMath integer ratios (Q64.96, rounding up); custody range binding
 * only. Depth evaluation and scoring remain owned by packet 041. */
export function custodySqrtRatio(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new Error('Invalid position tick');
  const factors = [
    'fffcb933bd6fad37aa2d162d1a594001', 'fff97272373d413259a46990580e213a',
    'fff2e50f5f656932ef12357cf3c7fdcc', 'ffe5caca7e10e4e61c3624eaa0941cd0',
    'ffcb9843d60f6159c9db58835c926644', 'ff973b41fa98c081472e6896dfb254c0',
    'ff2ea16466c96a3843ec78b326b52861', 'fe5dee046a99a2a811c461f1969c3053',
    'fcbe86c7900a88aedcffc83b479aa3a4', 'f987a7253ac413176f2b074cf7815e54',
    'f3392b0822b70005940c7a398e4b70f3', 'e7159475a2c29b7443b29c7fa6e889d9',
    'd097f3bdfd2022b8845ad8f792aa5825', 'a9f746462d870fdf8a65dc1f90e061e5',
    '70d869a156d2a1b890bb3df62baf32f7', '31be135f97d08fd981231505542fcfa6',
    '9aa508b5b7a84e1c677de54f3e99bc9', '5d6af8dedb81196699c329225ee604',
    '2216e584f5fa1ea926041bedfe98', '48a170391f7dc42444e8fa2',
  ];
  let ratio = 1n << 128n;
  for (let i = 0; i < factors.length; i++) {
    if (Math.abs(tick) & (1 << i)) ratio = ratio * BigInt(`0x${factors[i]}`) >> 128n;
  }
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
