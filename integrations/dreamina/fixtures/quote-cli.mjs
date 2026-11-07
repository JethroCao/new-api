// Shared documented CLI preparation responses for lifecycle tests. The
// callback owns generation/transport outcomes; quote-specific tests use their
// own CLI so malformed and changing upstream quotes are tested independently.
export function quotedCLI(handler) {
  const saved=new Map();
  const flag=(a,k)=>a.find(v=>v.startsWith('--'+k+'='))?.slice(k.length+3);
  return async args=>{
    const nodeId=flag(args,'node-id');
    if(args[0]==='node' && args[1]==='create' && !args.includes('--run')) {
      saved.set(nodeId,args);
      return {node:{nodeId},mutation:{savedDraftVersion:1}};
    }
    if(args[0]==='node' && args[1]==='quote')return {consumptionSubject:{kind:'personal',userId:'123'},items:[{nodeId,maxCredits:10}],totalMaxCredits:10,draftVersion:1,confirmable:true,confirmationRequired:true};
    if(args[0]==='node' && args[1]==='confirm')return {consumptionSubject:{kind:'personal',userId:'123'},creditConfirmationToken:'fixture-approval',creditCeiling:Number(flag(args,'credit-ceiling')),expiresAt:'2099-01-01T00:00:00Z'};
    const result=await handler(args,saved.get(nodeId));
    if (args[0]==='operation' && result && !Object.hasOwn(result,'operationRef')) return {operationRef:args[2], ...result};
    if(args[0]==='node' && args[1]==='run' && result.submission)return {items:[{nodeId,submitId:flag(args,'submit-id'),...result.submission}]};
    return result;
  };
}
