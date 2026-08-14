// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {V4Probe,V4Key,V4Swap,IV4Quoter} from "../V4Probe.sol";
interface V4Vm { function deal(address,uint256) external; function etch(address,bytes calldata) external; }
interface Callback { function unlockCallback(bytes calldata) external returns(bytes memory); }
contract V4FixtureToken {
    mapping(address=>uint256) public balanceOf;
    function mint(address a,uint256 n) external {balanceOf[a]+=n;}
    function transfer(address a,uint256 n) external returns(bool) {balanceOf[msg.sender]-=n;balanceOf[a]+=n;return true;}
}
contract V4FixtureHook {
    uint256 public mode;
    uint256 public buys;uint256 public sells;
    constructor(uint256 m){mode=m;}
    function charge(bool buy,uint256 amount) external returns(uint256){
        if(buy)buys++;else sells++;
        require(buy || mode!=3,"sell_block");
        return mode==2?(buy?amount*99/100:amount*90/100):amount;
    }
}
contract V4FixtureManager {
    address private locker;address private currency;uint256 private debt;uint256 private credit;uint256 private synced;
    function unlock(bytes calldata data) external returns(bytes memory out) {
        require(locker==address(0),"locked");locker=msg.sender;
        out=Callback(msg.sender).unlockCallback(data);require(debt==0 && credit==0,"unsettled");locker=address(0);
    }
    function swap(V4Key calldata key,V4Swap calldata params,bytes calldata) external returns(int256) {
        require(msg.sender==locker && params.amountSpecified<0,"swap");
        uint256 n=uint256(-params.amountSpecified);uint256 out=V4FixtureHook(key.hooks).charge(params.zeroForOne,n);
        debt=n;credit=out;currency=key.currency1;
        int128 d0=params.zeroForOne?-int128(int256(n)):int128(int256(out));
        int128 d1=params.zeroForOne?int128(int256(out)):-int128(int256(n));
        return (int256(d0)<<128)|int256(uint256(uint128(d1)));
    }
    function sync(address token) external {require(msg.sender==locker);synced=V4FixtureToken(token).balanceOf(address(this));}
    function settle() external payable returns(uint256 n) {
        require(msg.sender==locker);n=msg.value>0?msg.value:V4FixtureToken(currency).balanceOf(address(this))-synced;
        require(n==debt,"debt");debt=0;
    }
    function take(address token,address to,uint256 amount) external {
        require(msg.sender==locker && amount==credit && debt==0);credit=0;
        if(token==address(0)){(bool ok,)=to.call{value:amount}("");require(ok);}else V4FixtureToken(token).mint(to,amount);
    }
    receive() external payable {}
}
contract V4FixtureQuoter {
    function quoteExactInputSingle(IV4Quoter.Params calldata p) external view returns(uint256,uint256) {
        uint256 mode=V4FixtureHook(p.poolKey.hooks).mode();
        if(mode==1)return(p.exactAmount*110/100,100);
        return(mode==2?(p.zeroForOne?p.exactAmount*99/100:p.exactAmount*90/100):p.exactAmount,100);
    }
}
contract V4ProbeTest {
    V4Vm constant vm=V4Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    struct Result {uint256 tokens;uint256 quoted;uint256 returned;uint256 spent;bool buy;bool sell;bytes err;}
    function run(uint256 mode) private returns(Result memory r) {
        V4Probe p=V4Probe(payable(address(0x7070)));vm.etch(address(p),type(V4Probe).runtimeCode);vm.deal(address(p),2 ether);
        V4FixtureManager m=new V4FixtureManager();vm.deal(address(m),10 ether);
        V4FixtureToken t=new V4FixtureToken();V4FixtureHook h=new V4FixtureHook(mode);V4FixtureQuoter q=new V4FixtureQuoter();
        V4Key memory key=V4Key(address(0),address(t),0,60,address(h));
        bytes memory encoded=abi.encodeCall(p.roundTrip,(address(m),address(q),key,hex"1234",uint128(1 ether)));
        (bool ok,bytes memory out)=address(p).call(encoded);require(ok);
        r=decode(out);
        require(address(p).balance==2 ether-r.spent+r.returned,"balance_delta");
        require(h.buys()==1 && h.sells()==(r.sell?1:0),"hook_called");
        require(t.balanceOf(address(p))==(r.sell?0:r.tokens),"acquired_position");
    }
    function decode(bytes memory out) private pure returns(Result memory r) {
        (r.tokens,r.quoted,r.returned,r.spent,r.buy,r.sell,r.err)=abi.decode(out,(uint256,uint256,uint256,uint256,bool,bool,bytes));
    }
    function testCleanHook() external {Result memory r=run(0);require(r.buy && r.sell && r.tokens==1 ether && r.quoted==1 ether && r.returned==1 ether && r.spent==1 ether);}
    function testQuoteMismatch() external {Result memory r=run(1);require(r.buy && r.sell && r.tokens==1 ether && r.quoted==1.1 ether && r.returned==1 ether);}
    function testAsymmetricFee() external {Result memory r=run(2);require(r.buy && r.sell && r.tokens==0.99 ether && r.quoted==0.891 ether && r.returned==r.quoted);}
    function testSellRestriction() external {Result memory r=run(3);require(r.buy && !r.sell && r.tokens==1 ether && r.spent==1 ether && r.returned==0);}
    function testUnauthorizedCallback() external {V4Probe p=new V4Probe();(bool ok,)=address(p).call(abi.encodeCall(p.unlockCallback,(bytes(""))));require(!ok);}
}
