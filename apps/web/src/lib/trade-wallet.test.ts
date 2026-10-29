import { beforeEach, describe, expect, it, vi } from 'vitest';
const spies = vi.hoisted(() => ({ writeContract: vi.fn(), waitForTransactionReceipt: vi.fn() }));
vi.mock('wagmi/actions', () => ({ ...spies, getConnection: vi.fn(), sendTransaction: vi.fn(), signMessage: vi.fn(), switchChain: vi.fn() }));
vi.mock('./wallet', () => ({ wagmiConfig: {} }));
import { approveExactToken } from './trade';
const token = '0x00000000000000000000000000000000000000aa', spender = '0x00000000000000000000000000000000000000bb', account = '0x00000000000000000000000000000000000000cc';
const hash = `0x${'ab'.repeat(32)}`;
beforeEach(() => { vi.clearAllMocks(); spies.writeContract.mockResolvedValue(hash); spies.waitForTransactionReceipt.mockResolvedValue({ status: 'success' }); });
describe('shared wallet exact-approval primitive (wagmi spies)', () => {
  it('pins account and chain, preserves raw bigint precision, and waits for the successful receipt', async () => {
    const check = vi.fn();
    expect(await approveExactToken({ token, spender, amount: '900719925474099312345' }, 4663, account, check)).toBe(hash);
    expect(check).toHaveBeenCalledOnce(); expect(check.mock.invocationCallOrder[0]).toBeLessThan(spies.writeContract.mock.invocationCallOrder[0]);
    expect(spies.writeContract).toHaveBeenCalledWith({}, expect.objectContaining({ address: token, functionName: 'approve', args: [spender, 900719925474099312345n], chainId: 4663, account }));
    expect(spies.waitForTransactionReceipt).toHaveBeenCalledWith({}, { hash, chainId: 4663 });
  });
  it('a changed wallet/admission check prevents opening the wallet', async () => {
    await expect(approveExactToken({ token, spender, amount: '1' }, 4663, account, () => { throw new Error('Wallet changed'); })).rejects.toThrow('Wallet changed');
    expect(spies.writeContract).not.toHaveBeenCalled();
  });
  it('receipt failure does not pretend an approval confirmed', async () => {
    spies.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await expect(approveExactToken({ token, spender, amount: '1' }, 4663, account)).rejects.toThrow('Approval transaction reverted');
  });
});
