import type { ChainDb } from '@eko/db';
import { SanctionsWorker } from '../src/sanctions/service.js';
export const listedWallet = `0x${'d'.repeat(40)}`;
export function sdnFixture(wallet = listedWallet, published = '10/01/2026') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sdnList xmlns="https://example.test/sdn">
<publshInformation><Publish_Date>${published}</Publish_Date><Record_Count>2</Record_Count></publshInformation>
<sdnEntry><uid>1</uid><lastName>Sample entity &amp; fixture</lastName><idList>
<id><uid>10</uid><idType>Digital Currency Address - ETH</idType><idNumber>${wallet}</idNumber></id>
<id><uid>11</uid><idType>Digital Currency Address - ETH</idType><idNumber>${wallet.toUpperCase()}</idNumber></id>
<id><uid>12</uid><idType>Digital Currency Address - XBT</idType><idNumber>neutral-bitcoin-fixture</idNumber></id>
</idList></sdnEntry><sdnEntry><uid>2</uid><lastName>Another sample entity</lastName></sdnEntry>
</sdnList>`;
}
export async function seedSanctions(db: ChainDb) {
  await new SanctionsWorker(db, 'https://ofac.treasury.gov/fixture.xml', async () => sdnFixture()).tick();
}
