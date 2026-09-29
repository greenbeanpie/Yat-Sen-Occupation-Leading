import { generateVapidKeys } from "../src/infra/push";

/** 生成 VAPID 密钥对：publicKey 填 vars，privateKey 填 secret（wrangler secret put VAPID_PRIVATE_KEY）。 */
const keys = await generateVapidKeys();
console.log("VAPID_PUBLIC_KEY (wrangler.jsonc vars 或 .dev.vars):");
console.log(keys.publicKey);
console.log("");
console.log("VAPID_PRIVATE_KEY (wrangler secret put VAPID_PRIVATE_KEY / .dev.vars):");
console.log(keys.privateKey);
