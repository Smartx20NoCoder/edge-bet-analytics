import assert from 'node:assert/strict';
import {isVoidStatus,settleSlip} from '../src/lib/slip-settlement.ts';
import {monthlyPickSummary} from '../src/lib/monthly-pick-summary.ts';
const win={id:'win',ft_status:'FT',is_correct:true,market_odds:2.25};
const award={id:'award',ft_status:'AWARDED',is_correct:null,market_odds:1.785};
const pending={id:'pending',ft_status:null,is_correct:null,market_odds:1.8};
const lose={...win,id:'lose',is_correct:false};
assert.deepEqual(settleSlip([award,win]),{status:'won',voidLegs:1,combinedOdds:2.25,isCorrect:true,payout:2.25,profit:1.25});
assert.equal(settleSlip([award,lose]).profit,-1);
assert.equal(settleSlip([award,pending]).status,'pending');
assert.equal(settleSlip([award,award]).status,'void');assert.equal(settleSlip([award]).payout,1);assert.equal(settleSlip([award]).profit,0);
assert.equal(settleSlip([win,{...win,market_odds:2}]).profit,3.5);
assert.equal(settleSlip([win,lose]).status,'lost');
assert.equal(settleSlip([lose,pending]).status,'lost');
for(const status of ['VOID','VOIDED','POSTPONED','CANCELLED','ABANDONED',-12,-14]){assert.equal(isVoidStatus(status),true);assert.equal(settleSlip([{...award,ft_status:status},win]).combinedOdds,2.25);}
for(const status of [null,'FT','Finished',0,1,-11,-13,'INTERRUPTED','PENDING'])assert.equal(isVoidStatus(status),false);
const locks=[{day:'2026-10-08',single_prediction_id:'win',combo_prediction_id_1:'award',combo_prediction_id_2:'win'},
 {day:'2026-10-07',single_prediction_id:'award',combo_prediction_id_1:'award',combo_prediction_id_2:'award'},
 {day:'2026-10-06',single_prediction_id:'pending',combo_prediction_id_1:'pending',combo_prediction_id_2:'win'}];
const m=monthlyPickSummary(locks,[win,award,pending])[0];
assert.deepEqual([m.singleWin,m.singleVoid,m.singlePending,m.singleProfitLoss],[1,1,1,1.25]);
assert.deepEqual([m.comboWin,m.comboVoid,m.comboPending,m.comboProfitLoss,m.comboWinRate],[1,1,1,1.25,100]);
console.log('One void leg settles at 1.00; all void refunds; missing results stay pending; dashboard and monthly summaries agree.');
