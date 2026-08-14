// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

struct V4Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
struct V4Swap { bool zeroForOne; int256 amountSpecified; uint160 sqrtPriceLimitX96; }
interface IV4Manager {
    function unlock(bytes calldata) external returns (bytes memory);
    function swap(V4Key calldata,V4Swap calldata,bytes calldata) external returns (int256);
    function sync(address) external;
    function settle() external payable returns (uint256);
    function take(address,address,uint256) external;
}
interface IV4Token { function balanceOf(address) external view returns (uint256); function transfer(address,uint256) external returns (bool); }
interface IV4Quoter {
    struct Params { V4Key poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }
    function quoteExactInputSingle(Params calldata) external returns (uint256,uint256);
}

// NEVER DEPLOYED. Only the native-ETH/token route is supported. No token storage overrides.
contract V4Probe {
    address private manager;
    function roundTrip(address m,address quoter,V4Key calldata key,bytes calldata hookData,uint128 amount)
        external returns (uint256 tokens,uint256 quotedSell,uint256 returned,uint256 spent,bool buyOk,bool sellOk,bytes memory err)
    {
        require(manager==address(0) && key.currency0==address(0) && key.currency1!=address(0),"route");
        manager=m;
        uint256 initial=address(this).balance;
        (buyOk,err)=m.call(abi.encodeCall(IV4Manager.unlock,(abi.encode(key,hookData,true,uint256(amount)))));
        if(!buyOk) { manager=address(0);return(0,0,0,0,false,false,err); }
        spent=initial-address(this).balance;
        tokens=IV4Token(key.currency1).balanceOf(address(this));
        if(tokens==0 || tokens>type(uint128).max) { manager=address(0);return(tokens,0,0,spent,true,false,bytes("invalid_tokens")); }
        // Quoter gets a separate unlock after the buy, on the acquired-position state.
        try IV4Quoter(quoter).quoteExactInputSingle(IV4Quoter.Params(key,false,uint128(tokens),hookData)) returns(uint256 out,uint256) { quotedSell=out; } catch {}
        uint256 beforeSell=address(this).balance;
        (sellOk,err)=m.call(abi.encodeCall(IV4Manager.unlock,(abi.encode(key,hookData,false,tokens))));
        if(sellOk) returned=address(this).balance-beforeSell;
        manager=address(0);
    }
    function unlockCallback(bytes calldata data) external returns(bytes memory) {
        require(msg.sender==manager && manager!=address(0),"caller");
        (V4Key memory key,bytes memory hookData,bool buy,uint256 amount)=abi.decode(data,(V4Key,bytes,bool,uint256));
        require(amount>0 && amount<=type(uint128).max,"amount");
        int256 delta=IV4Manager(manager).swap(key,V4Swap(buy,-int256(amount),buy?uint160(4295128740):uint160(1461446703485210103287273052203988822378723970341)),hookData);
        int128 d0=int128(delta>>128);int128 d1=int128(delta);
        require(buy ? d0<0 && d1>0 : d0>0 && d1<0,"direction");
        uint256 debt=uint256(-int256(buy?d0:d1));
        require(debt<=amount && (buy || debt==amount),"debit");
        if(buy) require(IV4Manager(manager).settle{value:debt}()==debt,"settlement");
        else {
            IV4Manager(manager).sync(key.currency1);
            (bool ok,bytes memory r)=key.currency1.call(abi.encodeCall(IV4Token.transfer,(manager,debt)));
            require(ok && (r.length==0 || abi.decode(r,(bool))),"transfer");
            require(IV4Manager(manager).settle()==debt,"settlement");
        }
        IV4Manager(manager).take(buy?key.currency1:address(0),address(this),uint256(int256(buy?d1:d0)));
        return bytes("");
    }
    receive() external payable {}
}
