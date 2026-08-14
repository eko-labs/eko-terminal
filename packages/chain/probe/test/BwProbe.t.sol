// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BwProbe} from "../BwProbe.sol";

interface Vm {
    function deal(address, uint256) external;
    function etch(address,bytes calldata) external;
    function prank(address) external;
    function warp(uint256) external;
}
contract FixtureToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public boughtAt;
    uint256 public mode;
    constructor(uint256 m) { mode=m; }
    function mint(address to,uint256 n) external { balanceOf[to]+=mode==4?n*9/10:n; boughtAt[to]=block.timestamp; }
    function approve(address spender,uint256 n) external returns(bool) { allowance[msg.sender][spender]=n;return true; }
    function spend(address from,uint256 n) external {
        require(mode!=1,"blocked");
        require(mode!=3 || block.timestamp>=boughtAt[from]+3,"cooldown");
        require(mode!=5 || from.code.length==0,"contract");
        require(allowance[from][msg.sender]==n,"allowance");
        balanceOf[from]-=n; allowance[from][msg.sender]=0;
    }
}
contract FixtureRouter {
    struct Params {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 sqrtPriceLimitX96;}
    FixtureToken public token;
    uint256 public payout;
    constructor(FixtureToken t) {token=t;}
    function exactInputSingle(Params calldata p) external payable returns(uint256) {
        if(msg.value>0) {token.mint(p.recipient,msg.value);return msg.value;}
        token.spend(msg.sender,p.amountIn);
        payout=token.mode()==2?p.amountIn/100:p.amountIn*99/100;
        return payout;
    }
    function unwrapWETH9(uint256,address recipient) external payable {uint256 n=payout;payout=0;(bool ok,)=recipient.call{value:n}("");require(ok);}
    function multicall(uint256,bytes[] calldata data) external payable returns(bytes[] memory out) {
        out=new bytes[](data.length);
        for(uint256 i;i<data.length;i++){(bool ok,bytes memory r)=address(this).delegatecall(data[i]);require(ok,string(r));out[i]=r;}
    }
    receive() external payable {}
}
contract FixtureQuoter {
    function quoteExactInputSingle(address,address,uint256 amount,uint24,uint160) external pure returns(uint256) {return amount*99/100;}
}
contract BwProbeTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function fixture(uint256 mode) private returns(BwProbe p,FixtureToken t,FixtureRouter r,FixtureQuoter q) {
        p=BwProbe(payable(address(0x2222)));vm.etch(address(p),type(BwProbe).runtimeCode);t=new FixtureToken(mode);r=new FixtureRouter(t);q=new FixtureQuoter();
        vm.deal(address(p),2 ether);vm.deal(address(r),100 ether);
    }
    function legs(FixtureToken t,FixtureRouter r,FixtureQuoter q,address recipient,uint256 amount) private pure returns(BwProbe.Leg memory buy,BwProbe.Leg memory quote,BwProbe.Leg memory sell) {
        buy=BwProbe.Leg(address(r),amount,abi.encodeCall(r.exactInputSingle,(FixtureRouter.Params(address(0),address(t),3000,recipient,amount,0,0))),0,false);
        quote=BwProbe.Leg(address(q),0,abi.encodeCall(q.quoteExactInputSingle,(address(t),address(0),0,3000,0)),68,true);
        bytes[] memory data=new bytes[](2);
        data[0]=abi.encodeCall(r.exactInputSingle,(FixtureRouter.Params(address(t),address(0),3000,address(2),0,0,0)));
        data[1]=abi.encodeCall(r.unwrapWETH9,(0,recipient));
        sell=BwProbe.Leg(address(r),0,abi.encodeCall(r.multicall,(type(uint256).max,data)),328,true);
    }
    function testCleanBalanceDeltas() external {check(0,true,1 ether,0.99 ether);}
    function testSellReverts() external {check(1,false,1 ether,0);}
    function testNearZeroReturn() external {check(2,true,1 ether,0.01 ether);}
    function testCooldownProbeFails() external {check(3,false,1 ether,0);}
    function testFeeOnTransfer() external {check(4,true,0.9 ether,0.891 ether);}
    function testContractRestricted() external {check(5,false,1 ether,0);}
    function check(uint256 mode,bool expectedSell,uint256 expectedTokens,uint256 expectedReturn) private {
        (BwProbe p,FixtureToken t,FixtureRouter r,FixtureQuoter q)=fixture(mode);
        (BwProbe.Leg memory buy,BwProbe.Leg memory quote,BwProbe.Leg memory sell)=legs(t,r,q,address(p),1 ether);
        uint256 before=address(p).balance;
        (uint256 tokens,,uint256 returned,uint256 spent,bool buyOk,bool sellOk,)=p.roundTrip(address(t),address(r),buy,quote,sell);
        require(buyOk && sellOk==expectedSell && tokens==expectedTokens && returned==expectedReturn && spent==1 ether);
        require(address(p).balance==before-spent+returned,"actual native delta");
    }
    function testEOACooldownPurchasedState() external {
        (,FixtureToken t,FixtureRouter r,FixtureQuoter q)=fixture(3);
        address eoa=address(0x1234);vm.deal(eoa,2 ether);
        (BwProbe.Leg memory buy,,)=legs(t,r,q,eoa,1 ether);
        vm.prank(eoa);(bool ok,)=address(r).call{value:1 ether}(buy.data);require(ok);
        vm.warp(block.timestamp+3);uint256 tokens=t.balanceOf(eoa);vm.prank(eoa);t.approve(address(r),tokens);
        bytes[] memory data=new bytes[](2);
        data[0]=abi.encodeCall(r.exactInputSingle,(FixtureRouter.Params(address(t),address(0),3000,address(2),t.balanceOf(eoa),0,0)));
        data[1]=abi.encodeCall(r.unwrapWETH9,(0,eoa));
        vm.prank(eoa);r.multicall(type(uint256).max,data);
        require(eoa.balance==1.99 ether && t.balanceOf(eoa)==0,"EOA actual deltas");
    }
}
