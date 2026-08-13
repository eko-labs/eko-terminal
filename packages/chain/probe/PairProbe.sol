// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Pair {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

// NEVER DEPLOYED. Runtime is injected only into isolated simulation state.
// BwProbe's round trip for a Pons curve quoted in an ERC-20 (USDG, a stock token, another Pons coin) instead of
// native ETH: the probe holds `pair` (its balance is a state override), buys `token` on `curve` with it and sells
// the tokens back. Spent and returned amounts are the probe's own pair-token balance deltas, in pair-token units.
// The outputs match BwProbe.roundTrip: (tokensOut, quotedBack, pairBack, spent, buyOk, sellOk, err).
contract PairProbe {
    struct Trip { address pair; address token; address curve; uint256 amountIn; bytes buyData; bytes sellData; }

    function roundTrip(Trip calldata trip)
        external returns (uint256 tokensOut, uint256 quotedBack, uint256 pairBack, uint256 spent,
                          bool buyOk, bool sellOk, bytes memory err)
    {
        if (!_approve(trip.pair, trip.curve, trip.amountIn)) return (0, 0, 0, 0, false, false, bytes("pair_approval_failed"));
        uint256 initial = IERC20Pair(trip.pair).balanceOf(address(this));
        (buyOk, err) = trip.curve.call(trip.buyData);
        if (!buyOk) return (0, 0, 0, 0, false, false, err);
        uint256 afterBuy = IERC20Pair(trip.pair).balanceOf(address(this));
        // A buy that credits pair tokens did not execute as modelled: reported as no debit.
        spent = afterBuy < initial ? initial - afterBuy : 0;
        tokensOut = IERC20Pair(trip.token).balanceOf(address(this));
        if (tokensOut == 0) return (0, 0, 0, spent, true, false, bytes("zero_out"));
        if (!_approve(trip.token, trip.curve, tokensOut)) return (tokensOut, 0, 0, spent, true, false, bytes("approval_failed"));
        (sellOk, pairBack, err) = _sell(trip, tokensOut, afterBuy);
    }
    function _sell(Trip calldata trip, uint256 tokensOut, uint256 afterBuy) private returns (bool ok, uint256 back, bytes memory err) {
        (ok, err) = trip.curve.call(_amount(trip.sellData, tokensOut));
        if (ok) {
            uint256 afterSell = IERC20Pair(trip.pair).balanceOf(address(this));
            back = afterSell > afterBuy ? afterSell - afterBuy : 0;
        }
    }
    function _approve(address asset, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory result) = asset.call(abi.encodeCall(IERC20Pair.approve, (spender, amount)));
        return ok && (result.length == 0 || abi.decode(result, (bool)));
    }
    // sell(tokensIn, minQuoteOut, recipient): the acquired amount is written into the first argument word.
    function _amount(bytes calldata data, uint256 amount) private pure returns (bytes memory patched) {
        patched = data;
        require(patched.length >= 36, "invalid_sell");
        assembly { mstore(add(patched, 36), amount) }
    }
}
