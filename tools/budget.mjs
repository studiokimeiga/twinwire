import { estimateEgress } from '../dist/core/budget.js';
const arg=(name,def)=>{const i=process.argv.indexOf(name);return i<0?def:Number(process.argv[i+1]);};
const o={bytesPerSecondPerPlayer:arg('--bytes',12000),averagePlayers:arg('--players',5),activeHours:arg('--hours',100),baseMonthlyUSD:arg('--base',5),includedGB:arg('--included-gb',1000),overageUSDPerGB:arg('--overage',0.01),budgetUSD:arg('--budget',5),overheadFraction:arg('--overhead',0.2)};
console.log(JSON.stringify({assumptions:o,estimate:estimateEgress(o),note:'Enter your actual provider allowance and prices. Defaults are illustrative, not a current Vultr quote. Overhead is an estimate. No automatic billing cap or paid resources are created.'},null,2));
