import { decodeFunctionData, parseAbi, type Hex } from 'viem';
const abi=parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])',
  'function multicall(bytes[] data) payable returns (bytes[])',
]);
/** Unsupported layouts remain missing, rather than selector equality masquerading as a full shape. */
export function calldataShape(input:string|null,sec:number):{selector:string|null;shape:string|null} {
  if(!input||!/^0x[0-9a-f]*$/i.test(input)||input.length<10)return {selector:null,shape:null};
  const selector=input.slice(0,10).toLowerCase();
  try {
    let nodes=0;
    const visit=(data:Hex,depth:number):unknown=>{
      if(depth>4||++nodes>100)throw new Error('Calldata nesting exceeds bound');
      const decoded=decodeFunctionData({abi,data});
      if(decoded.functionName==='multicall') {
        const deadline=typeof decoded.args[0]==='bigint'?decoded.args[0]:null;
        const calls=decoded.args.at(-1) as readonly Hex[];
        return [data.slice(0,10),deadline===null?null:(deadline>=BigInt(sec)?(deadline-BigInt(sec))/60n:(deadline-BigInt(sec)-59n)/60n).toString(),calls.map(c=>visit(c,depth+1))];
      }
      return [data.slice(0,10),decoded.args[0].amountOutMinimum===0n];
    };
    return {selector,shape:JSON.stringify(visit(input as Hex,0))};
  } catch {return {selector,shape:null};}
}
