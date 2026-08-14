// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BwProbe} from "../BwProbe.sol";
import {Vm} from "./BwProbe.t.sol";

// Synthetic native curve. These selectors and charges are fixture contracts, not deployed Pons ABI evidence.
contract PonsFixtureToken {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    function mint(address a,uint256 n) external {balanceOf[a]+=n;}
    function approve(address a,uint256 n) external returns(bool){allowance[msg.sender][a]=n;return true;}
    function spend(address a,uint256 n) external {require(allowance[a][msg.sender]==n,"allowance");balanceOf[a]-=n;allowance[a][msg.sender]=0;}
}
contract PonsFixtureCurve {
    PonsFixtureToken public token;
    uint256 public tokens=1000000;
    uint256 public realQuote=100000;
    uint256 public virtualQuote=100000;
    uint256 public reservedTokens=500000;
    uint256 public feeBps;
    uint256 public creatorBps;
    uint256 public temporaryBps;
    uint256 public fixedSell;
    uint256 public cooldown;
    uint256 public entryCap;
    bool public contractRestriction;
    mapping(address=>uint256) public purchasedAt;
    mapping(address=>bool) public exempt;
    address payable public recipient;
    constructor(uint256 fee,uint256 creator,address payable recipient_) {token=new PonsFixtureToken();feeBps=fee;creatorBps=creator;recipient=recipient_;}
    function settings(uint256 temporary,uint256 fixedCost,uint256 delay,uint256 cap,bool contracts) external {temporaryBps=temporary;fixedSell=fixedCost;cooldown=delay;entryCap=cap;contractRestriction=contracts;}
    function setExempt(address a) external {exempt[a]=true;}
    function charge(uint256 gross,bool isBuy,address a) public view returns(uint256) {
        uint256 temporary=isBuy&&!exempt[a]&&block.timestamp<1003?gross*temporaryBps/10000:0;
        uint256 rest=gross-temporary;
        return temporary+rest*feeBps/10000+rest*creatorBps/10000+(isBuy?0:fixedSell);
    }
    function buy(uint256,address to) external payable {
        require(entryCap==0||msg.value<=entryCap,"entry_cap");
        uint256 q=realQuote+virtualQuote;uint256 available=tokens-reservedTokens;
        uint256 required=(available*q+reservedTokens-1)/reservedTokens;
        uint256 gross=msg.value;
        if(gross-charge(gross,true,to)>=required) {
            uint256 low;uint256 high=gross;
            while(low<high){uint256 mid=(low+high)/2;if(mid-charge(mid,true,to)>=required)high=mid;else low=mid+1;}
            gross=low;
        }
        uint256 fee=charge(gross,true,to);uint256 net=gross-fee;
        uint256 amount=net*tokens/(q+net);if(amount>available)amount=available;
        tokens-=amount;realQuote+=net;token.mint(to,amount);purchasedAt[to]=block.timestamp;
        pay(recipient,fee);pay(payable(msg.sender),msg.value-gross);
    }
    function sell(uint256 amount,uint256,address payable to) external {
        require(!contractRestriction||msg.sender.code.length==0,"contract_class");
        require(block.timestamp>=purchasedAt[msg.sender]+cooldown,"cooldown");
        uint256 gross=amount*(realQuote+virtualQuote)/(tokens+amount);
        require(gross<=realQuote,"capacity");token.spend(msg.sender,amount);
        uint256 fee=charge(gross,false,msg.sender);require(fee<=gross,"fixed_cost");
        tokens+=amount;realQuote-=gross;pay(recipient,fee);pay(to,gross-fee);
    }
    function pay(address payable a,uint256 n) private {(bool ok,)=a.call{value:n}("");require(ok,"native payout");}
    receive() external payable {}
}
contract PonsCurveTest {
    Vm constant vm=Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    receive() external payable {}
    function fixture(uint256 fee,uint256 creator) private returns(PonsFixtureCurve c) {
        c=new PonsFixtureCurve(fee,creator,payable(address(0x7777)));vm.deal(address(c),100000);vm.warp(1000);
    }
    function buy(PonsFixtureCurve c,address a,bool contractAccount,uint256 amount) private {
        if(contractAccount)BwProbe(payable(a)).execute(address(c),amount,abi.encodeCall(c.buy,(0,a)));
        else {vm.prank(a);c.buy{value:amount}(0,a);}
    }
    function sell(PonsFixtureCurve c,address a,bool contractAccount) private returns(bool ok) {
        PonsFixtureToken t=c.token();uint256 n=t.balanceOf(a);
        if(contractAccount) {
            BwProbe p=BwProbe(payable(a));p.execute(address(c.token()),0,abi.encodeCall(c.token().approve,(address(c),n)));
            (ok,)=address(p).call(abi.encodeCall(p.execute,(address(c),0,abi.encodeCall(c.sell,(n,0,payable(a))))));
        }else {
            vm.prank(a);t.approve(address(c),n);
            vm.prank(a);(ok,)=address(c).call(abi.encodeCall(c.sell,(n,0,payable(a))));
        }
    }
    function roundTrip(uint256 amount,uint256 fee,uint256 creator,bool contractAccount) private returns(uint256 spent,uint256 returned) {
        PonsFixtureCurve c=fixture(fee,creator);address a=contractAccount?address(0x2222):address(0x1234);
        if(contractAccount)vm.etch(a,type(BwProbe).runtimeCode);vm.deal(a,2000000);
        uint256 before=a.balance;uint256 beforeRecipient=address(0x7777).balance;
        buy(c,a,contractAccount,amount);spent=before-a.balance;
        require(spent==(c.realQuote()-100000)+(address(0x7777).balance-beforeRecipient),"buy conservation");
        uint256 reserve=c.realQuote();uint256 n=c.token().balanceOf(a);uint256 independent=n*(c.realQuote()+c.virtualQuote())/(c.tokens()+n);
        before=a.balance;beforeRecipient=address(0x7777).balance;
        require(sell(c,a,contractAccount));returned=a.balance-before;
        require(reserve-c.realQuote()==independent,"post-buy independent denominator");
        require(independent==returned+address(0x7777).balance-beforeRecipient,"sell conservation");
        require(c.token().balanceOf(a)==0 && c.token().allowance(a,address(c))==0,"actual token deltas");
    }
    function testEOA100() external {matched(false,1000);}
    function testEOA1000() external {matched(false,10000);}
    function testContract100() external {matched(true,1000);}
    function testContract1000() external {matched(true,10000);}
    function matched(bool contractAccount,uint256 amount) private {
        // 30 diverse synthetic cases per size/class. Exact integer expectations come from the TS kernel.
        uint256[30] memory expected=expectedReturns(amount);
        for(uint256 i;i<30;i++) {
            (uint256 spent,uint256 returned)=roundTrip(amount,25+i*7,50+i*11,contractAccount);
            require(spent==amount,"matched debit");require(returned==expected[i],"matched TS proceeds");
        }
    }
    function expectedReturns(uint256 amount) private pure returns(uint256[30] memory) {
        // Filled by the checked-in offline generator below; these are fixture expectations, never real fork evidence.
        if(amount==1000) return [uint256(986),981,979,975,971,968,965,961,958,955,950,947,944,940,937,933,930,927,923,920,916,912,909,906,902,899,896,892,889,886];
        return [uint256(9851),9815,9779,9744,9708,9672,9638,9602,9567,9532,9497,9461,9427,9391,9357,9322,9287,9253,9218,9183,9149,9114,9080,9046,9011,8978,8944,8910,8875,8842];
    }
    function testRefundUsesActualQ() external {
        (uint256 spent,)=roundTrip(1000000,100,400,true);require(spent<1000000 && spent>200000,"partial refund");
    }
    function testExemptLeakageAndTemporaryCost() external {
        PonsFixtureCurve c=fixture(100,400);c.settings(9900,0,0,0,false);
        address privileged=address(0x3456);address ordinary=address(0x1234);c.setExempt(privileged);vm.deal(privileged,10000);vm.deal(ordinary,10000);
        buy(c,ordinary,false,1000);uint256 small=c.token().balanceOf(ordinary);
        PonsFixtureCurve d=fixture(100,400);d.settings(9900,0,0,0,false);d.setExempt(privileged);buy(d,privileged,false,1000);
        require(d.token().balanceOf(privileged)>small*50,"recipient exemption difference");
        vm.warp(1003);PonsFixtureCurve e=fixture(100,400);e.settings(9900,0,0,0,false);vm.warp(1003);buy(e,ordinary,false,1000);require(e.token().balanceOf(ordinary)>small*50,"verified decay condition");
    }
    function testFixedSevereCostIsExecutable() external {
        PonsFixtureCurve c=fixture(100,400);c.settings(0,900,0,0,false);address a=address(0x1234);vm.deal(a,10000);buy(c,a,false,1000);uint256 before=a.balance;
        require(sell(c,a,false));require(a.balance-before<100,"fixed cost >90 percent");
    }
    function testPurchasedCooldownAndClassRestriction() external {
        PonsFixtureCurve c=fixture(100,400);c.settings(0,0,3,0,false);address a=address(0x2222);vm.etch(a,type(BwProbe).runtimeCode);vm.deal(a,10000);
        buy(c,a,true,1000);require(!sell(c,a,true),"first scheduled failure retained");vm.warp(1003);require(sell(c,a,true),"retained purchased storage permits delayed sell");
        PonsFixtureCurve d=fixture(100,400);d.settings(0,0,0,0,true);buy(d,a,true,1000);require(!sell(d,a,true),"contract restriction");
        address eoa=address(0x1234);vm.deal(eoa,10000);buy(d,eoa,false,1000);require(sell(d,eoa,false),"EOA cannot certify contract");
    }
    function testSellOnlyRealHolding() external {
        PonsFixtureCurve c=fixture(100,400);address a=address(0x1234);vm.deal(a,10000);buy(c,a,false,1000);uint256 held=c.token().balanceOf(a);
        uint256 before=a.balance;require(sell(c,a,false));require(a.balance>before && held>0,"held sell deltas");
    }
}
