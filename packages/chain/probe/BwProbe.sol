// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

// NEVER DEPLOYED. Runtime is injected only into isolated simulation state.
contract BwProbe {
    struct Leg { address target; uint256 value; bytes data; uint256 amountOffset; bool patch; }
    function roundTrip(address token, address spender, Leg calldata buy, Leg calldata quoteSell, Leg calldata sell)
        external returns (uint256 tokensOut, uint256 quotedBack, uint256 ethBack, uint256 spent,
                          bool buyOk, bool sellOk, bytes memory err)
    {
        uint256 initial = address(this).balance;
        (buyOk, err) = buy.target.call{value: buy.value}(buy.data);
        if (!buyOk) return (0, 0, 0, 0, false, false, err);
        spent = initial - address(this).balance;
        tokensOut = IERC20Min(token).balanceOf(address(this));
        if (tokensOut == 0) return (0, 0, 0, spent, true, false, bytes("zero_out"));
        (bool ok, bytes memory approval) = token.call(abi.encodeCall(IERC20Min.approve, (spender, tokensOut)));
        if (!ok || (approval.length != 0 && !abi.decode(approval, (bool))))
            return (tokensOut, 0, 0, spent, true, false, bytes("approval_failed"));
        (bool okQ, bytes memory q) = quoteSell.target.call(_patch(quoteSell, tokensOut));
        if (okQ && q.length >= 32) quotedBack = abi.decode(q, (uint256));
        uint256 beforeSell = address(this).balance;
        (sellOk, err) = sell.target.call(_patch(sell, tokensOut));
        if (sellOk) ethBack = address(this).balance - beforeSell;
    }
    function _patch(Leg calldata leg, uint256 amount) private pure returns (bytes memory data) {
        data = leg.data;
        if (leg.patch) {
            require(leg.amountOffset + 32 <= data.length, "invalid_offset");
            uint256 offset = leg.amountOffset;
            assembly { mstore(add(add(data, 32), offset), amount) }
        }
    }
    // Fixture contract-account path. Calls originate from this account and retain real purchase storage.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value:value}(data);
        if (!ok) assembly { revert(add(result,32), mload(result)) }
    }
    receive() external payable {}
}
