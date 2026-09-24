/** slot0 is token1 raw units per token0 raw unit; convert to USDG units per ETH. */
export function ethUsdFromSlot0(sqrtPriceX96: bigint, wethIsToken0: boolean, wethDecimals: number, usdgDecimals: number): number {
  if (sqrtPriceX96 <= 0n) throw new Error('Uninitialized ETH/USD pool');
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2;
  const value = (wethIsToken0 ? ratio : 1 / ratio) * 10 ** (wethDecimals - usdgDecimals);
  if (!Number.isFinite(value) || value <= 0) throw new Error('Invalid ETH/USD price');
  return value;
}
export const priceSampleBlock = (n: bigint) => n / 600n * 600n;
