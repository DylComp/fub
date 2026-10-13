import { executorRpcDiagnostic, type ExecutorRpcDiagnostic } from './copy-executor-rpc.js';
import type { Rpc } from './funding.js';

export type NativeBroadcastResult = {
  kind: 'accepted' | 'uncertain';
  diagnostic?: ExecutorRpcDiagnostic;
};

// Call only after fresh signed preflight and a durable, exclusive send claim.
// One RPC call, unchanged bytes, no new signature. Acceptance is not settlement.
// Leave maxRetries unset so the RPC can forward these same bytes until their
// blockhash expires. A short retry count can drop an otherwise valid trade.
export async function broadcastNativeTransaction(
  rpc: Rpc,
  signed: string,
  expectedSignature: string,
  minContextSlot: number,
  signal?: AbortSignal,
): Promise<NativeBroadcastResult> {
  try {
    signal?.throwIfAborted();
    const signature = await rpc('sendTransaction', [signed, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      minContextSlot,
    }]);
    return signature === expectedSignature
      ? { kind: 'accepted' }
      : { kind: 'uncertain', diagnostic: { kind: 'malformed' } };
  } catch (error) {
    return { kind: 'uncertain', diagnostic: executorRpcDiagnostic(error) };
  }
}
