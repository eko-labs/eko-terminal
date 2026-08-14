// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PairProbe} from "../PairProbe.sol";

// Synthetic token-paired curve. Selectors match the Pons curve's buy and sell; prices and charges are fixtures.
contract PairFixtureToken {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address a,uint256 n) external {balanceOf[a]+=n;}
    function approve(address a,uint256 n) external returns(bool){allowance[msg.sender][a]=n;return true;}
    function transfer(address to,uint256 n) external returns(bool){balanceOf[msg.sender]-=n;balanceOf[to]+=n;return true;}
    function transferFrom(address from,address to,uint256 n) external returns(bool){
        require(allowance[from][msg.sender]>=n,"allowance");allowance[from][msg.sender]-=n;balanceOf[from]-=n;balanceOf[to]+=n;return true;
    }
}
contract PairFixtureCurve {
    PairFixtureToken public pair;
    PairFixtureToken public token;
    bool public sellsBlocked;
    bool public buysBlocked;
    constructor(bool blockSells,bool blockBuys) {pair=new PairFixtureToken();token=new PairFixtureToken();sellsBlocked=blockSells;buysBlocked=blockBuys;pair.mint(address(this),1e30);}
    // 1% fee each way, ten tokens per pair unit.
    function buy(uint256 quoteIn,uint256,address to) external payable {
        require(!buysBlocked,"buy_blocked");require(msg.value==0,"UnexpectedNativeValue");
        pair.transferFrom(msg.sender,address(this),quoteIn);token.mint(to,quoteIn*99/100*10);
    }
    function sell(uint256 tokensIn,uint256,address to) external {
        require(!sellsBlocked,"sell_blocked");
        token.transferFrom(msg.sender,address(this),tokensIn);pair.transfer(to,tokensIn/10*99/100);
    }
}
contract PairProbeTest {
    function trip(PairFixtureCurve c,PairProbe p,uint256 amount) private returns(uint256 tokensOut,uint256 back,uint256 spent,bool buyOk,bool sellOk) {
        c.pair().mint(address(p),amount*2);
        PairProbe.Trip memory t=PairProbe.Trip({pair:address(c.pair()),token:address(c.token()),curve:address(c),amountIn:amount,
            buyData:abi.encodeWithSignature("buy(uint256,uint256,address)",amount,0,address(p)),
            sellData:abi.encodeWithSignature("sell(uint256,uint256,address)",0,0,address(p))});
        (tokensOut,,back,spent,buyOk,sellOk,)=p.roundTrip(t);
    }
    function testRoundTripMeasuresPairTokenDebitAndCredit() public {
        (uint256 tokensOut,uint256 back,uint256 spent,bool buyOk,bool sellOk)=trip(new PairFixtureCurve(false,false),new PairProbe(),1e8);
        require(buyOk&&sellOk,"round trip");require(spent==1e8,"spent");require(tokensOut==1e8*99/100*10,"tokens");require(back==9801e4,"back");
    }
    function testBlockedSellIsReportedNotReverted() public {
        (uint256 tokensOut,uint256 back,uint256 spent,bool buyOk,bool sellOk)=trip(new PairFixtureCurve(true,false),new PairProbe(),1e8);
        require(buyOk&&!sellOk,"blocked sell");require(tokensOut>0&&spent==1e8&&back==0,"amounts");
    }
    function testBuyFailureIsOnlyAFailedBuy() public {
        (uint256 tokensOut,uint256 back,uint256 spent,bool buyOk,bool sellOk)=trip(new PairFixtureCurve(false,true),new PairProbe(),1e8);
        require(!buyOk&&!sellOk&&tokensOut==0&&back==0&&spent==0,"failed buy");
    }
}
