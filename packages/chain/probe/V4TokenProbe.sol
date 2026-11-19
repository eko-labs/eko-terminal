// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct TKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct TSwap { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface ITManager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(TKey calldata,TSwap calldata,bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address,address,uint256) external;
}
interface ITToken { function balanceOf(address) external view returns (uint256); function transfer(address,uint256) external returns (bool); }
interface ITQuoter {
    struct Params { TKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    function quoteExactInputSingle(Params calldata) external returns (uint256,uint256);
}

// NEVER DEPLOYED. Runtime is injected only into isolated simulation state.
// V4Probe's round trip for a v4 pool quoted in an ERC-20 (a long.xyz pool in a stock token, WETH or USDG) instead of
// native ETH: the probe holds the quote token (its balance is a state override), buys the coin with it through the
// PoolManager and sells the coin back. The coin may be either currency. Spent and returned amounts are the probe's own
// quote-token balance deltas, in quote-token units. Outputs match V4Probe.roundTrip.
contract V4TokenProbe {
    address private manager;
    function roundTrip(address m,address quoter,TKey calldata key,bytes calldata hookData,bool coinIs1,uint128 amount)
        external returns (uint256 tokens,uint256 quotedSell,uint256 returned,uint256 spent,bool buyOk,bool sellOk,bytes memory err)
    {
        require(manager==address(0) && key.currency0!=address(0) && key.currency1!=address(0),"route");
        manager=m;
        uint256 afterBuy;
        (buyOk,err,spent,afterBuy,tokens)=_buy(key,hookData,coinIs1,amount);
        if(!buyOk || tokens==0 || tokens>type(uint128).max) {
            manager=address(0);
            return buyOk ? (tokens,0,0,spent,true,false,bytes("invalid_tokens")) : (0,0,0,0,false,false,err);
        }
        quotedSell=_quote(quoter,key,hookData,coinIs1,tokens);
        (sellOk,err,returned)=_sell(key,hookData,coinIs1,tokens,afterBuy);
        manager=address(0);
    }
    // Quoter gets a separate unlock after the buy, on the acquired-position state.
    function _quote(address quoter,TKey calldata key,bytes calldata hookData,bool coinIs1,uint256 tokens) private returns (uint256 out) {
        try ITQuoter(quoter).quoteExactInputSingle(ITQuoter.Params(key,!coinIs1,uint128(tokens),hookData)) returns(uint256 o,uint256) { out=o; } catch {}
    }
    function _sell(TKey calldata key,bytes calldata hookData,bool coinIs1,uint256 tokens,uint256 afterBuy) private returns (bool ok,bytes memory err,uint256 returned) {
        (ok,err)=manager.call(abi.encodeCall(ITManager.unlock,(abi.encode(key,hookData,!coinIs1,false,tokens))));
        if(ok) { uint256 afterSell=ITToken(coinIs1?key.currency0:key.currency1).balanceOf(address(this)); returned=afterSell>afterBuy?afterSell-afterBuy:0; }
    }
    // Buying the coin swaps quote for coin: zeroForOne when the quote is currency0 (the coin is currency1).
    function _buy(TKey calldata key,bytes calldata hookData,bool coinIs1,uint128 amount)
        private returns (bool ok,bytes memory err,uint256 spent,uint256 afterBuy,uint256 tokens)
    {
        address quote=coinIs1?key.currency0:key.currency1;
        uint256 initial=ITToken(quote).balanceOf(address(this));
        (ok,err)=manager.call(abi.encodeCall(ITManager.unlock,(abi.encode(key,hookData,coinIs1,true,uint256(amount)))));
        if(!ok) return (false,err,0,0,0);
        afterBuy=ITToken(quote).balanceOf(address(this));
        spent=initial>afterBuy?initial-afterBuy:0;
        tokens=ITToken(coinIs1?key.currency1:key.currency0).balanceOf(address(this));
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender==manager && manager!=address(0),"caller");
        (TKey memory key,bytes memory hookData,bool zeroForOne,bool buy,uint256 amount)=abi.decode(data,(TKey,bytes,bool,bool,uint256));
        require(amount>0 && amount<=type(uint128).max,"amount");
        int256 delta=ITManager(manager).swap(key,TSwap(zeroForOne,-int256(amount),zeroForOne?uint160(4295128740):uint160(1461446703485210103287273052203988822378723970341)),hookData);
        int128 d0=int128(delta>>128);int128 d1=int128(delta);
        (int128 dIn,int128 dOut)=zeroForOne?(d0,d1):(d1,d0);
        require(dIn<0 && dOut>0,"direction");
        uint256 debt=uint256(-int256(dIn));
        require(debt<=amount && (buy || debt==amount),"debit");
        (address cIn,address cOut)=zeroForOne?(key.currency0,key.currency1):(key.currency1,key.currency0);
        ITManager(manager).sync(cIn);
        (bool ok,bytes memory r)=cIn.call(abi.encodeCall(ITToken.transfer,(manager,debt)));
        require(ok && (r.length==0 || abi.decode(r,(bool))),"transfer");
        require(ITManager(manager).settle()==debt,"settlement");
        ITManager(manager).take(cOut,address(this),uint256(int256(dOut)));
        return bytes("");
    }
}
