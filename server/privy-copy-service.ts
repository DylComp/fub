import {recoverNativeExpiry} from './native-expiry-recovery.js';
import type {NativePilotPolicy} from './native-pilot-policy.js';
import {recoverUnsignedSigning} from './unsigned-signing-recovery.js';
import {directExitService} from './direct-exit-service.js';
import {nativeSignatureRecovery} from "./native-signature-recovery.js";
import {isolatedNativeInventory,recoverNativeInventory} from "./isolated-native-inventory.js";
import { createPrivateKey, createPublicKey } from "node:crypto";
import type { Rpc } from "./funding.js";
import { privyAccessVerifier, privyOwnershipReader, type SignerPolicy } from "./privy-owner.js";
import { signerEnrollmentStore } from "./signer-enrollment-store.js";
import { signerEnrollment } from "./signer-enrollment.js";
import { signerEnrollmentApi } from "./signer-enrollment-api.js";
import { isolatedCopySigner } from "./isolated-copy-signer.js";
import { isolatedCopyInventory } from "./isolated-copy-inventory.js";
import { recoverIsolatedInventory } from "./isolated-inventory-recovery.js";
import { isolatedPositionCorrections, inventoryOwnerApi } from "./isolated-inventory-corrections.js";
import { isolatedNativeSigner } from "./isolated-native-signer.js";
import { privySignOnly } from "./privy-sign-only.js";

// Construct inside the isolated signer host. No caller-supplied wallet resolver,
// user DID or provider wallet ID is accepted on the trading request path.
export function privyCopyService(config: {
  nativePilot?: NativePilotPolicy;
  appId: string; appSecret: string; authorizationPrivateKey: string;
  origin: string; policy: SignerPolicy;
  directExits?:{pilot?:import('./direct-exit-pilot.js').DirectExitPilot;apiKey:string;enabled:()=>boolean;buyEnabled?:(wallet:string)=>boolean;allows:(wallet:string)=>boolean};
  applicationReadUrl: string; privateBudgetUrl: string; rpc: Rpc; expiryRpc?: (signal:AbortSignal)=>Rpc; blockRpc?: (signal: AbortSignal) => Rpc;
}) {
  try {
    const key = createPrivateKey({ key: Buffer.from(config.authorizationPrivateKey.replace(/^wallet-auth:/, ""), "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
        createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64") !== config.policy.publicKey) throw Error();
  } catch { throw Error("Signing key does not match the enrolled provider signer."); }
  const authenticate=privyAccessVerifier(config.appId), ownership=privyOwnershipReader(config);
  const owner = signerEnrollment({ appId: config.appId, origin: config.origin, policy: config.policy,
    store: signerEnrollmentStore(config.privateBudgetUrl), authenticate, ownership,
  });
  const sign = isolatedCopySigner({ applicationReadUrl: config.applicationReadUrl, privateBudgetUrl: config.privateBudgetUrl,
    rpc: config.rpc, resolveWallet: owner.resolve, provider: privySignOnly(config),
  });
  const signNative = isolatedNativeSigner({ pilot: config.nativePilot, applicationReadUrl: config.applicationReadUrl, privateBudgetUrl: config.privateBudgetUrl, rpc: config.rpc, resolveWallet: owner.resolve, provider: privySignOnly(config) });
  const exits=config.directExits?directExitService({pilot:config.directExits.pilot,origin:config.origin,databaseUrl:config.privateBudgetUrl,apiKey:config.directExits.apiKey,
    rpc:config.rpc,blockRpc:config.blockRpc,enabled:config.directExits.enabled,buyEnabled:config.directExits.buyEnabled,allows:config.directExits.allows,owner,authenticate,ownership,provider:privySignOnly(config)}):undefined;
  const positions=isolatedPositionCorrections(config.privateBudgetUrl,config.rpc);
  return { recoverExpired: (signal:AbortSignal)=>config.expiryRpc ? recoverNativeExpiry(config.privateBudgetUrl,config.expiryRpc(signal),signal) : Promise.resolve({outcome:'idle' as const}), enrollment: signerEnrollmentApi(config.origin, owner, inventoryOwnerApi({authenticate,ownership,positions}),exits?.orders), exits, sign, signNative, recoverNative: nativeSignatureRecovery(config),
    recover: async (signal: AbortSignal) => {
      const unsigned=await recoverUnsignedSigning(config.privateBudgetUrl,signal);
      const [standard,native,direct]=await Promise.all([
        recoverIsolatedInventory(isolatedCopyInventory(config.privateBudgetUrl), config.rpc, signal, undefined, config.blockRpc ? () => config.blockRpc!(signal) : undefined),
        recoverNativeInventory(isolatedNativeInventory(config.privateBudgetUrl),config.rpc,signal,undefined,config.blockRpc ? () => config.blockRpc!(signal) : undefined),
        exits?exits.recover(signal):Promise.resolve({checked:0,settled:0,expired:0,pending:0,refused:0}),
      ]);
      return {checked:standard.checked+native.checked+direct.checked,settled:standard.settled+native.settled+direct.settled,expired:direct.expired+unsigned.expired,pending:standard.pending+native.pending+direct.pending,refused:standard.refused+native.refused+direct.refused};
    },
  };
}
