// Fills deployments/<chainId>.json with the real tx hashes and the exact deploy block from the forge broadcast
// receipts. Run from contracts/ after `forge script script/Deploy.s.sol ... --broadcast`:
//   node script/record-deployment.mjs <chainId>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const chainId = process.argv[2];
if (!chainId) {
  console.error("usage: node script/record-deployment.mjs <chainId>");
  process.exit(1);
}
const depPath = `deployments/${chainId}.json`;
const runPath = `broadcast/Deploy.s.sol/${chainId}/run-latest.json`;
if (!existsSync(depPath) || !existsSync(runPath)) {
  console.error(`missing ${depPath} or ${runPath}`);
  process.exit(1);
}
const dep = JSON.parse(readFileSync(depPath, "utf8"));
const run = JSON.parse(readFileSync(runPath, "utf8"));

const receipts = new Map((run.receipts ?? []).map((r) => [r.transactionHash.toLowerCase(), r]));
const txs = run.transactions.map((t) => {
  const r = receipts.get(t.hash.toLowerCase());
  return {
    hash: t.hash,
    type: t.transactionType,
    contract: t.contractName ?? null,
    function: t.function ?? null,
    address: t.contractAddress ?? t.transaction?.to ?? null,
    block: r ? Number(BigInt(r.blockNumber)) : null,
    status: r ? Number(BigInt(r.status)) : null,
  };
});
if (txs.some((t) => t.status !== 1)) {
  console.error("some transactions have no successful receipt yet:", txs);
  process.exit(1);
}
const registryTx = txs.find((t) => t.contract === "MerchantRegistry" && t.type === "CREATE");
dep.txs = txs;
if (registryTx?.block != null) dep.deployBlock = registryTx.block;
writeFileSync(depPath, JSON.stringify(dep, null, 2) + "\n");
console.log(`updated ${depPath}: deployBlock=${dep.deployBlock}, ${txs.length} txs`);
