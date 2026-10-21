import { InputError } from '../http/v1/helpers.js';
export function decodeCursor(cursor:string|undefined,scope:string):unknown[]|undefined {
  if(!cursor)return undefined;
  try {const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(Array.isArray(value)&&value.length===2&&value[0]===scope&&Array.isArray(value[1]))return value[1];}catch {}
  throw new InputError('Invalid cursor');
}
export const encodeCursor=(scope:string,keys:unknown[])=>Buffer.from(JSON.stringify([scope,keys])).toString('base64url');
