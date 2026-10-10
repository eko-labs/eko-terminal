import { binary, type ChainDb } from '@eko/db';
import { seedReadFixture, sampleAddress } from './read-fixture.js';
/** Engine fixture plus explicit review states; all tokens and identities are neutral samples. */
export async function seedReadReview(db:ChainDb,now=Date.now()) {
 const card=await seedReadFixture(db,now-8*3600000);
 for(let i=0;i<104;i++) {
  const coin=sampleAddress(1000+i),copy=structuredClone(card),id=`review-card:${i}`;
  copy.identity.address=coin;copy.identity.symbol.text='LONGSAMPLESYMBOL';copy.identity.name.text='Sample coin';copy.identity.curvePct=i===0 ? 80 : 20;
  copy.verdict.coin=coin;copy.verdict.level=i>=99 ? 'danger' : 'pending';
  await db.insert('tokens',{address:binary(coin),deployer:binary(sampleAddress(2000+i)),curve:binary(sampleAddress(3000+i)),name:'Sample coin',symbol:'LONGSAMPLESYMBOL',launchpad:'pons',first_block:String(card.verdict.asOfBlock),block:String(card.verdict.asOfBlock),graduated_block:i===1 ? String(card.verdict.asOfBlock) : null});
  await db.sql.query('INSERT INTO coin_cards(id,coin,valid_from_block,hash,data) VALUES($1,$2,$3,$1,$4)',[id,binary(coin),card.verdict.asOfBlock,copy]);
  await db.sql.query('INSERT INTO coin_card_latest VALUES($1,$2,$3,$4)',[binary(coin),id,card.verdict.asOfBlock,copy]);
  await db.sql.query('INSERT INTO verdicts(id,coin,valid_from_block,rules_version,signature,data) VALUES($1,$2,$3,$4,$1,$5)',[id,binary(coin),card.verdict.asOfBlock,'1.0.2',copy.verdict]);
 }
 await db.insert('tokens',{address:binary(sampleAddress(801)),name:'Pool identity',symbol:'POOL',launchpad:'other',graduated_block:String(card.verdict.asOfBlock),first_block:String(card.verdict.asOfBlock),block:String(card.verdict.asOfBlock)});
 return card;
}
